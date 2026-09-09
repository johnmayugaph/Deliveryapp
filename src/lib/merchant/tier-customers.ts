import { LoyaltyEntryType, OrderStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { REPORT_WINDOW_DAYS } from '@/lib/merchant/reporting';
import { platformAbsorbedCentavos } from '@/lib/settlement/policy';
import { getProgramme, getTiersWithBenefits } from '@/lib/loyalty/programme';
import { tierFor, tierWindowStart } from '@/lib/loyalty/policy';
import {
  merchantTierViews,
  type MerchantTierView,
} from '@/lib/merchant/tier-view';

/**
 * How much of this shop's business comes from customers in a tier, and what
 * the platform paid out on it.
 *
 * The window is completed orders only. A shop reading "40% of your orders" and
 * finding it counts orders it rejected would stop trusting the number, and
 * rightly.
 *
 * A customer's tier is DERIVED, not stored: it is the points they earned
 * inside the programme's rolling window, compared against the ladder. So this
 * reports each customer's tier **as of now**, not as of the order — an order
 * from six months ago is counted against whoever that customer is today. That
 * is the honest reading of a question a shop is actually asking ("who are my
 * regulars"), and the screen says which it is rather than leaving a shop to
 * assume the other one.
 *
 * Costs one ladder read plus two grouped aggregates however many customers the
 * shop has, which is the same shape `dispatchBoostsFor` and the support queue
 * already use.
 */

/** How many of this shop's regulars sit at one rung, and what they spend. */
export interface RegularsAtTier {
  tierId: string;
  name: string;
  customers: number;
  orders: number;
  subtotalCentavos: number;
}

export interface StoreTierStanding {
  /** Completed orders in the window, from customers currently in any tier. */
  tierOrders: number;
  /** Completed orders in the window, all customers. */
  totalOrders: number;
  /** Food subtotal of the tier orders, in centavos. */
  tierSubtotalCentavos: number;
  /** Food subtotal of every completed order in the window. */
  totalSubtotalCentavos: number;
  /**
   * What a loyalty tier took off customers' bills on THIS shop's orders, which
   * the platform absorbed. Never subtracted from the shop's payout — the store
   * settlement entry is computed from the subtotal and the commission alone.
   */
  loyaltyDiscountAbsorbedCentavos: number;
  /**
   * Everything TARA absorbed on this shop's orders in the window, of which the
   * figure above is the loyalty part.
   *
   * Both, because one of them alone was a trap. This screen showed the loyalty
   * figure labelled "TARA covered", and the History tab shows the four-column
   * total under the same words — and since both were put on the same ninety
   * days, a shop comparing them got two different numbers with nothing to
   * explain the gap. Computed with `platformAbsorbedCentavos`, the function
   * settlement was charged and the History tab reports, so the two figures are
   * the same number by construction rather than by coincidence.
   */
  absorbedCentavos: number;
  /** Distinct customers in a tier who completed an order here. */
  tierCustomers: number;
  /**
   * This shop's own regulars, split across the ladder.
   *
   * The page is headed "Your regulars" and answered with a single count, while
   * the query classified every customer into a tier to compute that count and
   * threw the classification away. Rungs nobody here has reached are omitted:
   * a shop wants to know who its regulars are, not which bands exist.
   */
  regularsByTier: RegularsAtTier[];
  /** How many days the numbers cover. */
  windowDays: number;
  /** The ladder, as a shop reads it. Empty when no tier confers anything. */
  tiers: MerchantTierView[];
  /** False when the programme is switched off, which makes every count zero. */
  programmeIsOn: boolean;
}

/**
 * Kept as a name for every existing caller, but no longer a number written
 * down here: the History tab reports over the same period and the two had
 * nothing tying them together. `reporting.ts` is the one place it lives.
 */
export const DEFAULT_WINDOW_DAYS = REPORT_WINDOW_DAYS;

export async function storeTierStanding(
  storeId: string,
  options: { windowDays?: number; now?: Date } = {},
): Promise<StoreTierStanding> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const [programme, orders] = await Promise.all([
    getProgramme(),
    prisma.order.findMany({
      where: {
        status: OrderStatus.COMPLETED,
        details: { path: ['storeId'], equals: storeId },
        createdAt: { gte: since },
      },
      select: {
        customerId: true,
        subtotalCentavos: true,
        // All four discount columns, because `platformAbsorbedCentavos` reads
        // all four and this screen has to report the same total the History
        // tab does.
        promoDiscountCentavos: true,
        subscriptionDiscountCentavos: true,
        loyaltyDiscountCentavos: true,
        walletCreditAppliedCentavos: true,
      },
    }),
  ]);

  const empty = {
    tierOrders: 0,
    totalOrders: orders.length,
    tierSubtotalCentavos: 0,
    totalSubtotalCentavos: orders.reduce((sum, row) => sum + row.subtotalCentavos, 0),
    loyaltyDiscountAbsorbedCentavos: orders.reduce(
      (sum, row) => sum + row.loyaltyDiscountCentavos,
      0,
    ),
    absorbedCentavos: orders.reduce(
      (sum, row) => sum + platformAbsorbedCentavos(row),
      0,
    ),
    tierCustomers: 0,
    regularsByTier: [] as RegularsAtTier[],
    windowDays,
    tiers: [] as MerchantTierView[],
  };

  if (!programme.isActive) {
    // The discount total is still reported: a programme switched off after
    // running would leave real money already absorbed on this shop's orders,
    // and zeroing it here would make the screen lie about the past.
    return { ...empty, programmeIsOn: false };
  }

  const ladder = await getTiersWithBenefits();
  const views = merchantTierViews(ladder);
  if (ladder.length === 0 || orders.length === 0) {
    return { ...empty, tiers: views, programmeIsOn: true };
  }

  const customerIds = [...new Set(orders.map((row) => row.customerId))];
  const accounts = await prisma.loyaltyAccount.findMany({
    where: { userId: { in: customerIds } },
    select: { id: true, userId: true },
  });

  const earned =
    accounts.length === 0
      ? []
      : await prisma.loyaltyEntry.groupBy({
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

  /* The id as well as the name: the split below groups on the id, so two
     rungs that somehow carry the same name cannot be merged into one. */
  const tierByUser = new Map<string, { id: string; name: string }>();
  for (const account of accounts) {
    const { current } = tierFor(ladder, pointsByAccount.get(account.id) ?? 0);
    if (current !== null) {
      tierByUser.set(account.userId, { id: current.id, name: current.name });
    }
  }

  let tierOrders = 0;
  let tierSubtotalCentavos = 0;
  const seen = new Set<string>();
  /* Keyed by tier id, so two rungs that somehow share a name stay apart. */
  const perTier = new Map<
    string,
    { name: string; customers: Set<string>; orders: number; subtotalCentavos: number }
  >();

  for (const row of orders) {
    const tier = tierByUser.get(row.customerId);
    if (tier === undefined) continue;
    tierOrders += 1;
    tierSubtotalCentavos += row.subtotalCentavos;
    seen.add(row.customerId);

    const bucket = perTier.get(tier.id) ?? {
      name: tier.name,
      customers: new Set<string>(),
      orders: 0,
      subtotalCentavos: 0,
    };
    bucket.customers.add(row.customerId);
    bucket.orders += 1;
    bucket.subtotalCentavos += row.subtotalCentavos;
    perTier.set(tier.id, bucket);
  }

  return {
    ...empty,
    tierOrders,
    tierSubtotalCentavos,
    tierCustomers: seen.size,
    /* In LADDER order, not by how many customers each has: a shop reads the
       rungs in the order it was shown them just below, and a list that
       reshuffled as customers moved between rungs would be unreadable. */
    regularsByTier: ladder.flatMap((tier) => {
      const bucket = perTier.get(tier.id);
      return bucket === undefined
        ? []
        : [
            {
              tierId: tier.id,
              name: bucket.name,
              customers: bucket.customers.size,
              orders: bucket.orders,
              subtotalCentavos: bucket.subtotalCentavos,
            },
          ];
    }),
    tiers: views,
    programmeIsOn: true,
  };
}

/**
 * The tier name for each of a set of customers, or nothing.
 *
 * For the live queue card: a shop looking at an order wants to know whether
 * the person waiting is a regular, which is the whole idea behind the word
 * suki. Only the NAME crosses this boundary — not the points, not the
 * benefits, not how far off the next tier they are. A shop has no use for
 * those and they are not its business.
 */
export async function tierNamesForCustomers(
  customerIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (customerIds.length === 0) return names;

  const programme = await getProgramme();
  if (!programme.isActive) return names;

  const ladder = await getTiersWithBenefits();
  if (ladder.length === 0) return names;

  const unique = [...new Set(customerIds)];
  const accounts = await prisma.loyaltyAccount.findMany({
    where: { userId: { in: unique } },
    select: { id: true, userId: true },
  });
  if (accounts.length === 0) return names;

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
    const { current } = tierFor(ladder, pointsByAccount.get(account.id) ?? 0);
    if (current !== null) names.set(account.userId, current.name);
  }
  return names;
}
