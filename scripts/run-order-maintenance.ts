#!/usr/bin/env tsx
/**
 * Order maintenance sweep, for cron.
 *
 *     npm run jobs:orders
 *
 * Does four things, in order: closes dispatch offers nobody answered, offers
 * waiting orders to their best candidates, expires orders that have waited too
 * long in a state their lifecycle declares a timeout for (refunding any credits
 * they consumed), and prunes spent login codes and dead sessions.
 *
 * Dispatch has no background worker, so how quickly a partner sees an offer is
 * bounded by how often this runs. Every minute or two is right.
 * Safe to run frequently: it is idempotent and bounded per policy.
 */
import { runMaintenance } from '../src/lib/orders/maintenance';
import { prisma } from '../src/lib/prisma';
import { formatCentavos } from '../src/lib/money';

async function main() {
  const { expiredOffers, dispatched, expired, prunedVerifications, prunedSessions } =
    await runMaintenance();

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

  if (prunedVerifications > 0 || prunedSessions > 0) {
    console.log(
      `Pruned ${prunedVerifications} login code(s) and ${prunedSessions} dead session(s).`,
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
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
