import { PromoKind, type ServiceKey } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  exposureFor,
  giveawayFor,
  type PromoExposure,
  type PromoGiveaway,
  type PromoUsageFacts,
} from '@/lib/promo/policy';

/**
 * The console's view of the promo campaigns.
 *
 * The counts and the spend are the obvious half. The other half is the two
 * numbers an operator setting up a campaign does not work out for themselves:
 *
 *  - **What it can still cost** (`exposure`). A campaign's danger is not the
 *    discount on one order, it is the number of orders. A ₱50 code with no
 *    total limit and no budget is an open cheque, and a screen that shows a
 *    redemption count leaves the arithmetic to somebody at the end of the
 *    month.
 *  - **Whether it makes food free** (`giveaway`). A fixed amount at or above
 *    the minimum order means somebody eats for nothing while we pay the shop
 *    and the rider in full. Perfectly legal arithmetic, no error anywhere.
 *
 * Every figure comes from COUNTING `PromoRedemption`, never from a cached
 * counter on the code. A cached count is a second truth, and the moment it
 * drifts a campaign either stops early or runs past its budget with nobody
 * able to say which.
 */

export type PromoWindow = 'BEFORE' | 'LIVE' | 'ENDED';

export interface PromoCodeRow {
  id: string;
  code: string;
  label: string;
  kind: PromoKind;
  isActive: boolean;
  /** Whether the code is inside its dates, regardless of `isActive`. */
  window: PromoWindow;
  /** Live in every sense: switched on AND inside its dates. */
  isLive: boolean;

  startsAt: Date;
  endsAt: Date;

  percentBasisPoints: number | null;
  amountCentavos: number | null;
  maxDiscountCentavos: number | null;
  minimumOrderCentavos: number;
  totalRedemptionLimit: number | null;
  perCustomerLimit: number;
  budgetCentavos: number | null;
  firstOrderOnly: boolean;
  stacksWithSubscription: boolean;

  /** Empty arrays mean "everywhere" / "every service". */
  serviceTypes: ServiceKey[];
  cityNames: string[];
  storeName: string | null;

  usage: PromoUsageFacts;
  exposure: PromoExposure;
  giveaway: PromoGiveaway;

  createdByName: string | null;
  createdAt: Date;
}

export interface PromoOverview {
  codes: PromoCodeRow[];
  liveCount: number;
  redemptions: number;
  spentCentavos: number;
  spentThisMonthCentavos: number;
  /**
   * What every live campaign could still cost, added up. Null when any one of
   * them is unbounded, because a total that silently omits an open cheque is
   * worse than no total.
   */
  remainingExposureCentavos: number | null;
  /** Live codes nothing bounds the total cost of. */
  unbounded: PromoCodeRow[];
  /** Live codes that could cover the whole food cost of a qualifying order. */
  freeFood: PromoCodeRow[];
}

function windowFor(startsAt: Date, endsAt: Date, now: Date): PromoWindow {
  if (now < startsAt) return 'BEFORE';
  if (now > endsAt) return 'ENDED';
  return 'LIVE';
}

/** First instant of the current calendar month, UTC. */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function promoOverview(now: Date = new Date()): Promise<PromoOverview> {
  const [rows, usageRows, thisMonth] = await Promise.all([
    prisma.promoCode.findMany({
      orderBy: [{ isActive: 'desc' }, { endsAt: 'desc' }],
      include: {
        store: { select: { name: true } },
        createdBy: { select: { fullName: true, displayName: true } },
      },
    }),
    prisma.promoRedemption.groupBy({
      by: ['promoCodeId'],
      _count: { _all: true },
      _sum: { discountCentavos: true },
    }),
    prisma.promoRedemption.aggregate({
      where: { createdAt: { gte: monthStart(now) } },
      _sum: { discountCentavos: true },
    }),
  ]);

  // Cities are named per code from one lookup rather than a query per row.
  const cityIds = Array.from(new Set(rows.flatMap((row) => row.cityIds)));
  const cities =
    cityIds.length > 0
      ? await prisma.city.findMany({
          where: { id: { in: cityIds } },
          select: { id: true, name: true },
        })
      : [];
  const cityNameById = new Map(cities.map((city) => [city.id, city.name]));

  const usageById = new Map(
    usageRows.map((row) => [
      row.promoCodeId,
      {
        redemptions: row._count._all,
        spentCentavos: row._sum.discountCentavos ?? 0,
      } satisfies PromoUsageFacts,
    ]),
  );

  const codes: PromoCodeRow[] = rows.map((row) => {
    const usage = usageById.get(row.id) ?? { redemptions: 0, spentCentavos: 0 };
    const window = windowFor(row.startsAt, row.endsAt, now);

    return {
      id: row.id,
      code: row.code,
      label: row.label,
      kind: row.kind,
      isActive: row.isActive,
      window,
      isLive: row.isActive && window === 'LIVE',
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      percentBasisPoints: row.percentBasisPoints,
      amountCentavos: row.amountCentavos,
      maxDiscountCentavos: row.maxDiscountCentavos,
      minimumOrderCentavos: row.minimumOrderCentavos,
      totalRedemptionLimit: row.totalRedemptionLimit,
      perCustomerLimit: row.perCustomerLimit,
      budgetCentavos: row.budgetCentavos,
      firstOrderOnly: row.firstOrderOnly,
      stacksWithSubscription: row.stacksWithSubscription,
      serviceTypes: row.serviceTypes,
      cityNames: row.cityIds.map((id) => cityNameById.get(id) ?? id),
      storeName: row.store?.name ?? null,
      usage,
      exposure: exposureFor(row, usage),
      giveaway: giveawayFor(row),
      createdByName:
        row.createdBy?.displayName ?? row.createdBy?.fullName ?? null,
      createdAt: row.createdAt,
    };
  });

  const live = codes.filter((code) => code.isLive);
  const unbounded = live.filter((code) => code.exposure.unbounded);

  return {
    codes,
    liveCount: live.length,
    redemptions: codes.reduce((total, code) => total + code.usage.redemptions, 0),
    spentCentavos: codes.reduce((total, code) => total + code.usage.spentCentavos, 0),
    spentThisMonthCentavos: thisMonth._sum.discountCentavos ?? 0,
    remainingExposureCentavos:
      unbounded.length > 0
        ? null
        : live.reduce((total, code) => total + (code.exposure.remainingCentavos ?? 0), 0),
    unbounded,
    freeFood: live.filter((code) => code.giveaway.coversTheFood),
  };
}

/** What one code's kind is worth, in a sentence. For the list. */
export function describeKind(code: PromoCodeRow): string {
  switch (code.kind) {
    case PromoKind.PERCENTAGE:
      return `${(code.percentBasisPoints ?? 0) / 100}% off the food`;
    case PromoKind.FIXED_AMOUNT:
      return 'A flat amount off';
    case PromoKind.FREE_DELIVERY:
      return 'The delivery fee';
  }
}
