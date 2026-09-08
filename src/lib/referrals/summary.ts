import { ReferralStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getProgramme } from '@/lib/referrals/programme';
import { monthStart } from '@/lib/referrals/rewards';
import {
  programmeIsLive,
  type ProgrammeFacts,
} from '@/lib/referrals/policy';

/** What one person's invite screen shows. */
export interface InviteSummary {
  programme: ProgrammeFacts;
  isLive: boolean;
  /** Null when the programme is off — no code is minted for a dead offer. */
  code: string | null;
  invited: number;
  waiting: number;
  earnedCentavos: number;
  rewardedThisMonth: number;
  /** The most recent few, newest first, with what happened to each. */
  recent: {
    id: string;
    status: ReferralStatus;
    name: string;
    rewardCentavos: number;
    blockedReason: string | null;
    createdAt: Date;
  }[];
  /** How many more this month and ever, or null when the programme is off. */
  remainingThisMonth: number | null;
  remainingEver: number | null;
}

/**
 * One person's referral standing.
 *
 * The counts are of referrals, not of money, except `earnedCentavos` which is
 * summed from the referral rows rather than from the credits ledger. That is
 * deliberate: the ledger holds every kind of credit and a rider's own referral
 * bonus should not be confused with their credit-back, whereas these rows say
 * exactly what invites paid.
 */
export async function inviteSummary(
  userId: string,
  now: Date = new Date(),
): Promise<InviteSummary> {
  const programme = await getProgramme();
  const isLive = programmeIsLive(programme);

  const [rows, rewardedThisMonth] = await Promise.all([
    prisma.referral.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        referrerRewardCentavos: true,
        blockedReason: true,
        createdAt: true,
        referee: { select: { displayName: true, fullName: true } },
      },
    }),
    prisma.referral.count({
      where: {
        referrerId: userId,
        status: ReferralStatus.REWARDED,
        referrerRewardedAt: { gte: monthStart(now) },
      },
    }),
  ]);

  const rewardedEver = rows.filter(
    (row) => row.status === ReferralStatus.REWARDED,
  ).length;

  return {
    programme,
    isLive,
    code: null,
    invited: rows.length,
    waiting: rows.filter((row) => row.status === ReferralStatus.ATTRIBUTED).length,
    earnedCentavos: rows.reduce((total, row) => total + row.referrerRewardCentavos, 0),
    rewardedThisMonth,
    recent: rows.slice(0, 8).map((row) => ({
      id: row.id,
      status: row.status,
      // First name only. The referrer knows who they invited, and a full name
      // on a screen somebody might show a friend is more than this needs.
      name: row.referee.displayName ?? row.referee.fullName?.split(' ')[0] ?? 'Someone',
      rewardCentavos: row.referrerRewardCentavos,
      blockedReason: row.blockedReason,
      createdAt: row.createdAt,
    })),
    remainingThisMonth: isLive
      ? Math.max(0, programme.monthlyRewardCap - rewardedThisMonth)
      : null,
    remainingEver: isLive
      ? Math.max(0, programme.lifetimeRewardCap - rewardedEver)
      : null,
  };
}
