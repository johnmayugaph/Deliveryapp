#!/usr/bin/env tsx
/**
 * Order maintenance sweep, for cron.
 *
 *     npm run jobs:orders
 *
 * Expires orders that have waited too long in a state their vertical's
 * lifecycle declares a timeout for, and refunds any credits they consumed.
 * Safe to run frequently: it is idempotent and bounded per policy.
 */
import { expireStaleOrders } from '../src/lib/orders/maintenance';
import { prisma } from '../src/lib/prisma';
import { formatCentavos } from '../src/lib/money';

async function main() {
  const expired = await expireStaleOrders();

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
