import { ReferralStatus, SettlementEntryType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getStoreProgramme } from '@/lib/referrals/store-programme';
import { monthStart } from '@/lib/referrals/rewards';
import {
  earningsRemaining,
  storeProgrammeIsLive,
  type StoreProgrammeFacts,
} from '@/lib/referrals/store-policy';

/** What one shop's referral panel shows. */
export interface StoreReferralSummary {
  programme: StoreProgrammeFacts;
  isLive: boolean;

  introduced: number;
  waiting: number;
  earnedCentavos: number;

  /**
   * The shops this one brought, newest first.
   *
   * `soFarCentavos` and `toGoCentavos` are what make the panel worth opening:
   * "Mario's Grill has earned ₱13,600 of ₱20,000" is a fact a shop owner can
   * act on — they can call Mario — where "waiting" is not.
   */
  introducedShops: {
    id: string;
    name: string;
    status: ReferralStatus;
    rewardCentavos: number;
    blockedReason: string | null;
    soFarCentavos: number;
    toGoCentavos: number;
    createdAt: Date;
  }[];

  /** How this shop itself arrived, when another shop introduced it. */
  introducedBy: {
    name: string;
    status: ReferralStatus;
    rewardCentavos: number;
    soFarCentavos: number;
    toGoCentavos: number;
  } | null;

  remainingThisMonth: number | null;
  remainingEver: number | null;
}

/**
 * One shop's referral standing, both directions.
 *
 * The earnings figures come from the settlement ledger in ONE grouped query
 * across every shop on the panel — the same number the write path qualifies
 * on, so this screen cannot promise a bonus the rule would refuse. A query per
 * row would be a round trip per introduced shop for a screen nobody is waiting
 * on.
 */
export async function storeReferralSummary(
  storeId: string,
  now: Date = new Date(),
): Promise<StoreReferralSummary> {
  const programme = await getStoreProgramme();
  const isLive = storeProgrammeIsLive(programme);

  const [made, received, rewardedThisMonth] = await Promise.all([
    prisma.storeReferral.findMany({
      where: { referrerStoreId: storeId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        referrerRewardCentavos: true,
        blockedReason: true,
        createdAt: true,
        refereeStoreId: true,
        refereeStore: { select: { name: true } },
      },
    }),
    prisma.storeReferral.findUnique({
      where: { refereeStoreId: storeId },
      select: {
        status: true,
        refereeRewardCentavos: true,
        referrerStore: { select: { name: true } },
      },
    }),
    prisma.storeReferral.count({
      where: {
        referrerStoreId: storeId,
        status: ReferralStatus.REWARDED,
        rewardedAt: { gte: monthStart(now) },
      },
    }),
  ]);

  const storeIds = [storeId, ...made.map((row) => row.refereeStoreId)];
  const earnings = await prisma.settlementEntry.groupBy({
    by: ['storeId'],
    where: {
      storeId: { in: storeIds },
      type: SettlementEntryType.ORDER_EARNINGS,
    },
    _sum: { amountCentavos: true },
  });
  const earnedBy = new Map(
    earnings.map((row) => [row.storeId, row._sum.amountCentavos ?? 0]),
  );
  const earned = (id: string): number => earnedBy.get(id) ?? 0;

  const rewardedEver = made.filter(
    (row) => row.status === ReferralStatus.REWARDED,
  ).length;

  return {
    programme,
    isLive,

    introduced: made.length,
    waiting: made.filter((row) => row.status === ReferralStatus.ATTRIBUTED).length,
    earnedCentavos: made.reduce(
      (total, row) => total + row.referrerRewardCentavos,
      0,
    ),

    introducedShops: made.slice(0, 12).map((row) => {
      const soFar = earned(row.refereeStoreId);
      return {
        id: row.id,
        name: row.refereeStore.name,
        status: row.status,
        rewardCentavos: row.referrerRewardCentavos,
        blockedReason: row.blockedReason,
        soFarCentavos: soFar,
        toGoCentavos: earningsRemaining(soFar, programme),
        createdAt: row.createdAt,
      };
    }),

    introducedBy: received
      ? {
          name: received.referrerStore.name,
          status: received.status,
          rewardCentavos: received.refereeRewardCentavos,
          soFarCentavos: earned(storeId),
          toGoCentavos: earningsRemaining(earned(storeId), programme),
        }
      : null,

    remainingThisMonth: isLive
      ? Math.max(0, programme.monthlyRewardCap - rewardedThisMonth)
      : null,
    remainingEver: isLive
      ? Math.max(0, programme.lifetimeRewardCap - rewardedEver)
      : null,
  };
}
