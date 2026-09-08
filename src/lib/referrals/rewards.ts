import { NotificationKind, ReferralStatus, type Order } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { grantCredit } from '@/lib/wallet/ledger';
import { getProgramme } from '@/lib/referrals/programme';
import { grossOrderCentavos } from '@/lib/settlement/policy';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import {
  REWARD_REFUSAL_TEXT,
  rewardForReferral,
  type RewardRefusal,
} from '@/lib/referrals/policy';

/**
 * Paying the person who did the inviting.
 *
 * Only when the referee's FIRST order completes, and only above the programme's
 * minimum. That asymmetry against the referee's grant is the feature's main
 * defence: a person farming their own SIM cards has to buy and receive a real
 * order for every account, so the question of whether it pays becomes
 * arithmetic on the amounts an operator chose — which `farmerMargin` puts on
 * their screen.
 *
 * Nothing here is best-effort. It runs inside the completion transaction, so a
 * completed order and the reward it earned either both happen or neither does;
 * and it is idempotent on the referral row, so a retried completion cannot pay
 * twice.
 */

export interface RewardOutcome {
  paidCentavos: number;
  refusal: RewardRefusal | null;
  /** True when this call is what settled the referral. */
  settled: boolean;
}

const NOTHING: RewardOutcome = { paidCentavos: 0, refusal: null, settled: false };

/** First of the calendar month in Manila, which is when a monthly cap resets. */
export function monthStart(now: Date): Date {
  // Manila is UTC+8 with no daylight saving, so the local month boundary is a
  // fixed offset from the UTC one. Doing this with UTC arithmetic rather than
  // a locale string keeps it testable.
  const manila = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  return new Date(
    Date.UTC(manila.getUTCFullYear(), manila.getUTCMonth(), 1) -
      8 * 60 * 60 * 1_000,
  );
}

/**
 * Settles the referral this order qualifies, if it qualifies one.
 *
 * Returns without doing anything for the overwhelmingly common case — an order
 * by somebody nobody referred, or by a referee whose referral is already
 * settled. That early exit is one indexed lookup, which is the right cost to
 * pay on every completion for a feature most orders have nothing to do with.
 */
export async function payReferrerForOrder(
  order: Pick<
    Order,
    | 'id'
    | 'customerId'
    | 'subtotalCentavos'
    | 'deliveryFeeCentavos'
    | 'serviceFeeCentavos'
    | 'smallOrderFeeCentavos'
    | 'surgeCentavos'
    | 'tipCentavos'
    | 'totalCentavos'
  >,
  client?: PrismaTransactionClient,
  now: Date = new Date(),
): Promise<RewardOutcome> {
  const db = client ?? prisma;

  const referral = await db.referral.findUnique({
    where: { refereeId: order.customerId },
    select: {
      id: true,
      referrerId: true,
      status: true,
      referrer: { select: { isBlocked: true } },
    },
  });
  // Nobody invited them, or their referral is already settled either way.
  if (!referral || referral.status !== ReferralStatus.ATTRIBUTED) return NOTHING;

  const programme = await getProgramme(db);

  const [rewardedThisMonth, rewardedEver] = await Promise.all([
    db.referral.count({
      where: {
        referrerId: referral.referrerId,
        status: ReferralStatus.REWARDED,
        referrerRewardedAt: { gte: monthStart(now) },
      },
    }),
    db.referral.count({
      where: { referrerId: referral.referrerId, status: ReferralStatus.REWARDED },
    }),
  ]);

  const decision = rewardForReferral({
    programme,
    // The order's own worth, NOT what the customer paid after credits —
    // otherwise a referee could spend their welcome credits to drop the order
    // under the minimum and cost their referrer the reward.
    orderCentavos: grossOrderCentavos(order),
    rewardedThisMonth,
    rewardedEver,
    referrerIsBlocked: referral.referrer.isBlocked,
  });

  if (decision.refusal !== null) {
    // A terminal NOT_REWARDED with its reason, rather than leaving the row
    // ATTRIBUTED forever. The referrer is told, and an operator can count how
    // often each reason fires — which is the only way to find out that a
    // minimum is set too high.
    await db.referral.update({
      where: { id: referral.id },
      data: {
        status: ReferralStatus.NOT_REWARDED,
        blockedReason: REWARD_REFUSAL_TEXT[decision.refusal],
        qualifyingOrderId: order.id,
      },
    });
    await tellReferrer(referral.referrerId, decision.refusal, 0, db, now);
    return { paidCentavos: 0, refusal: decision.refusal, settled: true };
  }

  await db.referral.update({
    where: { id: referral.id },
    data: {
      status: ReferralStatus.REWARDED,
      referrerRewardCentavos: decision.payCentavos,
      referrerRewardedAt: now,
      qualifyingOrderId: order.id,
    },
  });

  await grantCredit(
    {
      userId: referral.referrerId,
      type: 'REFERRAL_BONUS',
      amountCentavos: decision.payCentavos,
      description: 'Credits for an invite that ordered',
      // One payment per referral, ever. A retried completion re-enters this
      // function, finds the row REWARDED and returns early — but the key is
      // the belt to that brace, and the thing that holds if two completions
      // race.
      idempotencyKey: `referral-referrer:${referral.id}`,
      metadata: {
        referralId: referral.id,
        refereeId: order.customerId,
        qualifyingOrderId: order.id,
      },
    },
    db,
  );

  await tellReferrer(referral.referrerId, null, decision.payCentavos, db, now);
  return { paidCentavos: decision.payCentavos, refusal: null, settled: true };
}

/**
 * Tells the referrer what happened, either way.
 *
 * The refusal case is deliberately not silent. Somebody who shared a code and
 * watched a friend order deserves to know why nothing arrived — "their first
 * order was below the minimum" is an answer, and an unexplained absence is how
 * a referral programme becomes a support queue.
 *
 * Swallowed on failure for the reason every enqueue in this codebase is: losing
 * a notification is bad, losing the reward it was about is worse.
 */
async function tellReferrer(
  referrerId: string,
  refusal: RewardRefusal | null,
  paidCentavos: number,
  db: PrismaTransactionClient,
  now: Date,
): Promise<void> {
  try {
    await enqueueNotification(
      {
        userId: referrerId,
        kind: NotificationKind.REFERRAL_SETTLED,
        href: '/invite',
        context: {
          amountCentavos: paidCentavos,
          ...(refusal ? { reason: REWARD_REFUSAL_TEXT[refusal] } : {}),
        },
        dedupeKey: `referral-settled:${referrerId}:${now.getTime()}`,
        now,
      },
      db,
    );
  } catch {
    // See above.
  }
}
