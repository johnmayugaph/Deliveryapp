import { ReferralStatus, WalletTransactionType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getProgramme } from '@/lib/referrals/programme';
import { monthStart } from '@/lib/referrals/rewards';
import {
  farmerMargin,
  lifetimeLiabilityPerReferrer,
  programmeIsLive,
  type FarmerMargin,
  type ProgrammeFacts,
} from '@/lib/referrals/policy';

/**
 * The console's view of the referral programme.
 *
 * Two things an operator needs and one they usually do not get.
 *
 * The counts and the spend are the obvious half. The other half is
 * `margin`: what a person referring themselves nets at the amounts currently
 * set. Every referral programme has that number and almost none of them show
 * it, which is why so many are quietly farmed for a month before anybody adds
 * up the ledger.
 */
export interface ReferralOverview {
  programme: ProgrammeFacts;
  isLive: boolean;
  margin: FarmerMargin;
  liabilityPerReferrerCentavos: number;

  attributed: number;
  rewarded: number;
  notRewarded: number;
  rewardedThisMonth: number;

  /** Actually granted, from the LEDGER rather than from the referral rows. */
  paidOutCentavos: number;

  /** Why referrals did not pay, most common first. The tuning signal. */
  refusals: { reason: string; count: number }[];

  /** Accounts earning the most, for a look at who is doing what. */
  topReferrers: {
    userId: string;
    name: string;
    phone: string;
    rewarded: number;
    earnedCentavos: number;
  }[];
}

export async function referralOverview(
  now: Date = new Date(),
): Promise<ReferralOverview> {
  const programme = await getProgramme();

  const [byStatus, thisMonth, ledger, refusalRows, top] = await Promise.all([
    prisma.referral.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.referral.count({
      where: {
        status: ReferralStatus.REWARDED,
        referrerRewardedAt: { gte: monthStart(now) },
      },
    }),
    // From the ledger, not by summing the referral rows: the ledger is what
    // actually moved, and a disagreement between the two is the thing worth
    // being able to see.
    prisma.walletTransaction.aggregate({
      where: { type: WalletTransactionType.REFERRAL_BONUS },
      _sum: { amountCentavos: true },
    }),
    prisma.referral.groupBy({
      by: ['blockedReason'],
      where: { status: ReferralStatus.NOT_REWARDED },
      _count: { _all: true },
    }),
    prisma.referral.groupBy({
      by: ['referrerId'],
      where: { status: ReferralStatus.REWARDED },
      _count: { _all: true },
      _sum: { referrerRewardCentavos: true },
      orderBy: { _sum: { referrerRewardCentavos: 'desc' } },
      take: 8,
    }),
  ]);

  const count = (status: ReferralStatus): number =>
    byStatus.find((row) => row.status === status)?._count._all ?? 0;

  const referrers = await prisma.user.findMany({
    where: { id: { in: top.map((row) => row.referrerId) } },
    select: { id: true, fullName: true, displayName: true, phone: true },
  });
  const byId = new Map(referrers.map((row) => [row.id, row]));

  return {
    programme,
    isLive: programmeIsLive(programme),
    margin: farmerMargin(programme),
    liabilityPerReferrerCentavos: lifetimeLiabilityPerReferrer(programme),

    attributed: count(ReferralStatus.ATTRIBUTED),
    rewarded: count(ReferralStatus.REWARDED),
    notRewarded: count(ReferralStatus.NOT_REWARDED),
    rewardedThisMonth: thisMonth,

    paidOutCentavos: ledger._sum.amountCentavos ?? 0,

    refusals: refusalRows
      .map((row) => ({
        reason: row.blockedReason ?? 'Unknown',
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count),

    topReferrers: top.map((row) => {
      const user = byId.get(row.referrerId);
      return {
        userId: row.referrerId,
        name: user?.fullName ?? user?.displayName ?? 'Unknown',
        phone: user?.phone ?? '',
        rewarded: row._count._all,
        earnedCentavos: row._sum.referrerRewardCentavos ?? 0,
      };
    }),
  };
}
