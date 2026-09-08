import { ReferralStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getPartnerProgramme } from '@/lib/referrals/partner-programme';
import { monthStart } from '@/lib/referrals/rewards';
import {
  deliveriesRemaining,
  partnerProgrammeIsLive,
  type PartnerProgrammeFacts,
} from '@/lib/referrals/partner-policy';

/** What one rider's invite screen shows. */
export interface PartnerInviteSummary {
  programme: PartnerProgrammeFacts;
  isLive: boolean;
  /** Null when the programme is off — no code is minted for a dead offer. */
  code: string | null;

  invited: number;
  waiting: number;
  earnedCentavos: number;
  rewardedThisMonth: number;

  /**
   * Everyone they have brought, newest first, with where each one stands.
   *
   * `deliveriesSoFar` and `deliveriesToGo` are the two numbers that make this
   * screen worth opening: "Ben has done 12 of 20" is something a rider can act
   * on — they can nudge Ben — where "waiting" is not.
   */
  recent: {
    id: string;
    status: ReferralStatus;
    name: string;
    rewardCentavos: number;
    blockedReason: string | null;
    deliveriesSoFar: number;
    deliveriesToGo: number;
    createdAt: Date;
  }[];

  /** How they arrived, when somebody invited them. */
  invitedBy: {
    name: string;
    status: ReferralStatus;
    rewardCentavos: number;
    deliveriesSoFar: number;
    deliveriesToGo: number;
  } | null;

  remainingThisMonth: number | null;
  remainingEver: number | null;
}

const firstName = (
  user: { displayName: string | null; fullName: string | null } | null,
): string =>
  user?.displayName ?? user?.fullName?.split(' ')[0] ?? 'Somebody';

/**
 * One rider's invite standing, both directions.
 *
 * Both directions because a rider can be on either side and usually cares
 * about both: what their own invites have earned, and how close their own
 * welcome bonus is. The customer version has no equivalent of the second,
 * because a customer's welcome credits land at signup and there is nothing to
 * wait for.
 *
 * The delivery counts are read from the ORDERS in one grouped query rather
 * than from `FleetPartner.completedOrderCount` — the same choice the write
 * path makes, so the screen cannot promise a bonus the rule would refuse, or
 * refuse one it would pay.
 */
export async function partnerInviteSummary(
  fleetPartnerId: string,
  now: Date = new Date(),
): Promise<PartnerInviteSummary> {
  const programme = await getPartnerProgramme();
  const isLive = partnerProgrammeIsLive(programme);

  const [made, received, rewardedThisMonth] = await Promise.all([
    prisma.partnerReferral.findMany({
      where: { referrerId: fleetPartnerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        referrerRewardCentavos: true,
        blockedReason: true,
        createdAt: true,
        refereeId: true,
        referee: { select: { user: { select: { displayName: true, fullName: true } } } },
      },
    }),
    prisma.partnerReferral.findUnique({
      where: { refereeId: fleetPartnerId },
      select: {
        status: true,
        refereeRewardCentavos: true,
        referrer: {
          select: { user: { select: { displayName: true, fullName: true } } },
        },
      },
    }),
    prisma.partnerReferral.count({
      where: {
        referrerId: fleetPartnerId,
        status: ReferralStatus.REWARDED,
        rewardedAt: { gte: monthStart(now) },
      },
    }),
  ]);

  // One grouped count for everybody on the screen, including this rider —
  // rather than a query per row, which on a rider who has invited fifteen
  // people would be fifteen round trips for a screen nobody is waiting on.
  const partnerIds = [fleetPartnerId, ...made.map((row) => row.refereeId)];
  const deliveryCounts = await prisma.order.groupBy({
    by: ['assignedRiderId'],
    where: { assignedRiderId: { in: partnerIds }, status: 'COMPLETED' },
    _count: { _all: true },
  });
  const deliveriesBy = new Map(
    deliveryCounts.map((row) => [row.assignedRiderId, row._count._all]),
  );
  const deliveries = (id: string): number => deliveriesBy.get(id) ?? 0;

  const rewardedEver = made.filter(
    (row) => row.status === ReferralStatus.REWARDED,
  ).length;

  return {
    programme,
    isLive,
    code: null,

    invited: made.length,
    waiting: made.filter((row) => row.status === ReferralStatus.ATTRIBUTED).length,
    earnedCentavos: made.reduce(
      (total, row) => total + row.referrerRewardCentavos,
      0,
    ),
    rewardedThisMonth,

    recent: made.slice(0, 12).map((row) => {
      const soFar = deliveries(row.refereeId);
      return {
        id: row.id,
        status: row.status,
        // First name only. The rider knows who they invited, and a full name on
        // a screen they might show somebody is more than this needs.
        name: firstName(row.referee.user),
        rewardCentavos: row.referrerRewardCentavos,
        blockedReason: row.blockedReason,
        deliveriesSoFar: soFar,
        deliveriesToGo: deliveriesRemaining(soFar, programme),
        createdAt: row.createdAt,
      };
    }),

    invitedBy: received
      ? {
          name: firstName(received.referrer.user),
          status: received.status,
          rewardCentavos: received.refereeRewardCentavos,
          deliveriesSoFar: deliveries(fleetPartnerId),
          deliveriesToGo: deliveriesRemaining(deliveries(fleetPartnerId), programme),
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
