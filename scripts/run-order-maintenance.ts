#!/usr/bin/env tsx
/**
 * Order maintenance sweep, for cron.
 *
 *     npm run jobs:orders
 *
 * Closes dispatch offers nobody answered, offers waiting orders to their best
 * candidates, expires orders that have waited too long in a state their
 * lifecycle declares a timeout for (refunding any credits they consumed), ends
 * subscriptions whose term has run out, tells anybody who asked for a vertical
 * that it is now live where they are, delivers whatever is waiting in the
 * notification outbox, and prunes spent login codes and dead sessions.
 *
 * Dispatch has no background worker, so how quickly a partner sees an offer is
 * bounded by how often this runs. Every minute or two is right.
 * Safe to run frequently: it is idempotent and bounded per policy.
 */
import { ErrorSource } from '@prisma/client';
import { runMaintenance } from '../src/lib/orders/maintenance';
import { prisma } from '../src/lib/prisma';
import { formatCentavos } from '../src/lib/money';
import { reportError } from '../src/lib/monitoring/report';

async function main() {
  const {
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
  } = await runMaintenance();

  if (expiredOffers > 0) {
    console.log(`Expired ${expiredOffers} unanswered dispatch offer(s).`);
  }
  for (const result of dispatched) {
    if (result.noCandidates) {
      console.log(`${result.orderNumber}: no approved partner online in range.`);
    } else {
      console.log(`${result.orderNumber}: offered to ${result.offersCreated} partner(s).`);
    }
  }

  for (const result of subscriptions) {
    console.log(
      `Subscription ${result.subscriptionId} (${result.origin}): ` +
        `${result.fromStatus} -> ${result.toStatus} — ${result.reason}`,
    );
  }

  if (errorAlerts.faults > 0) {
    console.log(
      `Errors: told ${errorAlerts.admins} administrator(s) about ` +
        `${errorAlerts.faults} newly seen fault(s). See /admin/errors.`,
    );
  }

  if (supportChases.chased > 0) {
    console.log(
      `Support: ${supportChases.chased} ticket(s) still unanswered past the ` +
        `target — told ${supportChases.admins} administrator(s). See /admin/support.`,
    );
  }

  if (ratingDigests.digests > 0 || ratingDigests.failed > 0) {
    console.log(
      `Ratings: ${ratingDigests.ratings} rating(s) summarised into ` +
        `${ratingDigests.digests} digest(s) for ${ratingDigests.recipients} ` +
        'recipient(s)' +
        (ratingDigests.failed > 0 ? `, ${ratingDigests.failed} to retry` : '') +
        '.',
    );
  }

  if (launchAnnouncements.announced > 0 || launchAnnouncements.failed > 0) {
    console.log(
      `Launch announcements: told ${launchAnnouncements.announced} person(s) that a ` +
        'service they asked for is now live' +
        (launchAnnouncements.failed > 0
          ? `, ${launchAnnouncements.failed} to retry next pass`
          : ''),
    );
  }

  const { sent, failed, retrying, skipped, unconfigured, notes } = notifications;
  if (sent > 0 || failed > 0 || retrying > 0 || skipped > 0) {
    console.log(
      `Notifications: ${sent} sent` +
        (retrying > 0 ? `, ${retrying} retrying` : '') +
        (skipped > 0 ? `, ${skipped} skipped (nothing to deliver to)` : '') +
        (failed > 0 ? `, ${failed} gave up` : ''),
    );
  }
  for (const note of notes) {
    console.log(`  ${note}`);
  }
  if (unconfigured.length > 0) {
    console.log(
      `Notifications waiting on an unconfigured channel: ${unconfigured.join(', ')}. ` +
        'They stay queued rather than being thrown away.',
    );
  }

  if (recoveryAlerts.unconfigured) {
    console.log(
      'Account-recovery alerts are waiting on an SMS gateway. They stay queued: ' +
        'the alert to a number an account no longer has is the whole point.',
    );
  } else if (recoveryAlerts.sent > 0 || recoveryAlerts.failed > 0) {
    console.log(
      `Recovery alerts: ${recoveryAlerts.sent} sent to previous numbers` +
        (recoveryAlerts.failed > 0
          ? `, ${recoveryAlerts.failed} undeliverable (expected — the number was lost)`
          : ''),
    );
  }

  if (liftedFreezes > 0) {
    console.log(`Lifted ${liftedFreezes} expired credits freeze(s).`);
  }

  if (
    prunedVerifications > 0 ||
    prunedSessions > 0 ||
    prunedEmailCodes > 0 ||
    prunedStoreInvites > 0
  ) {
    console.log(
      `Pruned ${prunedVerifications} login code(s), ${prunedEmailCodes} email code(s), ` +
        `${prunedSessions} dead session(s) and ${prunedStoreInvites} lapsed store ` +
        'invitation(s).',
    );
  }

  if (expired.length === 0) {
    console.log('No stale orders.');
    return;
  }

  for (const result of expired) {
    const refund =
      result.refundedCentavos > 0
        ? `, refunded ${formatCentavos(result.refundedCentavos)} to credits`
        : '';
    console.log(
      `${result.orderNumber} (${result.serviceType}): ` +
        `${result.fromStatus} -> ${result.toStatus}${refund}`,
    );
  }
  console.log(`Expired ${expired.length} order(s).`);
}

main()
  .catch(async (error) => {
    // The sweep failing is the error nobody is present for: no screen, no
    // customer, and — before this — no record beyond a line in a log file
    // that a cron daemon may or may not have kept. It is also the error with
    // the widest consequences, since a sweep that stops means orders stop
    // moving. So it is recorded like any other, and then still exits non-zero
    // so the scheduler notices.
    console.error(error);
    await reportError(error, {
      source: ErrorSource.CRON,
      route: 'jobs:orders',
    });
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
