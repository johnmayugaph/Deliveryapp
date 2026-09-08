import {
  NotificationKind,
  ReferralStatus,
  SettlementEntryType,
  type Order,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { recordSettlementEntry } from '@/lib/settlement/ledger';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { getPartnerProgramme } from '@/lib/referrals/partner-programme';
import { monthStart } from '@/lib/referrals/rewards';
import {
  PARTNER_REWARD_REFUSAL_TEXT,
  paysNothing,
  rewardForPartnerReferral,
} from '@/lib/referrals/partner-policy';

/**
 * Paying a rider for bringing a rider.
 *
 * Runs inside the order-completion transaction, next to the settlement accrual
 * and the customer referral, and for the same reason: a completion that paid a
 * bonus in a separate step could pay it twice or not at all.
 *
 * ### It accrues, it does not pay
 *
 * The bonus becomes a `REFERRAL_BONUS` line on the settlement ledger, which
 * increases what TARA owes that rider. The money then leaves in the payout
 * somebody records on a Friday, through the same form and the same ceiling as
 * every other peso they are owed. There is deliberately no second payment
 * path: this feature adds a REASON for money to be owed, and nothing else.
 *
 * Which is also why the notification says "added to what TARA owes you" rather
 * than "paid". Telling a rider they have been paid when the transfer has not
 * happened is the kind of lie that costs a support conversation and some
 * trust.
 */

export interface PartnerRewardOutcome {
  referrerCentavos: number;
  refereeCentavos: number;
  /** True when this call is what settled the referral, either way. */
  settled: boolean;
}

const NOTHING: PartnerRewardOutcome = {
  referrerCentavos: 0,
  refereeCentavos: 0,
  settled: false,
};

/**
 * Settles the partner referral this delivery qualifies, if it qualifies one.
 *
 * Returns immediately for the overwhelmingly common case — a delivery by a
 * rider nobody invited, or one whose referral is already settled. That early
 * exit is one lookup on a unique index, which is the right cost to pay on
 * every completion for a feature most deliveries have nothing to do with.
 */
export async function payPartnerReferralForDelivery(
  order: Pick<Order, 'id' | 'assignedRiderId'>,
  client?: PrismaTransactionClient,
  now: Date = new Date(),
): Promise<PartnerRewardOutcome> {
  const db = client ?? prisma;
  if (!order.assignedRiderId) return NOTHING;

  const referral = await db.partnerReferral.findUnique({
    where: { refereeId: order.assignedRiderId },
    select: {
      id: true,
      referrerId: true,
      refereeId: true,
      status: true,
      referrer: {
        select: { id: true, userId: true, isSuspended: true, user: { select: { isBlocked: true } } },
      },
      referee: { select: { userId: true } },
    },
  });
  if (!referral || referral.status !== ReferralStatus.ATTRIBUTED) return NOTHING;

  const programme = await getPartnerProgramme(db);

  // Counted from the ORDERS, not from `FleetPartner.completedOrderCount`.
  // The column is maintained and would usually agree, but it is a cache and
  // this decision moves real money — so it reads the thing itself. The
  // completing order is already COMPLETED inside this transaction, so this
  // count includes the delivery that triggered it, which is what the
  // threshold means.
  const completedDeliveries = await db.order.count({
    where: { assignedRiderId: referral.refereeId, status: 'COMPLETED' },
  });

  const [rewardedThisMonth, rewardedEver] = await Promise.all([
    db.partnerReferral.count({
      where: {
        referrerId: referral.referrerId,
        status: ReferralStatus.REWARDED,
        rewardedAt: { gte: monthStart(now) },
      },
    }),
    db.partnerReferral.count({
      where: { referrerId: referral.referrerId, status: ReferralStatus.REWARDED },
    }),
  ]);

  const decision = rewardForPartnerReferral({
    programme,
    completedDeliveries,
    rewardedThisMonth,
    rewardedEver,
    referrerIsBlocked: referral.referrer.user.isBlocked,
    referrerIsSuspended: referral.referrer.isSuspended,
  });

  // Not there yet. The row stays ATTRIBUTED and the next delivery asks again.
  if (decision.referrerRefusal === 'NOT_ENOUGH_DELIVERIES') return NOTHING;

  if (paysNothing(decision)) {
    // Terminal, with the reason, rather than left ATTRIBUTED forever. Both
    // sides are told, and an operator can count how often each reason fires —
    // which is the only way to discover that a cap is set too low.
    const reason =
      PARTNER_REWARD_REFUSAL_TEXT[
        decision.referrerRefusal ?? decision.refereeRefusal ?? 'NOTHING_TO_PAY'
      ];

    const closed = await db.partnerReferral.updateMany({
      where: { id: referral.id, status: ReferralStatus.ATTRIBUTED },
      data: {
        status: ReferralStatus.NOT_REWARDED,
        blockedReason: reason,
        qualifyingOrderId: order.id,
        qualifyingDeliveryCount: completedDeliveries,
      },
    });
    if (closed.count !== 1) return NOTHING;

    await tell(referral.referrer.userId, 'REFERRER', 0, reason, referral.id, db, now);
    return { referrerCentavos: 0, refereeCentavos: 0, settled: true };
  }

  const claimed = await db.partnerReferral.updateMany({
    // A COMPARE-AND-SET, not a read-then-write, and this one was found by a
    // live-database script rather than reasoned out.
    //
    // Two of a rider's deliveries completing at the same moment both read
    // this row as ATTRIBUTED, and both went on to settle it. The database
    // trigger refused the second write, correctly — and the exception came
    // out of here, out of the completion transaction, and FAILED THE WHOLE
    // ORDER. A rider's delivery could not be completed because of a race
    // about a bonus, which is far worse than the bonus being missed.
    //
    // With the CAS the loser matches no row, returns quietly, and its
    // delivery completes. The trigger stays as the backstop it was meant to
    // be rather than the thing that breaks completions.
    where: { id: referral.id, status: ReferralStatus.ATTRIBUTED },
    data: {
      status: ReferralStatus.REWARDED,
      referrerRewardCentavos: decision.referrerCentavos,
      refereeRewardCentavos: decision.refereeCentavos,
      rewardedAt: now,
      qualifyingOrderId: order.id,
      qualifyingDeliveryCount: completedDeliveries,
      // A referral can be REWARDED and still have a refused side: the caps
      // belong to the referrer, and refusing the invited rider their bonus
      // because of something their inviter did would be a promise broken by
      // somebody else. The reason is kept so it can be explained.
      ...(decision.referrerRefusal
        ? { blockedReason: PARTNER_REWARD_REFUSAL_TEXT[decision.referrerRefusal] }
        : {}),
    },
  });
  if (claimed.count !== 1) return NOTHING;

  if (decision.referrerCentavos > 0) {
    await accrue(
      {
        fleetPartnerId: referral.referrerId,
        amountCentavos: decision.referrerCentavos,
        description: 'Bonus for a rider you invited',
        referralId: referral.id,
        side: 'referrer',
        qualifyingOrderId: order.id,
        completedDeliveries,
      },
      db,
    );
  }

  if (decision.refereeCentavos > 0) {
    await accrue(
      {
        fleetPartnerId: referral.refereeId,
        amountCentavos: decision.refereeCentavos,
        description: 'Welcome bonus for your first deliveries',
        referralId: referral.id,
        side: 'referee',
        qualifyingOrderId: order.id,
        completedDeliveries,
      },
      db,
    );
  }

  await tell(
    referral.referrer.userId,
    'REFERRER',
    decision.referrerCentavos,
    decision.referrerRefusal
      ? PARTNER_REWARD_REFUSAL_TEXT[decision.referrerRefusal]
      : null,
    referral.id,
    db,
    now,
  );
  if (decision.refereeCentavos > 0) {
    await tell(
      referral.referee.userId,
      'REFEREE',
      decision.refereeCentavos,
      null,
      referral.id,
      db,
      now,
    );
  }

  return {
    referrerCentavos: decision.referrerCentavos,
    refereeCentavos: decision.refereeCentavos,
    settled: true,
  };
}

/**
 * One bonus line on the settlement ledger.
 *
 * The idempotency key is per referral AND per side, so a retried completion
 * cannot pay either side twice — the ledger refuses a duplicate key outright,
 * which is the backstop to the status check above and to the database trigger
 * behind both.
 *
 * No `orderId`, on purpose: see `REFERRAL_BONUS` in the schema. The order goes
 * in the metadata, where it is a breadcrumb rather than a claim about whose
 * delivery it was.
 */
async function accrue(
  input: {
    fleetPartnerId: string;
    amountCentavos: number;
    description: string;
    referralId: string;
    side: 'referrer' | 'referee';
    qualifyingOrderId: string;
    completedDeliveries: number;
  },
  db: PrismaTransactionClient,
): Promise<void> {
  await recordSettlementEntry(
    {
      ref: { party: 'FLEET_PARTNER', fleetPartnerId: input.fleetPartnerId },
      type: SettlementEntryType.REFERRAL_BONUS,
      amountCentavos: input.amountCentavos,
      description: input.description,
      idempotencyKey: `partner-referral-${input.side}:${input.referralId}`,
      metadata: {
        partnerReferralId: input.referralId,
        side: input.side,
        qualifyingOrderId: input.qualifyingOrderId,
        qualifyingDeliveryCount: input.completedDeliveries,
      },
    },
    db,
  );
}

/**
 * Tells a rider what happened, either way.
 *
 * The refusal case is not silent, for the same reason the customer
 * programme's is not: somebody who shared a code and watched a friend deliver
 * twenty orders deserves to know why nothing arrived. "You had already earned
 * the most for one month" is an answer; silence turns a referral programme
 * into a support queue.
 *
 * Swallowed on failure, like every other enqueue in this codebase: losing a
 * notification is bad, losing the money it was about is worse.
 */
async function tell(
  userId: string,
  role: 'REFERRER' | 'REFEREE',
  amountCentavos: number,
  reason: string | null,
  referralId: string,
  db: PrismaTransactionClient,
  now: Date,
): Promise<void> {
  try {
    await enqueueNotification(
      {
        userId,
        kind: NotificationKind.PARTNER_REFERRAL_SETTLED,
        href: '/fleet/invite',
        context: {
          amountCentavos,
          inviteRole: role,
          ...(reason ? { reason } : {}),
        },
        dedupeKey: `partner-referral:${referralId}:${role}`,
        now,
      },
      db,
    );
  } catch {
    // See above.
  }
}
