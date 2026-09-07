import {
  OrderActor,
  OrderStatus,
  PaymentStatus,
  type Order,
  type ServiceKey,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { transitionOrder } from '@/lib/orders/state-machine';
import { ALL_STATUS_TIMEOUTS } from '@/lib/orders/transitions';
import { grantCredit, refundToCredits } from '@/lib/wallet/ledger';
import { pruneSessions, pruneVerifications } from '@/lib/auth/prune';
import {
  sweepDueSubscriptions,
  type RenewalOutcome,
} from '@/lib/subscriptions/renewal';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { deliverPending, type DeliveryPassResult } from '@/lib/notifications/deliver';
import { NotificationKind } from '@prisma/client';
import {
  expireDispatchOffers,
  fanOutDispatchOffers,
  type FanOutResult,
} from '@/lib/fleet/dispatch-offers';
import {
  liftExpiredFreezes,
  markRecoveryAlertFailed,
  markRecoveryAlertSent,
  pendingRecoveryAlerts,
  recoveryAlertText,
} from '@/lib/auth/recovery';
import { pruneEmailCodes } from '@/lib/auth/email-codes';
import {
  markAnnounced,
  pendingLaunchAnnouncements,
} from '@/lib/services/interest';
import { getService } from '@/lib/services/registry';
import {
  administratorsToAlert,
  markErrorAlerted,
  unalertedErrorReports,
} from '@/lib/monitoring/queries';
import { alertAdministratorsOfWait } from '@/lib/support/tickets';
import {
  markTicketChased,
  ticketsNeedingChase,
} from '@/lib/support/queries';
import { describeWait, waitingMinutes } from '@/lib/support/policy';
import {
  markRatingsNotified,
  pendingRatingDigests,
} from '@/lib/ratings/reviews';
import { pruneExpiredInvites } from '@/lib/merchant/staff';
import { reportError } from '@/lib/monitoring/report';
import { ErrorSource } from '@prisma/client';
import { resolveSmsSender } from '@/lib/auth/sms';

/**
 * Scheduled order maintenance.
 *
 * Two jobs, both vertical-agnostic:
 *   - `expireStaleOrders()` acts on the timeout policies declared in
 *     `ORDER_LIFECYCLES`. It reads the flattened `ALL_STATUS_TIMEOUTS` and does
 *     not know that FOOD waits on a merchant or that PABILI waits on a budget
 *     approval — those are entries in the map.
 *   - `refundOrderCredits()` returns credits spent on an order that will never
 *     be delivered. Credits go back to CREDITS, never to cash: there is no rail
 *     out, by design.
 *
 * Run from cron: `npm run jobs:orders`, which also drives dispatch and prunes
 * spent login codes and dead sessions — see `runMaintenance()`.
 */

export interface ExpiredOrderResult {
  orderId: string;
  orderNumber: string;
  serviceType: ServiceKey;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  refundedCentavos: number;
}

/**
 * Returns credits spent on an order, if any, when that order ends without
 * being delivered.
 *
 * Idempotent: the ledger's `idempotencyKey` is derived from the order id, so a
 * job that runs twice refunds once. It reads the actual `ORDER_PAYMENT` rows
 * rather than trusting `Order.walletCreditAppliedCentavos`, because the ledger
 * is the truth about what was taken.
 */
export async function refundOrderCredits(
  input: { orderId: string; reason: string },
  client?: PrismaTransactionClient,
): Promise<number> {
  const db = client ?? prisma;

  const order = await db.order.findUniqueOrThrow({
    where: { id: input.orderId },
    select: { id: true, orderNumber: true, customerId: true },
  });

  const payments = await db.walletTransaction.aggregate({
    where: { relatedOrderId: order.id, type: 'ORDER_PAYMENT' },
    _sum: { amountCentavos: true },
  });
  // ORDER_PAYMENT rows are negative; the refund is their magnitude.
  const spentCentavos = Math.abs(payments._sum.amountCentavos ?? 0);
  if (spentCentavos === 0) {
    return 0;
  }

  const alreadyRefunded = await db.walletTransaction.aggregate({
    where: { relatedOrderId: order.id, type: 'REFUND' },
    _sum: { amountCentavos: true },
  });
  const outstanding = spentCentavos - (alreadyRefunded._sum.amountCentavos ?? 0);
  if (outstanding <= 0) {
    return 0;
  }

  await refundToCredits(
    {
      userId: order.customerId,
      orderId: order.id,
      amountCentavos: outstanding,
      description: `Refund · order ${order.orderNumber} · ${input.reason}`,
      idempotencyKey: `order-refund:${order.id}`,
    },
    client,
  );

  await db.order.update({
    where: { id: order.id },
    data: { paymentStatus: PaymentStatus.REFUNDED },
  });

  return outstanding;
}

/**
 * Moves orders that have sat too long in a waiting state, per the timeout
 * policies, and refunds any credits they consumed.
 *
 * Each order is handled in its own transaction: one order failing to expire
 * must not block the rest of the sweep.
 */
export async function expireStaleOrders(
  options: { now?: Date; limitPerPolicy?: number } = {},
): Promise<ExpiredOrderResult[]> {
  const now = options.now ?? new Date();
  const limit = options.limitPerPolicy ?? 200;
  const results: ExpiredOrderResult[] = [];

  for (const policy of ALL_STATUS_TIMEOUTS) {
    const cutoff = new Date(now.getTime() - policy.afterSeconds * 1_000);

    // `updatedAt` is a CONSERVATIVE filter, not the exact moment the order
    // entered this state: any later write moves it forward, never back. So an
    // order can be swept slightly late but never early, which is the right way
    // round for a policy that cancels people's orders. The exact wait is read
    // from the status-event trail below, for the audit record.
    const candidates = await prisma.order.findMany({
      where: {
        serviceType: policy.serviceType,
        status: policy.status,
        updatedAt: { lt: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      include: {
        statusEvents: {
          where: { toStatus: policy.status },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    for (const order of candidates) {
      try {
        const refundedCentavos = await prisma.$transaction(async (tx) => {
          await transitionOrder(
            {
              orderId: order.id,
              to: policy.to,
              actor: OrderActor.SYSTEM,
              reason: policy.reason,
              metadata: {
                expiredFrom: policy.status,
                timeoutSeconds: policy.afterSeconds,
                waitedSeconds: Math.round(
                  (now.getTime() - (order.statusEvents[0]?.createdAt ?? order.updatedAt).getTime()) /
                    1_000,
                ),
              },
            },
            tx,
          );

          const refunded = await refundOrderCredits(
            { orderId: order.id, reason: policy.reason },
            tx,
          );

          // The cancellation message says an order was cancelled; this one says
          // where the money went. Two events, because they are two facts, and a
          // customer whose credits came back should be able to see that on its
          // own row.
          if (refunded > 0) {
            await enqueueNotification(
              {
                userId: order.customerId,
                kind: NotificationKind.CREDITS_GRANTED,
                relatedOrderId: order.id,
                href: '/credits',
                context: {
                  creditsCentavos: refunded,
                  creditsReason: `Refund for ${order.orderNumber}.`,
                  orderNumber: order.orderNumber,
                },
                dedupeKey: `credits-refund:${order.id}`,
                now,
              },
              tx,
            );
          }

          return refunded;
        });

        results.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          serviceType: order.serviceType,
          fromStatus: policy.status,
          toStatus: policy.to,
          refundedCentavos,
        });
      } catch (error) {
        // Another actor probably moved the order between our read and the
        // transition — the merchant accepted just in time. That is the guard
        // working, not a failure to report.
        console.warn(
          `expireStaleOrders: skipped ${order.orderNumber}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  return results;
}

/**
 * Completes a delivered order and grants any credit-back its subscription
 * benefits accrued.
 *
 * Credit-back is not a discount: the customer paid full price at checkout, and
 * the credits arrive here, on completion, through the ledger. Idempotent by
 * order id, so a retry cannot double-grant.
 */
export async function completeOrder(input: {
  orderId: string;
  actor?: OrderActor;
  actorUserId?: string;
}): Promise<{ order: Order; creditBackCentavos: number }> {
  return prisma.$transaction(async (tx) => {
    const order = await transitionOrder(
      {
        orderId: input.orderId,
        to: OrderStatus.COMPLETED,
        actor: input.actor ?? OrderActor.SYSTEM,
        actorUserId: input.actorUserId,
      },
      tx,
    );

    const accrued = await tx.orderAppliedBenefit.aggregate({
      where: { orderId: order.id },
      _sum: { creditBackCentavos: true },
    });
    const creditBackCentavos = accrued._sum.creditBackCentavos ?? 0;

    if (creditBackCentavos > 0) {
      await grantCredit(
        {
          userId: order.customerId,
          type: 'PROMO_CREDIT',
          amountCentavos: creditBackCentavos,
          description: `Credits back · order ${order.orderNumber}`,
          idempotencyKey: `credit-back:${order.id}`,
        },
        tx,
      );

      await enqueueNotification(
        {
          userId: order.customerId,
          kind: NotificationKind.CREDITS_GRANTED,
          relatedOrderId: order.id,
          href: '/credits',
          context: {
            creditsCentavos: creditBackCentavos,
            creditsReason: `Credits back on order ${order.orderNumber}.`,
            orderNumber: order.orderNumber,
          },
          dedupeKey: `credits-back:${order.id}`,
        },
        tx,
      );
    }

    // A completed cash order has been paid by definition.
    if (order.paymentStatus === PaymentStatus.PENDING) {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentStatus: PaymentStatus.PAID },
      });
    }

    return { order, creditBackCentavos };
  });
}

/**
 * Everything the cron job does, in one call.
 *
 * Housekeeping for authentication lives here rather than in its own job because
 * the two run on the same cadence and neither is worth a second scheduler entry:
 * spent login codes and expired sessions are not needed once dead, and a table
 * of hashed codes and address fingerprints is not something to accumulate.
 */
export interface RecoveryAlertResult {
  sent: number;
  failed: number;
  /** True when no gateway is configured, so nothing was attempted. */
  unconfigured: boolean;
}

/**
 * Tells the OLD number that the account moved.
 *
 * This is here rather than in the notification outbox for one reason: the
 * outbox resolves every recipient from the user row, and the user row now
 * holds the NEW number. Sending this through the outbox would deliver the
 * "your account was taken over" warning to whoever took it over.
 *
 * So the recovery row carries `previousPhone` — the only place the old number
 * survives — and this sends to it directly. It is the one message in the
 * system that goes to a number no account has.
 *
 * A failure is recorded rather than retried. The number was lost, which is why
 * a recovery happened at all, so undeliverable is the expected case and a row
 * that says so is more useful than a queue that never drains.
 */
export async function sendRecoveryAlerts(): Promise<RecoveryAlertResult> {
  const pending = await pendingRecoveryAlerts();
  if (pending.length === 0) {
    return { sent: 0, failed: 0, unconfigured: false };
  }

  let sender;
  try {
    sender = resolveSmsSender();
  } catch {
    // No gateway. The rows stay pending — marking them failed would throw away
    // the alert for a reason that has nothing to do with the alert.
    return { sent: 0, failed: 0, unconfigured: true };
  }

  let sent = 0;
  let failed = 0;
  for (const recovery of pending) {
    try {
      await sender.send({
        to: recovery.previousPhone,
        body: recoveryAlertText(recovery),
      });
      await markRecoveryAlertSent(recovery.id);
      sent += 1;
    } catch (error) {
      await markRecoveryAlertFailed(
        recovery.id,
        error instanceof Error ? error.message : String(error),
      );
      failed += 1;
    }
  }

  return { sent, failed, unconfigured: false };
}

export interface LaunchAnnouncementResult {
  announced: number;
  failed: number;
}

/**
 * Tells everybody who asked for a vertical that it is now live where they are.
 *
 * The payoff for the coming-soon tiles: a tap is not only a number on an
 * admin screen, it is a promise to come back. Nothing else in the product
 * makes that promise, so nothing else would keep it.
 *
 * Through the outbox, unlike the recovery alert — the recipient is the account
 * holder, the current phone number is the right one, and the kind is push and
 * inbox only, so a launch never costs a peso per person.
 *
 * Bounded per pass. A city launch can have thousands of people waiting and
 * this runs on the same cron as the order timeouts; a pass that tries to
 * notify everybody would delay work somebody is actually waiting on. The
 * remainder goes out on the next pass, a minute later.
 */
export async function announceLaunchedServices(): Promise<LaunchAnnouncementResult> {
  const pending = await pendingLaunchAnnouncements();
  if (pending.length === 0) {
    return { announced: 0, failed: 0 };
  }

  // City names for the copy. One query for the pass rather than one per
  // recipient, which on a launch day is the difference between two queries and
  // two hundred.
  const cityIds = [...new Set(pending.map((row) => row.cityId))];
  const cities = await prisma.city.findMany({
    where: { id: { in: cityIds } },
    select: { id: true, name: true },
  });
  const cityNameById = new Map(cities.map((city) => [city.id, city.name] as const));

  let announced = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const service = await getService(row.serviceKey);
      await enqueueNotification({
        userId: row.userId,
        kind: NotificationKind.SERVICE_NOW_AVAILABLE,
        context: {
          serviceName: service.displayName,
          ...(cityNameById.has(row.cityId)
            ? { cityName: cityNameById.get(row.cityId)! }
            : {}),
        },
        href: `/services/${row.serviceKey.toLowerCase()}`,
        // The interest row, so a service that is switched off and on again
        // cannot tell the same person twice about the same request.
        dedupeKey: `service-live:${row.interestId}`,
      });
      // Marked told even when the enqueue collapsed onto an existing row:
      // somebody has already been told, which is the same outcome.
      await markAnnounced(row.interestId);
      announced += 1;
    } catch (error) {
      // One bad row must not stop the rest of the pass, and it must not be
      // marked told — it will be retried next time.
      console.error('announceLaunchedServices: failed', row.interestId, error);
      failed += 1;
    }
  }

  return { announced, failed };
}

export interface ErrorAlertResult {
  faults: number;
  admins: number;
}

/**
 * Tells the administrators about faults nobody has seen yet.
 *
 * On the cron rather than at the moment of the error, for the same reason the
 * launch announcements are: the request that just failed is not the place to
 * start a fan-out, and a page that broke should not then hang while we notify
 * four people about it. A minute's delay costs nothing here — the fault has
 * already happened.
 *
 * One alert per distinct fault, ever, enforced by `alertedAt`. That is the
 * property that makes this usable: an error loop with ten thousand
 * occurrences is one notification, and an administrator who mutes this channel
 * because it cried wolf is worse off than one with no monitoring at all.
 */
export async function alertOnNewErrors(): Promise<ErrorAlertResult> {
  const faults = await unalertedErrorReports();
  if (faults.length === 0) {
    return { faults: 0, admins: 0 };
  }

  const admins = await administratorsToAlert();

  for (const fault of faults) {
    // Marked told even when there is nobody to tell. Otherwise the first
    // administrator to be created would be greeted with every fault since the
    // deployment began, which is not news — it is an inbox nobody reads.
    try {
      for (const admin of admins) {
        await enqueueNotification({
          userId: admin.id,
          kind: NotificationKind.ERROR_DETECTED,
          context: {
            errorKind: fault.kind,
            ...(fault.route === null ? {} : { errorRoute: fault.route }),
          },
          href: '/admin/errors',
          dedupeKey: `error-alert:${fault.id}:${admin.id}`,
        });
      }
      await markErrorAlerted(fault.id);
    } catch (error) {
      // A failure here must not stop the rest of the sweep, and must not
      // silently vanish — so it goes through the reporter, which is the one
      // place in this file that cannot recurse into itself: reportError
      // swallows its own failures.
      await reportError(error, {
        source: ErrorSource.CRON,
        route: 'alertOnNewErrors',
      });
    }
  }

  return { faults: faults.length, admins: admins.length };
}

export interface SupportChaseResult {
  chased: number;
  admins: number;
}

/**
 * Chases the tickets nobody has answered.
 *
 * Every administrator was already told the moment each ticket was raised — see
 * `createSupportTicket`. This is the second message, and the one that does the
 * work: the first alert arrives while somebody is busy, and nothing in a
 * notification inbox says "this is still true two hours later".
 *
 * Marked chased even when there is nobody to tell, for the same reason error
 * alerts are: otherwise the first administrator ever created is greeted with
 * every ticket since the deployment began.
 */
export async function chaseWaitingTickets(
  now: Date = new Date(),
): Promise<SupportChaseResult> {
  const waiting = await ticketsNeedingChase(now);
  if (waiting.length === 0) {
    return { chased: 0, admins: 0 };
  }

  let admins = 0;
  for (const ticket of waiting) {
    try {
      admins = await alertAdministratorsOfWait({
        ticket,
        waitLabel: describeWait(waitingMinutes({ since: ticket.createdAt, now })),
      });
      await markTicketChased(ticket.id);
    } catch (error) {
      // Never stops the rest of the sweep, and never vanishes. `reportError`
      // swallows its own failures, so this cannot recurse.
      await reportError(error, {
        source: ErrorSource.CRON,
        route: 'chaseWaitingTickets',
      });
    }
  }

  return { chased: waiting.length, admins };
}

export interface RatingDigestResult {
  digests: number;
  recipients: number;
  ratings: number;
  failed: number;
}

/**
 * Tells shops and riders that customers have rated them.
 *
 * ONE MESSAGE PER SUBJECT covering everything since the last one, not one per
 * rating — see `RATING_DIGEST_DELAY_MINUTES`. A shop with a good lunch would
 * otherwise get thirty notifications, learn to swipe them away, and miss the
 * one that mattered.
 *
 * The digest carries the count, the average and the LOWEST score, and never
 * the customer's words. A comment is text somebody typed about a person and a
 * notification lands on a lock screen, which is the wrong place to read it and
 * the wrong place for somebody else to read it. The screens have the words.
 *
 * Marked told even when the enqueue collapsed onto an existing row: somebody
 * has already been told, which is the same outcome. A batch that fails is left
 * un-notified and picked up next pass — a rating nobody hears about is a
 * missed message, and telling them twice about the same one is worse.
 */
export async function sendRatingDigests(
  now: Date = new Date(),
): Promise<RatingDigestResult> {
  const pending = await pendingRatingDigests(now);
  if (pending.length === 0) {
    return { digests: 0, recipients: 0, ratings: 0, failed: 0 };
  }

  let digests = 0;
  let recipients = 0;
  let ratings = 0;
  let failed = 0;

  for (const batch of pending) {
    try {
      for (const userId of batch.recipientIds) {
        await enqueueNotification({
          userId,
          kind: NotificationKind.RATINGS_RECEIVED,
          context: {
            ratingCount: batch.digest.count,
            ratingAverage: batch.digest.average,
            ratingLowest: batch.digest.lowest,
            ratingSubject:
              batch.subject === 'STORE' ? `the food at ${batch.label}` : batch.label,
          },
          href:
            batch.subject === 'STORE'
              ? `/merchant/${batch.subjectId}/history`
              : '/fleet/profile',
          // The newest review in the batch, so a digest is unique to the set
          // it covered — a retried pass cannot send the same summary twice,
          // and a later batch is a different key rather than a collision.
          dedupeKey: `ratings:${batch.subject}:${batch.subjectId}:${
            batch.reviewIds[batch.reviewIds.length - 1]
          }:${userId}`,
        });
        recipients += 1;
      }
      await markRatingsNotified({
        subject: batch.subject,
        reviewIds: batch.reviewIds,
        now,
      });
      digests += 1;
      ratings += batch.digest.count;
    } catch (error) {
      await reportError(error, {
        source: ErrorSource.CRON,
        route: 'sendRatingDigests',
      });
      failed += 1;
    }
  }

  return { digests, recipients, ratings, failed };
}

export async function runMaintenance(): Promise<{
  expiredOffers: number;
  dispatched: FanOutResult[];
  expired: ExpiredOrderResult[];
  subscriptions: RenewalOutcome[];
  launchAnnouncements: LaunchAnnouncementResult;
  errorAlerts: ErrorAlertResult;
  supportChases: SupportChaseResult;
  ratingDigests: RatingDigestResult;
  notifications: DeliveryPassResult;
  recoveryAlerts: RecoveryAlertResult;
  liftedFreezes: number;
  prunedVerifications: number;
  prunedSessions: number;
  prunedEmailCodes: number;
  prunedStoreInvites: number;
}> {
  // Order matters. Lapsed offers are closed first so the fan-out sees accurate
  // live counts; dispatch runs before the timeout sweep so an order that just
  // found a partner is not cancelled a second later for having no partner.
  const expiredOffers = await expireDispatchOffers();
  const dispatched = await fanOutDispatchOffers();
  const expired = await expireStaleOrders();
  // Subscriptions are swept after the order work: a lapsed subscription already
  // grants nothing (the pricing engine checks `renewsAt`), so this is
  // record-keeping and can wait behind anything a customer is watching.
  const subscriptions = await sweepDueSubscriptions();
  // Before the delivery pass, so a launch announcement enqueued here goes out
  // in the same run rather than waiting a minute for the next one.
  const launchAnnouncements = await announceLaunchedServices();
  // Also before the delivery pass, so a fault recorded a minute ago reaches
  // somebody on this run rather than the next one.
  const errorAlerts = await alertOnNewErrors();
  // Same reasoning: a customer who has been waiting two hours should not wait
  // for the next pass to have that noticed.
  const supportChases = await chaseWaitingTickets();
  // Also before the delivery pass. Nothing is waiting on a ratings digest, but
  // there is no reason to hold it back a whole interval either.
  const ratingDigests = await sendRatingDigests();
  // Last, so that everything this pass enqueued goes out in the same run: a
  // store hearing about an order one cron interval later than it was placed is
  // the cost of having no worker, and there is no reason to make it two.
  const notifications = await deliverPending();

  // Security alerts go out AFTER the notification pass rather than through it,
  // and they are not batched behind anything: see `sendRecoveryAlerts`.
  const recoveryAlerts = await sendRecoveryAlerts();
  // Tidying, not enforcement — the ledger computes the freeze from
  // `frozenUntil` on every spend, so this only makes the column and the
  // screens agree with what the ledger already does.
  const liftedFreezes = await liftExpiredFreezes();

  const prunedVerifications = await pruneVerifications();
  const prunedSessions = await pruneSessions();
  const prunedEmailCodes = await pruneEmailCodes();
  // An expired invite already redeems nothing — `redeemStoreInvites` filters
  // on the expiry — so this is tidying, not enforcement.
  const prunedStoreInvites = await pruneExpiredInvites();

  return {
    expiredOffers,
    dispatched,
    expired,
    subscriptions,
    launchAnnouncements,
    errorAlerts,
    supportChases,
    ratingDigests,
    notifications,
    recoveryAlerts,
    liftedFreezes,
    prunedVerifications,
    prunedSessions,
    prunedEmailCodes,
    prunedStoreInvites,
  };
}
