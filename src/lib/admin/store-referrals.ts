import {
  ReferralStatus,
  SettlementEntryType,
  SettlementParty,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getStoreProgramme } from '@/lib/referrals/store-programme';
import { monthStart } from '@/lib/referrals/rewards';
import {
  storeAcquisitionCost,
  storeProgrammeIsLive,
  type StoreAcquisitionCost,
  type StoreProgrammeFacts,
} from '@/lib/referrals/store-policy';

/**
 * The console's view of the shop-referral programme.
 *
 * Its headline number is the bonus expressed in **basis points of the
 * earnings threshold**, which is the same unit as commission — so an operator
 * can hold it against what they charge those shops and see whether the
 * programme buys revenue back or spends it forward.
 *
 * The other two programmes' headline numbers are a farmer's margin (credits,
 * where a person can profit from themselves) and a cost per delivery (riders,
 * where the work is the defence). This one is neither: a shop referral is
 * recorded by a person, so what can go wrong is not farming but a claim
 * nobody checked — which is why the rows below carry who said it and why.
 */

export interface StoreReferralRow {
  id: string;
  status: ReferralStatus;
  referrerStoreId: string;
  referrerName: string;
  refereeStoreId: string;
  refereeName: string;
  attributedByName: string;
  attributionNote: string;
  referrerRewardCentavos: number;
  refereeRewardCentavos: number;
  blockedReason: string | null;
  qualifyingEarningsCentavos: number | null;
  createdAt: Date;
  rewardedAt: Date | null;
}

export interface StoreReferralOverview {
  programme: StoreProgrammeFacts;
  isLive: boolean;
  cost: StoreAcquisitionCost;

  attributed: number;
  rewarded: number;
  notRewarded: number;
  rewardedThisMonth: number;

  accruedCentavos: number;
  accruedThisMonthCentavos: number;

  /**
   * The middle commission rate across visible shops, in basis points.
   *
   * Here so `cost.costBasisPointsOfEarnings` has something to be read
   * AGAINST. On its own, "375 basis points" is a number an operator has to go
   * and look something up to interpret; next to "a typical shop pays 1500",
   * it is a subtraction. Null when no shop is charged commission.
   */
  typicalCommissionBasisPoints: number | null;

  refusals: { reason: string; count: number }[];

  rows: StoreReferralRow[];
}

const named = (
  user: { fullName: string | null; displayName: string | null } | null,
): string => user?.fullName ?? user?.displayName ?? 'Unknown';

export async function storeReferralOverview(
  now: Date = new Date(),
): Promise<StoreReferralOverview> {
  const programme = await getStoreProgramme();
  const from = monthStart(now);

  const [
    byStatus,
    thisMonth,
    accrued,
    accruedThisMonth,
    refusalRows,
    rows,
    commissions,
  ] = await Promise.all([
      prisma.storeReferral.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.storeReferral.count({
        where: { status: ReferralStatus.REWARDED, rewardedAt: { gte: from } },
      }),
      prisma.settlementEntry.aggregate({
        where: {
          type: SettlementEntryType.REFERRAL_BONUS,
          party: SettlementParty.STORE,
        },
        _sum: { amountCentavos: true },
      }),
      prisma.settlementEntry.aggregate({
        where: {
          type: SettlementEntryType.REFERRAL_BONUS,
          party: SettlementParty.STORE,
          createdAt: { gte: from },
        },
        _sum: { amountCentavos: true },
      }),
      prisma.storeReferral.groupBy({
        by: ['blockedReason'],
        where: { status: ReferralStatus.NOT_REWARDED },
        _count: { _all: true },
      }),
      prisma.storeReferral.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          status: true,
          referrerStoreId: true,
          refereeStoreId: true,
          attributionNote: true,
          referrerRewardCentavos: true,
          refereeRewardCentavos: true,
          blockedReason: true,
          qualifyingEarningsCentavos: true,
          createdAt: true,
          rewardedAt: true,
          referrerStore: { select: { name: true } },
          refereeStore: { select: { name: true } },
          attributedBy: { select: { fullName: true, displayName: true } },
        },
      }),
      prisma.store.findMany({
        where: { isVisible: true, commissionBasisPoints: { gt: 0 } },
        select: { commissionBasisPoints: true },
        orderBy: { commissionBasisPoints: 'asc' },
      }),
    ]);

  // The median rather than the mean: one shop on a bespoke rate should not
  // move the figure an operator compares the bonus against.
  const median = commissions[Math.floor((commissions.length - 1) / 2)];

  const count = (status: ReferralStatus): number =>
    byStatus.find((row) => row.status === status)?._count._all ?? 0;

  return {
    programme,
    isLive: storeProgrammeIsLive(programme),
    cost: storeAcquisitionCost(programme),

    attributed: count(ReferralStatus.ATTRIBUTED),
    rewarded: count(ReferralStatus.REWARDED),
    notRewarded: count(ReferralStatus.NOT_REWARDED),
    rewardedThisMonth: thisMonth,

    // STORE bonuses only. The rider programme's accruals share the entry type
    // and would otherwise be counted as the cost of acquiring shops.
    accruedCentavos: accrued._sum.amountCentavos ?? 0,
    accruedThisMonthCentavos: accruedThisMonth._sum.amountCentavos ?? 0,

    typicalCommissionBasisPoints: median?.commissionBasisPoints ?? null,

    refusals: refusalRows
      .map((row) => ({
        reason: row.blockedReason ?? 'Unknown',
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count),

    rows: rows.map((row) => ({
      id: row.id,
      status: row.status,
      referrerStoreId: row.referrerStoreId,
      referrerName: row.referrerStore.name,
      refereeStoreId: row.refereeStoreId,
      refereeName: row.refereeStore.name,
      attributedByName: named(row.attributedBy),
      attributionNote: row.attributionNote,
      referrerRewardCentavos: row.referrerRewardCentavos,
      refereeRewardCentavos: row.refereeRewardCentavos,
      blockedReason: row.blockedReason,
      qualifyingEarningsCentavos: row.qualifyingEarningsCentavos,
      createdAt: row.createdAt,
      rewardedAt: row.rewardedAt,
    })),
  };
}

/**
 * What one shop's attribution looks like, for its own console page.
 *
 * Returns the candidates to attribute it to as well, because the form is a
 * pick from a list rather than a code — and the list is the visible shops in
 * the same city, which is what an ops person is choosing between. A shop
 * introduced by one in another province is possible and rare enough to be
 * worth doing by hand.
 */
export async function storeAttributionFor(storeId: string): Promise<{
  isLive: boolean;
  programme: StoreProgrammeFacts;
  existing: StoreReferralRow | null;
  earnedCentavos: number;
  candidates: { id: string; name: string }[];
}> {
  const programme = await getStoreProgramme();

  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { id: true, cityId: true },
  });

  const [existing, earnings, candidates] = await Promise.all([
    prisma.storeReferral.findUnique({
      where: { refereeStoreId: storeId },
      select: {
        id: true,
        status: true,
        referrerStoreId: true,
        refereeStoreId: true,
        attributionNote: true,
        referrerRewardCentavos: true,
        refereeRewardCentavos: true,
        blockedReason: true,
        qualifyingEarningsCentavos: true,
        createdAt: true,
        rewardedAt: true,
        referrerStore: { select: { name: true } },
        refereeStore: { select: { name: true } },
        attributedBy: { select: { fullName: true, displayName: true } },
      },
    }),
    prisma.settlementEntry.aggregate({
      where: { storeId, type: SettlementEntryType.ORDER_EARNINGS },
      _sum: { amountCentavos: true },
    }),
    prisma.store.findMany({
      where: { id: { not: storeId }, cityId: store.cityId, isVisible: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 200,
    }),
  ]);

  return {
    isLive: storeProgrammeIsLive(programme),
    programme,
    existing: existing
      ? {
          id: existing.id,
          status: existing.status,
          referrerStoreId: existing.referrerStoreId,
          referrerName: existing.referrerStore.name,
          refereeStoreId: existing.refereeStoreId,
          refereeName: existing.refereeStore.name,
          attributedByName: named(existing.attributedBy),
          attributionNote: existing.attributionNote,
          referrerRewardCentavos: existing.referrerRewardCentavos,
          refereeRewardCentavos: existing.refereeRewardCentavos,
          blockedReason: existing.blockedReason,
          qualifyingEarningsCentavos: existing.qualifyingEarningsCentavos,
          createdAt: existing.createdAt,
          rewardedAt: existing.rewardedAt,
        }
      : null,
    earnedCentavos: earnings._sum.amountCentavos ?? 0,
    candidates,
  };
}
