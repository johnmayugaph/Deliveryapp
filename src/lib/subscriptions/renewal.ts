import {
  NotificationKind,
  SubscriptionOrigin,
  SubscriptionStatus,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { LIVE_SUBSCRIPTION_STATUSES } from '@/lib/subscriptions/enrollment';
import { isPaidEnrollmentAvailable } from '@/lib/subscriptions/payment';

/**
 * What happens to a subscription when its month runs out.
 *
 * Nothing here grants benefits or takes them away in the moment: the pricing
 * engine already requires `renewsAt > now`, so a lapsed subscription stops
 * conferring anything the instant it lapses, whether or not this sweep has run.
 * That ordering matters — the cron tidies the record, it is not the thing
 * standing between a customer and a free delivery. A cron that has not run for
 * an hour must not hand out an hour of unpaid benefits.
 *
 * Run from `npm run jobs:orders`, alongside the order timeouts.
 */

/**
 * How long a paid subscription stays live after a failed renewal.
 *
 * Three days, so a card that fails on a Friday has the weekend to be fixed
 * before benefits stop.
 */
export const PAST_DUE_GRACE_DAYS = 3;

export interface RenewalOutcome {
  subscriptionId: string;
  userId: string;
  planName: string;
  origin: SubscriptionOrigin;
  fromStatus: SubscriptionStatus;
  toStatus: SubscriptionStatus;
  reason: string;
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Decides what a due subscription becomes.
 *
 * Pure, so the policy is testable without a database — and so the two origins
 * that behave differently are visible in one place rather than spread across a
 * query.
 */
export function decideRenewal(input: {
  origin: SubscriptionOrigin;
  status: SubscriptionStatus;
  renewsAt: Date;
  now: Date;
  canCharge: boolean;
}): { toStatus: SubscriptionStatus; reason: string } {
  // A grant does not renew itself. Giving someone a second free month is a
  // decision somebody should make on purpose, the same way approving a fleet
  // partner for a second service is.
  if (input.origin !== SubscriptionOrigin.PAID) {
    return {
      toStatus: SubscriptionStatus.EXPIRED,
      reason: 'A granted subscription ends at its term; re-granting is deliberate.',
    };
  }

  if (!input.canCharge) {
    // Unreachable while no gateway exists, because PAID enrollment is refused
    // at the door. Written out anyway: the day a provider lands, this is the
    // path a failed charge takes, and it should already be right.
    if (
      input.status === SubscriptionStatus.PAST_DUE &&
      input.now >= addDays(input.renewsAt, PAST_DUE_GRACE_DAYS)
    ) {
      return {
        toStatus: SubscriptionStatus.EXPIRED,
        reason: `Renewal unpaid for more than ${PAST_DUE_GRACE_DAYS} days.`,
      };
    }
    return {
      toStatus: SubscriptionStatus.PAST_DUE,
      reason: 'Renewal could not be charged.',
    };
  }

  return {
    toStatus: SubscriptionStatus.ACTIVE,
    reason: 'Renewed.',
  };
}

/**
 * Moves every subscription whose term has run out to whatever it should become.
 *
 * Idempotent: a row is only read when its `renewsAt` has passed, and every
 * outcome either ends the row or moves it to PAST_DUE, so a second run in the
 * same minute finds nothing new to do.
 */
export async function sweepDueSubscriptions(
  now: Date = new Date(),
): Promise<RenewalOutcome[]> {
  const due = await prisma.userSubscription.findMany({
    where: {
      status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
      renewsAt: { lte: now },
    },
    include: { plan: { select: { name: true } } },
    orderBy: { renewsAt: 'asc' },
  });

  const canCharge = isPaidEnrollmentAvailable();
  const outcomes: RenewalOutcome[] = [];

  for (const subscription of due) {
    const { toStatus, reason } = decideRenewal({
      origin: subscription.origin,
      status: subscription.status,
      renewsAt: subscription.renewsAt,
      now,
      canCharge,
    });

    if (toStatus === subscription.status) {
      continue;
    }

    const isTerminal =
      toStatus === SubscriptionStatus.EXPIRED || toStatus === SubscriptionStatus.CANCELLED;

    await prisma.userSubscription.update({
      where: { id: subscription.id },
      data: {
        status: toStatus,
        // The record says the term ended when the term ended, not when the cron
        // happened to notice.
        endedAt: isTerminal ? subscription.renewsAt : null,
      },
    });

    // Benefits stopped the moment the term lapsed, whether or not this sweep had
    // run. Saying so is the point: a customer who finds out at checkout that
    // free delivery is gone has been told by the worst possible messenger.
    if (isTerminal) {
      await enqueueNotification({
        userId: subscription.userId,
        kind: NotificationKind.SUBSCRIPTION_ENDED,
        href: '/plus',
        context: { planName: subscription.plan.name },
        dedupeKey: `subscription-ended:${subscription.id}`,
        now,
      });
    }

    outcomes.push({
      subscriptionId: subscription.id,
      userId: subscription.userId,
      planName: subscription.plan.name,
      origin: subscription.origin,
      fromStatus: subscription.status,
      toStatus,
      reason,
    });
  }

  return outcomes;
}
