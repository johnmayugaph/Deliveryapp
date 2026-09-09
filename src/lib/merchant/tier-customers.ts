import { LoyaltyEntryType, OrderStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { REPORT_WINDOW_DAYS } from '@/lib/merchant/reporting';
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
  /** Distinct customers in a tier who completed an order here. */
  tierCustomers: number;
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
        loyaltyDiscountCentavos: true,
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
    tierCustomers: 0,
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

  const tierNameByUser = new Map<string, string>();
  for (const account of accounts) {
    const { current } = tierFor(ladder, pointsByAccount.get(account.id) ?? 0);
    if (current !== null) tierNameByUser.set(account.userId, current.name);
  }

  let tierOrders = 0;
  let tierSubtotalCentavos = 0;
  const seen = new Set<string>();
  for (const row of orders) {
    if (!tierNameByUser.has(row.customerId)) continue;
    tierOrders += 1;
    tierSubtotalCentavos += row.subtotalCentavos;
    seen.add(row.customerId);
  }

  return {
    ...empty,
    tierOrders,
    tierSubtotalCentavos,
    tierCustomers: seen.size,
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
