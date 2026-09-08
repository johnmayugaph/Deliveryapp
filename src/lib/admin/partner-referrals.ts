import {
  ReferralStatus,
  SettlementEntryType,
  SettlementParty,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPartnerProgramme } from '@/lib/referrals/partner-programme';
import { monthStart } from '@/lib/referrals/rewards';
import {
  acquisitionCost,
  partnerProgrammeIsLive,
  type AcquisitionCost,
  type PartnerProgrammeFacts,
} from '@/lib/referrals/partner-policy';

/**
 * The console's view of the rider-invite programme.
 *
 * The customer screen's headline number is the farmer's margin. This one's is
 * **what a rider costs to acquire, and over how much work** — because the
 * attack the other number warns about does not exist here. Collecting a
 * partner bonus requires passing verification and completing real deliveries,
 * so somebody "farming" it has delivered food and been paid for delivering
 * food. What can go wrong instead is quieter: paying more to hire a rider than
 * the rider earns back, for months, without anybody adding it up.
 *
 * The money figures come from the SETTLEMENT LEDGER rather than from the
 * referral rows, for the same reason the customer overview reads the credits
 * ledger: the ledger is what actually moved, and a disagreement between the
 * two is the thing worth being able to see.
 */

export interface PartnerReferralRow {
  id: string;
  status: ReferralStatus;
  codeUsed: string;
  referrerName: string;
  referrerPhone: string;
  refereeName: string;
  refereePhone: string;
  referrerRewardCentavos: number;
  refereeRewardCentavos: number;
  blockedReason: string | null;
  qualifyingDeliveryCount: number | null;
  createdAt: Date;
  rewardedAt: Date | null;
}

export interface PartnerReferralOverview {
  programme: PartnerProgrammeFacts;
  isLive: boolean;
  cost: AcquisitionCost;

  attributed: number;
  rewarded: number;
  notRewarded: number;
  rewardedThisMonth: number;

  /** Accrued as bonuses, from the ledger. All time and this calendar month. */
  accruedCentavos: number;
  accruedThisMonthCentavos: number;

  /** Why invites did not pay, most common first. The tuning signal. */
  refusals: { reason: string; count: number }[];

  rows: PartnerReferralRow[];
}

/**
 * The FULL name, falling back to the display name.
 *
 * The opposite preference from the rider's own screen, which shows first names
 * only because a rider knows who they invited. An operator does not: they are
 * looking somebody up, usually next to the phone number, and "Ana" is not a
 * person you can find. Matches `referralOverview`'s `topReferrers`.
 */
const named = (
  user: { fullName: string | null; displayName: string | null } | null,
): string => user?.fullName ?? user?.displayName ?? 'Unknown';

export async function partnerReferralOverview(
  now: Date = new Date(),
): Promise<PartnerReferralOverview> {
  const programme = await getPartnerProgramme();
  const from = monthStart(now);

  const partnerSelect = {
    select: {
      user: { select: { fullName: true, displayName: true, phone: true } },
    },
  } as const;

  const [byStatus, thisMonth, accrued, accruedThisMonth, refusalRows, rows] =
    await Promise.all([
      prisma.partnerReferral.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.partnerReferral.count({
        where: { status: ReferralStatus.REWARDED, rewardedAt: { gte: from } },
      }),
      prisma.settlementEntry.aggregate({
        where: {
          type: SettlementEntryType.REFERRAL_BONUS,
          party: SettlementParty.FLEET_PARTNER,
        },
        _sum: { amountCentavos: true },
      }),
      prisma.settlementEntry.aggregate({
        where: {
          type: SettlementEntryType.REFERRAL_BONUS,
          party: SettlementParty.FLEET_PARTNER,
          createdAt: { gte: from },
        },
        _sum: { amountCentavos: true },
      }),
      prisma.partnerReferral.groupBy({
        by: ['blockedReason'],
        where: { status: ReferralStatus.NOT_REWARDED },
        _count: { _all: true },
      }),
      prisma.partnerReferral.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          status: true,
          codeUsed: true,
          referrerRewardCentavos: true,
          refereeRewardCentavos: true,
          blockedReason: true,
          qualifyingDeliveryCount: true,
          createdAt: true,
          rewardedAt: true,
          referrer: partnerSelect,
          referee: partnerSelect,
        },
      }),
    ]);

  const count = (status: ReferralStatus): number =>
    byStatus.find((row) => row.status === status)?._count._all ?? 0;

  return {
    programme,
    isLive: partnerProgrammeIsLive(programme),
    cost: acquisitionCost(programme),

    attributed: count(ReferralStatus.ATTRIBUTED),
    rewarded: count(ReferralStatus.REWARDED),
    notRewarded: count(ReferralStatus.NOT_REWARDED),
    rewardedThisMonth: thisMonth,

    accruedCentavos: accrued._sum.amountCentavos ?? 0,
    accruedThisMonthCentavos: accruedThisMonth._sum.amountCentavos ?? 0,

    refusals: refusalRows
      .map((row) => ({
        reason: row.blockedReason ?? 'Unknown',
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count),

    rows: rows.map((row) => ({
      id: row.id,
      status: row.status,
      codeUsed: row.codeUsed,
      referrerName: named(row.referrer.user),
      referrerPhone: row.referrer.user.phone,
      refereeName: named(row.referee.user),
      refereePhone: row.referee.user.phone,
      referrerRewardCentavos: row.referrerRewardCentavos,
      refereeRewardCentavos: row.refereeRewardCentavos,
      blockedReason: row.blockedReason,
      qualifyingDeliveryCount: row.qualifyingDeliveryCount,
      createdAt: row.createdAt,
      rewardedAt: row.rewardedAt,
    })),
  };
}
