import {
  DispatchOfferStatus,
  OrderStatus,
  type DispatchOffer,
  type Order,
  type Service,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { findDispatchCandidates } from '@/lib/fleet/dispatch';
import {
  acceptanceRateForRanking,
  CLOSED_OFFER_STATUSES,
  OFFER_FANOUT,
  OFFER_TTL_SECONDS,
  partnerEarningsCentavos,
  REFANOUT_AFTER_SECONDS,
} from '@/lib/fleet/offer-policy';

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
 */
export async function fanOutDispatchOffers(
  options: { now?: Date; maxOrders?: number } = {},
): Promise<FanOutResult[]> {
  const now = options.now ?? new Date();
  const results: FanOutResult[] = [];

  const waiting = await prisma.order.findMany({
    where: { status: OrderStatus.AWAITING_RIDER_ASSIGNMENT, assignedRiderId: null },
    orderBy: { placedAt: 'asc' },
    take: options.maxOrders ?? 50,
    include: {
      addresses: { where: { role: 'PICKUP' } },
      dispatchOffers: true,
    },
  });

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
        secondsRemaining: Math.max(
          0,
          Math.ceil((row.expiresAt.getTime() - now.getTime()) / 1000),
        ),
      },
    ];
  });
}

export { CLOSED_OFFER_STATUSES };
