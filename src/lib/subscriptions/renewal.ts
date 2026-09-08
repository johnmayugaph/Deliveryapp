import {
  NotificationKind,
  SubscriptionOrigin,
  SubscriptionStatus,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { LIVE_SUBSCRIPTION_STATUSES } from '@/lib/subscriptions/enrollment';
import { issueDueInvoiceFor } from '@/lib/subscriptions/billing';
import {
  INVOICE_LEAD_DAYS,
  RECOVERY_DAYS,
  decideLapse,
  invoiceState,
  isCollectable,
  manilaDateLabel,
} from '@/lib/subscriptions/billing-policy';

/**
 * The subscription billing sweep: raise the bills, then tidy what went unpaid.
 *
 * Nothing here grants benefits or takes them away in the moment. The pricing
 * engine already requires `status = ACTIVE` and `renewsAt > now`, so a lapsed
 * subscription stops conferring anything the instant it lapses, whether or not
 * this sweep has run. That ordering matters and is load-bearing: **the cron
 * tidies the record, it is not the thing standing between a customer and a
 * free delivery.** A cron that has not run for an hour must not hand out an
 * hour of unpaid benefits.
 *
 * Run from `npm run jobs:orders`, alongside the order timeouts.
 *
 * ### What changed when the rail landed
 *
 * The old version had a `canCharge` flag and a three-day PAST_DUE grace, and a
 * comment claiming the grace existed "so a card that fails on a Friday has the
 * weekend to be fixed before benefits stop". That sentence was not true: a
 * PAST_DUE subscription has a `renewsAt` in the past, so the pricing engine
 * refused it on both counts and no benefit survived the boundary by a second.
 * It had never fired, because PAID enrolment was refused for want of a
 * gateway, so it was one more plumbed-but-never-wired path.
 *
 * The fix is not to make the grace confer benefits — that would be giving away
 * the product on an unpaid month. It is to bill BEFORE the boundary, so the
 * customer pays while still inside the month they already paid for and there
 * is no window to have an opinion about. What survives of the grace is
 * `RECOVERY_DAYS`: how long a lapsed subscription can still be revived by
 * paying, which is a different and much smaller promise.
 */

/** Re-exported so the old name still resolves; see `RECOVERY_DAYS`. */
export const PAST_DUE_GRACE_DAYS = RECOVERY_DAYS;

export interface RenewalOutcome {
  subscriptionId: string;
  userId: string;
  planName: string;
  origin: SubscriptionOrigin;
  fromStatus: SubscriptionStatus;
  toStatus: SubscriptionStatus;
  reason: string;
}

export interface BillingSweepResult {
  /** Invoices raised on this pass. */
  issued: { subscriptionId: string; reference: string; amountCentavos: number }[];
  /** Subscriptions whose status moved. */
  transitions: RenewalOutcome[];
}

/**
 * Raises every bill that is due, and moves every subscription whose term has
 * run out.
 *
 * Idempotent in both halves: `issueInvoice` is keyed on the period, and every
 * transition either ends a row or moves it to a status this pass will not pick
 * up again.
 */
export async function sweepSubscriptionBilling(
  now: Date = new Date(),
): Promise<BillingSweepResult> {
  const live = await prisma.userSubscription.findMany({
    where: { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
    include: {
      plan: { select: { name: true, monthlyPriceCentavos: true } },
      invoices: { orderBy: { periodStart: 'desc' } },
    },
    orderBy: { renewsAt: 'asc' },
  });

  const issued: BillingSweepResult['issued'] = [];
  const transitions: RenewalOutcome[] = [];

  for (const subscription of live) {
    // ---- 1. Raise the bill, if it is time. -------------------------------
    //
    // Before the tidying, deliberately. A subscription inside its lead window
    // must get its invoice on this pass even if the same pass is about to
    // decide something about it, or a sweep that has not run for a week would
    // lapse somebody who was never billed.
    const raised = await issueDueInvoiceFor(
      {
        id: subscription.id,
        status: subscription.status,
        origin: subscription.origin,
        renewsAt: subscription.renewsAt,
        startedAt: subscription.startedAt,
        plan: subscription.plan,
      },
      now,
    );

    if (raised && !raised.alreadyExisted) {
      issued.push({
        subscriptionId: subscription.id,
        reference: raised.invoice.reference,
        amountCentavos: raised.invoice.amountCentavos,
      });
      await enqueueNotification({
        userId: subscription.userId,
        kind: NotificationKind.SUBSCRIPTION_INVOICE_DUE,
        href: '/plus',
        context: {
          planName: subscription.plan.name,
          invoiceReference: raised.invoice.reference,
          amountCentavos: raised.invoice.amountCentavos,
          dueLabel: manilaDateLabel(raised.invoice.dueAt),
        },
        dedupeKey: `subscription-invoice:${raised.invoice.id}`,
        now,
      });
    }

    // ---- 2. Decide what the subscription becomes. ------------------------
    //
    // Re-read the invoices including anything just raised, because whether a
    // collectable bill exists is exactly what decides between LAPSE and END.
    const invoices = raised?.alreadyExisted === false
      ? [raised.invoice, ...subscription.invoices]
      : subscription.invoices;

    const hasCollectableInvoice = invoices.some((invoice) =>
      isCollectable(invoiceState(invoice, now)),
    );

    const decision = decideLapse({
      status: subscription.status,
      origin: subscription.origin,
      renewsAt: subscription.renewsAt,
      hasCollectableInvoice,
      now,
    });

    if (decision.action === 'HOLD') continue;

    const toStatus =
      decision.action === 'LAPSE'
        ? SubscriptionStatus.PAST_DUE
        : SubscriptionStatus.EXPIRED;

    if (toStatus === subscription.status) continue;

    const isTerminal = toStatus === SubscriptionStatus.EXPIRED;

    await prisma.userSubscription.update({
      where: { id: subscription.id },
      data: {
        status: toStatus,
        // The record says the term ended when the term ended, not when the
        // cron happened to notice.
        endedAt: isTerminal ? subscription.renewsAt : null,
      },
    });

    // A terminal subscription's outstanding bill is no longer owed. Leaving it
    // collectable would keep chasing somebody for a plan they no longer have,
    // and would let a late payment silently resurrect an expired enrolment.
    if (isTerminal) {
      for (const invoice of invoices) {
        if (!isCollectable(invoiceState(invoice, now))) continue;
        await prisma.subscriptionInvoice.updateMany({
          where: { id: invoice.id, settledAt: null, voidedAt: null },
          data: {
            voidedAt: now,
            voidReason: `The subscription ended before this was paid: ${decision.reason}`,
          },
        });
      }
    }

    // Benefits stopped the moment the term lapsed, whether or not this sweep
    // had run. Saying so is the point: a customer who finds out at checkout
    // that free delivery is gone has been told by the worst possible
    // messenger.
    await enqueueNotification({
      userId: subscription.userId,
      kind: isTerminal
        ? NotificationKind.SUBSCRIPTION_ENDED
        : NotificationKind.SUBSCRIPTION_PAST_DUE,
      href: '/plus',
      context: {
        planName: subscription.plan.name,
        ...(isTerminal ? {} : { recoveryDays: RECOVERY_DAYS }),
      },
      dedupeKey: isTerminal
        ? `subscription-ended:${subscription.id}`
        : `subscription-past-due:${subscription.id}:${subscription.renewsAt.toISOString()}`,
      now,
    });

    transitions.push({
      subscriptionId: subscription.id,
      userId: subscription.userId,
      planName: subscription.plan.name,
      origin: subscription.origin,
      fromStatus: subscription.status,
      toStatus,
      reason: decision.reason,
    });
  }

  return { issued, transitions };
}

/**
 * The old entry point, kept so `run-order-maintenance` and its tests did not
 * have to change shape in the same commit as the billing rewrite.
 */
export async function sweepDueSubscriptions(
  now: Date = new Date(),
): Promise<RenewalOutcome[]> {
  const { transitions } = await sweepSubscriptionBilling(now);
  return transitions;
}

export { INVOICE_LEAD_DAYS, RECOVERY_DAYS };
