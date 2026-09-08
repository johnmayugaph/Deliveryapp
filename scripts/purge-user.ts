#!/usr/bin/env tsx
/**
 * Removes an account and everything referencing it, permanently.
 *
 *     npm run db:purge-user -- 09171234567
 *     npm run db:purge-user -- 09171234567 --confirm
 *
 * This is NOT how an account ends in normal operation. Blocking is how an
 * account ends: it stops the person signing in, keeps the order history for
 * the stores and riders who were part of it, and keeps the credits ledger,
 * which is a financial record. Use `/admin` for that.
 *
 * This exists for the two cases blocking does not cover:
 *
 *   - a lawful erasure request, where the obligation is to remove the data
 *     rather than to retain it, and
 *   - resetting a development or test database, where the append-only tables
 *     otherwise make a seeded account permanent.
 *
 * It works by opting into the escape hatch the append-only triggers check —
 * `SET LOCAL tara.allow_purge` — inside a single transaction, which is the
 * only way those triggers can be satisfied. `SET LOCAL` cannot outlive the
 * COMMIT, so the hatch cannot be left open, and it appears in the statement
 * log next to what it permitted.
 *
 * What goes: the account, its orders, its credits ledger, its recovery
 * history, its sessions, its notifications, its addresses. What stays: rows
 * that belong to somebody else and merely mention this person — an
 * `AdminAuditEvent` whose ACTOR was this account is retained, because it is
 * the record of what an administrator did to other people.
 */
import { prisma } from '../src/lib/prisma';
import {
  InvalidPhoneNumberError,
  formatPhilippineMobile,
  normalisePhilippineMobile,
} from '../src/lib/auth/phone';

function usage(): never {
  console.error(
    [
      'Usage: npm run db:purge-user -- <philippine-mobile> [--confirm]',
      '',
      'Without --confirm it prints what WOULD be removed and stops.',
      '',
      'Blocking an account is almost always what you want instead — it keeps',
      'the order history and the credits ledger. Use /admin for that.',
    ].join('\n'),
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (positional.length !== 1) usage();

  let phone: string;
  try {
    phone = normalisePhilippineMobile(positional[0]!);
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      console.error(`Not a Philippine mobile number: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  const user = await prisma.user.findUnique({
    where: { phone },
    select: {
      id: true,
      phone: true,
      fullName: true,
      roles: true,
      createdAt: true,
      wallet: { select: { balanceCentavos: true, _count: { select: { transactions: true } } } },
      _count: {
        select: {
          orders: true,
          addresses: true,
          sessions: true,
          notifications: true,
          recoveries: true,
          supportTickets: true,
          adminActions: true,
          storeMemberships: true,
        },
      },
    },
  });

  if (!user) {
    console.error(`No account with ${formatPhilippineMobile(phone)}.`);
    process.exit(1);
  }

  console.log('');
  console.log(`  ${user.fullName ?? '(no name)'}  ${formatPhilippineMobile(user.phone)}`);
  console.log(`  roles:   ${user.roles.join(', ')}`);
  console.log(`  joined:  ${user.createdAt.toISOString().slice(0, 10)}`);
  console.log('');
  console.log('  Would remove:');
  console.log(`    ${user._count.orders} order(s)`);
  console.log(`    ${user.wallet?._count.transactions ?? 0} credits ledger row(s)`);
  console.log(`    ${user._count.recoveries} number change(s)`);
  console.log(`    ${user._count.addresses} address(es)`);
  console.log(`    ${user._count.notifications} notification(s)`);
  console.log(`    ${user._count.sessions} session(s)`);
  console.log(`    ${user._count.supportTickets} support ticket(s)`);
  console.log('');

  if (user.wallet && user.wallet.balanceCentavos > 0) {
    console.log(
      `  This account holds an unspent balance of ${user.wallet.balanceCentavos} centavos.\n` +
        '  Purging destroys the ledger that explains it.',
    );
    console.log('');
  }
  if (user._count.adminActions > 0) {
    console.log(
      `  KEPT: ${user._count.adminActions} audit entr(ies) where this account was the\n` +
        '  ADMINISTRATOR. Those describe what was done to other people and are not\n' +
        '  this account’s data to erase — the purge will fail if they exist, which\n' +
        '  is correct. Reassign or retain them deliberately.',
    );
    console.log('');
  }
  if (user._count.storeMemberships > 0) {
    console.log(
      `  NOTE: ${user._count.storeMemberships} store membership(s) go too. If this is a\n` +
        '  store’s only owner, that store becomes unmanageable.',
    );
    console.log('');
  }

  if (!confirm) {
    console.log('  Nothing was removed. Add --confirm to go ahead.');
    console.log('');
    return;
  }

  await prisma.$transaction(async (tx) => {
    // The escape hatch the append-only triggers check. Transaction-scoped, so
    // it cannot leak past this COMMIT.
    await tx.$executeRawUnsafe(`SET LOCAL tara.allow_purge = 'on'`);
    // Orders BEFORE people.
    //
    // `Order.customerId` is RESTRICT rather than CASCADE, and that is right for
    // production: nobody should be able to remove a customer and silently erase
    // the order history that a store and a rider were part of. It also means a
    // plain `DELETE FROM "User"` fails for anybody who has ever ordered — which
    // is every real customer, and it is why the demo purge did nothing but throw a
    // foreign-key error until CI ran it against seeded data.
    //
    // So the deletion is explicit here, in the one tool whose whole purpose is
    // to override that intent. Deleting an order cascades to its addresses,
    // status events, applied benefits and dispatch offers, and nulls the
    // references from wallet transactions and support tickets.
    //
    // Referral rows go FIRST, and this one is not tidiness — it is the
    // difference between an erasure request working and failing.
    //
    // Both referral tables point at the order that paid them with
    // `onDelete: SetNull`, and both have a CHECK saying a REWARDED row must
    // name that order (`referral_reward_names_its_order`,
    // `partner_referral_reward_names_its_delivery`). Those two facts
    // contradict each other exactly here: nulling the column is what the FK
    // does when the order goes, and it is what the CHECK forbids. The purge
    // transaction failed on a constraint violation for anybody who had ever
    // been referred and whose first order paid their referrer — which is the
    // successful case of the referral feature.
    //
    // Found by a live-database script for the rider programme, in the
    // customer programme it had been latent in for four phases.
    //
    // Deleting the rows is the right answer rather than relaxing the CHECK: a
    // referral row is personal data about TWO people — who invited whom —
    // so erasing one of them has to take the link with it. What the money did
    // is not lost, because it lives in the credits ledger and the settlement
    // ledger, which keep their rows and their descriptions.
    await tx.$executeRaw`
      DELETE FROM "PartnerReferral"
      WHERE "qualifyingOrderId" IN (
        SELECT id FROM "Order" WHERE "customerId" = ${user.id}
      )
    `;
    await tx.$executeRaw`
      DELETE FROM "Referral"
      WHERE "qualifyingOrderId" IN (
        SELECT id FROM "Order" WHERE "customerId" = ${user.id}
      )
    `;
    await tx.$executeRaw`DELETE FROM "Order" WHERE "customerId" = ${user.id}`;
    await tx.$executeRaw`DELETE FROM "User" WHERE id = ${user.id}`;
  });

  console.log(`  Purged ${formatPhilippineMobile(phone)}. This cannot be undone.`);
  console.log('');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
