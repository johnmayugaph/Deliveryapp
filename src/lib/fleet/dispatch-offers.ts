import {
  DispatchOfferStatus,
  LoyaltyEntryType,
  NotificationKind,
  OrderStatus,
  type DispatchOffer,
  type Order,
  type Service,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { getService } from '@/lib/services/registry';
import { findDispatchCandidates } from '@/lib/fleet/dispatch';
import {
  acceptanceRateForRanking,
  CLOSED_OFFER_STATUSES,
  OFFER_FANOUT,
  OFFER_TTL_SECONDS,
  earningsParts,
  partnerEarningsCentavos,
  REFANOUT_AFTER_SECONDS,
} from '@/lib/fleet/offer-policy';
import { getProgramme, getTiersWithBenefits } from '@/lib/loyalty/programme';
import { tierFor, tierWindowStart } from '@/lib/loyalty/policy';
import {
  dispatchPriorityFor,
  effectiveQueueTime,
} from '@/lib/loyalty/tier-benefits';

/**
 * The dispatch loop.
 *
 * There is no background worker, so this is driven by the same cron entry as
 * the order-timeout sweep (`npm run jobs:orders`). That is a deliberate
 * simplification and a documented one: dispatch latency is bounded by how often
 * the cron runs, and the twenty-minute `AWAITING_RIDER_ASSIGNMENT` timeout is
 * generous enough to absorb it. A real queue is the upgrade path.
 *
 * Nothing here knows what food is. Which orders need a partner comes from
 * `Service.requiresRider`, and which partners may be offered one comes from
 * `FleetPartner.enabledServices` — both read by `findDispatchCandidates`.
 */

export interface FanOutResult {
  orderId: string;
  orderNumber: string;
  offersCreated: number;
  /** No approved, online partner was in range. */
  noCandidates: boolean;
}

/**
 * Offers waiting orders to their best candidates.
 *
 * Skips an order that already has live offers younger than
 * `REFANOUT_AFTER_SECONDS`, so a cron running every minute does not stack
 * batches. Partners who already declined, or whose offer lapsed, are not asked
 * again for the same order — re-offering the same job to the same person is how
 * an acceptance rate gets quietly destroyed.
 *
 * ### The order they are worked in, and the loyalty perk that changes it
 *
 * Oldest first, always — with one adjustment. A customer whose loyalty tier
 * confers DISPATCH_PRIORITY has their order treated as if it were placed a few
 * minutes earlier than it was, so it is offered ahead of things placed inside
 * that window and BEHIND anything older.
 *
 * That shape is the whole point. A boolean that sorted every suki above every
 * stranger would mean, on a busy Friday, an order that is never offered at all
 * while loyal customers keep arriving — and nobody would see it happen,
 * because the starved order looks exactly like an order waiting for a rider.
 * A few minutes of apparent age cannot do that: a stranger who has waited
 * longer than the window still goes first, and the window is capped at
 * `MAX_TIER_PRIORITY_WEIGHT` in the pure policy and again in SQL.
 *
 * It only bites when riders are scarce, which is the only time it is worth
 * anything: with a rider free for every order, everybody is offered on the
 * same sweep and the ordering changes nothing.
 */
export async function fanOutDispatchOffers(
  options: { now?: Date; maxOrders?: number } = {},
): Promise<FanOutResult[]> {
  const now = options.now ?? new Date();
  const results: FanOutResult[] = [];

  // A wider slice than we will work, then re-sorted by effective age: taking
  // 50 by `placedAt` and re-sorting them would let a priority order sitting at
  // position 51 stay invisible however long it waited.
  const take = options.maxOrders ?? 50;
  const candidateOrders = await prisma.order.findMany({
    where: { status: OrderStatus.AWAITING_RIDER_ASSIGNMENT, assignedRiderId: null },
    orderBy: { placedAt: 'asc' },
    take: take * 2,
    include: {
      addresses: { where: { role: 'PICKUP' } },
      dispatchOffers: true,
    },
  });

  const boostByCustomer = await dispatchBoostsFor(
    candidateOrders.map((order) => order.customerId),
    now,
  );

  const effectiveAge = (order: (typeof candidateOrders)[number]): number =>
    effectiveQueueTime(
      order.placedAt ?? order.createdAt,
      boostByCustomer.get(order.customerId) ?? 0,
    );

  const waiting = [...candidateOrders]
    .sort((a, b) => effectiveAge(a) - effectiveAge(b))
    .slice(0, take);

  for (const order of waiting) {
    const pickup = order.addresses[0];
    if (!pickup) {
      // Every order has a pickup snapshot; one without is a data problem, not
      // something to dispatch on a guess.
      continue;
    }

    const liveOffers = order.dispatchOffers.filter(
      (offer) =>
        offer.status === DispatchOfferStatus.PENDING && offer.expiresAt.getTime() > now.getTime(),
    );
    const newestOfferAt = Math.max(
      0,
      ...order.dispatchOffers.map((offer) => offer.offeredAt.getTime()),
    );
    const recentlyFanned = now.getTime() - newestOfferAt < REFANOUT_AFTER_SECONDS * 1000;

    if (liveOffers.length >= OFFER_FANOUT || (liveOffers.length > 0 && recentlyFanned)) {
      continue;
    }

    const alreadyAsked = new Set(order.dispatchOffers.map((offer) => offer.fleetPartnerId));

    const candidates = await findDispatchCandidates({
      serviceType: order.serviceType,
      pickupLatitude: pickup.latitude,
      pickupLongitude: pickup.longitude,
      limit: OFFER_FANOUT + alreadyAsked.size,
      excludePartnerIds: [...alreadyAsked],
    });

    const fresh = candidates.slice(0, OFFER_FANOUT - liveOffers.length);
    if (fresh.length === 0) {
      results.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        offersCreated: 0,
        noCandidates: true,
      });
      continue;
    }

    const service = await getService(order.serviceType);
    const expiresAt = new Date(now.getTime() + OFFER_TTL_SECONDS * 1000);
    await prisma.dispatchOffer.createMany({
      data: fresh.map((candidate, index) => ({
        orderId: order.id,
        fleetPartnerId: candidate.partner.id,
        rank: liveOffers.length + index + 1,
        distanceMeters: Math.round(candidate.distanceMeters),
        offeredAt: now,
        expiresAt,
      })),
      // A partner asked twice in one race is a unique violation, not a failure
      // worth aborting the whole sweep for.
      skipDuplicates: true,
    });

    // Tell the partners. An offer lives 60 seconds, so this is the one message
    // in the app where arriving late is the same as not arriving: it goes out
    // as OPERATIONAL, which means SMS by default and no quiet hours.
    for (const candidate of fresh) {
      await enqueueNotification({
        userId: candidate.partner.userId,
        kind: NotificationKind.DISPATCH_OFFER,
        relatedOrderId: order.id,
        href: '/fleet',
        context: {
          serviceName: service.displayName,
          orderNumber: order.orderNumber,
          storeName: pickup.label ?? undefined,
          earningsCentavos: partnerEarningsCentavos(order),
          secondsToAnswer: OFFER_TTL_SECONDS,
          distanceLabel: `${(candidate.distanceMeters / 1000).toFixed(1)} km`,
        },
        // One message per partner per round of offers on this order: a
        // re-fan-out 20 seconds later is a new offer and worth saying so.
        dedupeKey: `dispatch-offer:${order.id}:${candidate.partner.id}:${expiresAt.getTime()}`,
        now,
      });
    }

    results.push({
      orderId: order.id,
      orderNumber: order.orderNumber,
      offersCreated: fresh.length,
      noCandidates: false,
    });
  }

  return results;
}

/**
 * Closes offers whose window has passed.
 *
 * An expired offer counts against acceptance rate — ignoring your phone while
 * online is a choice — so every affected partner's rate is recomputed.
 */
export async function expireDispatchOffers(now: Date = new Date()): Promise<number> {
  const lapsed = await prisma.dispatchOffer.findMany({
    where: { status: DispatchOfferStatus.PENDING, expiresAt: { lte: now } },
    select: { id: true, fleetPartnerId: true },
  });
  if (lapsed.length === 0) {
    return 0;
  }

  await prisma.dispatchOffer.updateMany({
    where: { id: { in: lapsed.map((offer) => offer.id) } },
    data: { status: DispatchOfferStatus.EXPIRED, respondedAt: now },
  });

  for (const partnerId of new Set(lapsed.map((offer) => offer.fleetPartnerId))) {
    await recomputeAcceptanceRate(partnerId);
  }

  return lapsed.length;
}

/**
 * Recomputes a partner's acceptance rate from their offer history.
 *
 * The stored column is a denormalised read model — dispatch ranks on it for
 * every candidate query — and this is the only thing that writes it.
 */
export async function recomputeAcceptanceRate(
  fleetPartnerId: string,
  client?: PrismaTransactionClient,
): Promise<number> {
  const db = client ?? prisma;

  const grouped = await db.dispatchOffer.groupBy({
    by: ['status'],
    where: { fleetPartnerId },
    _count: { _all: true },
  });

  const count = (status: DispatchOfferStatus) =>
    grouped.find((row) => row.status === status)?._count._all ?? 0;

  const rate = acceptanceRateForRanking({
    accepted: count(DispatchOfferStatus.ACCEPTED),
    declined: count(DispatchOfferStatus.DECLINED),
    expired: count(DispatchOfferStatus.EXPIRED),
    superseded: count(DispatchOfferStatus.SUPERSEDED),
  });

  await db.fleetPartner.update({
    where: { id: fleetPartnerId },
    data: { acceptanceRate: rate },
  });

  return rate;
}

export interface PartnerOffer {
  offer: DispatchOffer;
  order: Order;
  service: Service;
  pickup: { label: string | null; line1: string; barangay: string | null; cityName: string };
  dropoff: { barangay: string | null; cityName: string };
  earningsCentavos: number;
  earningsParts: { label: string; centavos: number }[];
  secondsRemaining: number;
}

/**
 * Live offers for a partner.
 *
 * Only PENDING and unexpired: a board showing lapsed offers invites a tap that
 * can only fail.
 */
export async function listPartnerOffers(
  fleetPartnerId: string,
  now: Date = new Date(),
): Promise<PartnerOffer[]> {
  const offers = await prisma.dispatchOffer.findMany({
    where: {
      fleetPartnerId,
      status: DispatchOfferStatus.PENDING,
      expiresAt: { gt: now },
      // Somebody may have taken it between the fan-out and this read.
      order: { status: OrderStatus.AWAITING_RIDER_ASSIGNMENT, assignedRiderId: null },
    },
    orderBy: [{ rank: 'asc' }, { offeredAt: 'asc' }],
    include: {
      order: { include: { service: true, addresses: true } },
    },
  });

  return offers.flatMap((row) => {
    const pickup = row.order.addresses.find((address) => address.role === 'PICKUP');
    const dropoff = row.order.addresses.find((address) => address.role === 'DROPOFF');
    if (!pickup || !dropoff) return [];

    // Destructured away: the relations are already read above, and the card
    // wants the plain order.
    const { service, addresses: _addresses, ...order } = row.order;
    const { order: _relatedOrder, ...offer } = row;

    return [
      {
        offer: offer as DispatchOffer,
        order: order as Order,
        service,
        pickup: {
          label: pickup.label,
          line1: pickup.line1,
          barangay: pickup.barangay,
          cityName: pickup.cityName,
        },
        dropoff: { barangay: dropoff.barangay, cityName: dropoff.cityName },
        earningsCentavos: partnerEarningsCentavos(order),
        earningsParts: earningsParts(order),
        secondsRemaining: Math.max(
          0,
          Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000),
        ),
      },
    ];
  });
}

export { CLOSED_OFFER_STATUSES };

/**
 * How many minutes of apparent age each of these customers is owed.
 *
 * One query for the ladder and one aggregate per customer, rather than
 * `tierBenefitsForUser` per order — the fan-out runs every minute over up to a
 * hundred orders, and a round trip each would make the sweep the slowest thing
 * in the app for a perk worth a few minutes.
 *
 * Absent from the map means zero, which is what everybody gets when the
 * programme is off, when no tier confers the perk, or when a customer has not
 * reached the tier that does.
 */
async function dispatchBoostsFor(
  customerIds: readonly string[],
  now: Date,
): Promise<Map<string, number>> {
  const boosts = new Map<string, number>();
  if (customerIds.length === 0) return boosts;

  const programme = await getProgramme();
  if (!programme.isActive) return boosts;

  const tiers = await getTiersWithBenefits();
  // Nothing to do unless some tier actually confers it — the ordinary case,
  // and one lookup rather than an aggregate per customer.
  if (tiers.every((tier) => dispatchPriorityFor(tier.benefits) === 0)) {
    return boosts;
  }

  const unique = [...new Set(customerIds)];
  const accounts = await prisma.loyaltyAccount.findMany({
    where: { userId: { in: unique } },
    select: { id: true, userId: true },
  });
  if (accounts.length === 0) return boosts;

  const earned = await prisma.loyaltyEntry.groupBy({
    by: ['accountId'],
    where: {
      accountId: { in: accounts.map((account) => account.id) },
      type: LoyaltyEntryType.EARNED,
      createdAt: { gte: tierWindowStart(programme, now) },
    },
    _sum: { points: true },
  });
  const pointsByAccount = new Map(
    earned.map((row) => [row.accountId, row._sum.points ?? 0]),
  );

  for (const account of accounts) {
    const { current } = tierFor(tiers, pointsByAccount.get(account.id) ?? 0);
    if (current === null) continue;
    const tier = tiers.find((row) => row.id === current.id);
    const minutes = tier ? dispatchPriorityFor(tier.benefits) : 0;
    if (minutes > 0) boosts.set(account.userId, minutes);
  }

  return boosts;
}
