#!/usr/bin/env tsx
/**
 * Removes every row `prisma/seed.ts` created, permanently.
 *
 *     npm run db:purge-demo
 *     npm run db:purge-demo -- --confirm
 *
 * This is the first thing to run against a deployment that real people will
 * reach. The seed creates six accounts on real Philippine number formats — one
 * of them an ADMIN — and four restaurants with invented prices that a customer
 * can order from and nobody will cook.
 *
 * Demo accounts already cannot hold a session in production (see
 * `src/lib/demo/policy.ts`), so forgetting this is not a security hole any
 * more. It is still wrong: the stores are visible, they are orderable, and the
 * numbers belong to strangers.
 *
 * What goes: every `User` and every `Store` marked `isDemo`, with everything
 * that cascades from them — orders, ledgers, menus, memberships, sessions.
 *
 * What stays: cities, services, delivery-fee rules, the subscription plan and
 * the FAQ. Those are configuration that a real deployment wants, not invented
 * people, and the seed is the intended way to install them.
 *
 * Audit entries written BY a demo administrator need `--and-audit` as well.
 * They are the record of what was done to other rows, which is not the actor's
 * to erase — so the purge names them and stops rather than deciding.
 *
 * Like `db:purge-user`, this works by opting into the escape hatch the
 * append-only triggers check — `SET LOCAL tara.allow_purge` — inside one
 * transaction. `SET LOCAL` cannot outlive the COMMIT, so the hatch cannot be
 * left open, and it appears in the statement log next to what it permitted.
 */
import { UserRole, WalletTransactionType } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { describeDatabaseHost } from '../src/lib/demo/policy';
import { formatPhilippineMobile } from '../src/lib/auth/phone';

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const andAudit = args.includes('--and-audit');

  const [users, stores] = await Promise.all([
    prisma.user.findMany({
      where: { isDemo: true },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        phone: true,
        fullName: true,
        roles: true,
        wallet: { select: { balanceCentavos: true } },
        _count: {
          select: {
            orders: true,
            sessions: true,
            adminActions: true,
            storeMemberships: true,
            // Cascades with the account. Reported because a purge report that
            // does not mention data it is about to delete understates itself —
            // and a support thread is a conversation somebody had.
            supportTickets: true,
          },
        },
      },
    }),
    prisma.store.findMany({
      where: { isDemo: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        cityId: true,
        _count: { select: { menuItems: true, members: true } },
      },
    }),
  ]);

  console.log('');
  console.log(`  Database: ${describeDatabaseHost(process.env.DATABASE_URL)}`);
  console.log('');

  if (users.length === 0 && stores.length === 0) {
    console.log('  No demo data. Nothing to do.');
    console.log('');
    return;
  }

  console.log(`  ${users.length} demo account(s):`);
  for (const user of users) {
    const parts = [
      `${user._count.orders} order(s)`,
      `${user._count.sessions} session(s)`,
    ];
    if (user._count.storeMemberships > 0) {
      parts.push(`${user._count.storeMemberships} store membership(s)`);
    }
    if (user._count.supportTickets > 0) {
      parts.push(`${user._count.supportTickets} support thread(s)`);
    }
    console.log(
      `    ${formatPhilippineMobile(user.phone)}  ${user.fullName ?? '(no name)'}` +
        `  [${user.roles.join(', ')}]`,
    );
    console.log(`      ${parts.join(', ')}`);
    if (user._count.adminActions > 0) {
      console.log(
        `      ${user._count.adminActions} audit entr(ies) where this account was the` +
          ' ADMINISTRATOR (see below)',
      );
    }
  }
  console.log('');

  console.log(`  ${stores.length} demo store(s):`);
  for (const store of stores) {
    console.log(
      `    ${store.name}  (${store.slug}, ${store.cityId})` +
        `  ${store._count.menuItems} menu item(s), ${store._count.members} member(s)`,
    );
  }
  console.log('');

  const realUsers = await prisma.user.count({ where: { isDemo: false } });
  const realStores = await prisma.store.count({ where: { isDemo: false } });
  console.log(`  Kept: ${realUsers} real account(s), ${realStores} real store(s),`);
  console.log('        and all cities, services, fee rules, plans and FAQ content.');
  console.log('');

  const survivingAdmins = await prisma.user.count({
    where: { isDemo: false, isBlocked: false, roles: { has: UserRole.ADMIN } },
  });
  if (survivingAdmins === 0) {
    console.log('  WARNING: after this there is no administrator account at all.');
    console.log('  Nobody will be able to open /admin. Make one first, or straight');
    console.log('  afterwards, on a number you control:');
    console.log('');
    console.log('    npm run admin:grant -- 09171234567 --reason "first admin, launch"');
    console.log('');
  }

  /**
   * Accounts the ledger will not let go of.
   *
   * A demo administrator who has ever corrected somebody's credits is named on
   * that ADJUSTMENT row, and `wallet_transaction_adjustment_needs_admin`
   * requires it to stay named — so the SET NULL that a delete would perform is
   * refused by the database. That is the ledger working: an adjustment nobody
   * can be held to is an adjustment nobody can audit.
   *
   * Deleting the ledger row instead is not an option. It may be an adjustment
   * to a REAL customer's balance, and removing it would quietly change what
   * they are owed to tidy up a demo account.
   *
   * So those accounts are kept, named, and explained. In production they
   * cannot be signed into anyway — `isDemo` refuses them a session — so what
   * is left is untidiness rather than exposure, and blocking is the right
   * ending for them.
   */
  const adjustmentActors = await prisma.walletTransaction.groupBy({
    by: ['adminUserId'],
    where: {
      adminUserId: { in: users.map((user) => user.id) },
      type: WalletTransactionType.ADJUSTMENT,
    },
    _count: { _all: true },
  });
  const heldByLedger = new Map(
    adjustmentActors.flatMap((row) =>
      row.adminUserId === null ? [] : [[row.adminUserId, row._count._all] as const],
    ),
  );

  if (heldByLedger.size > 0) {
    console.log('  KEPT, because the credits ledger names them:');
    for (const user of users) {
      const count = heldByLedger.get(user.id);
      if (count === undefined) continue;
      console.log(
        `    ${formatPhilippineMobile(user.phone)}  ${user.fullName ?? '(no name)'}` +
          ` — recorded ${count} credits adjustment(s)`,
      );
    }
    console.log('');
    console.log('  An ADJUSTMENT must name the administrator who made it, and the');
    console.log('  database enforces that. Removing the row instead would change what');
    console.log('  a real customer is owed in order to tidy up a demo account, so it');
    console.log('  is not done. Block these accounts in /admin instead — and note that');
    console.log('  in production they cannot hold a session at all.');
    console.log('');
  }

  const userIds = users
    .filter((user) => !heldByLedger.has(user.id))
    .map((user) => user.id);
  const storeIds = stores.map((store) => store.id);

  // Audit rows whose ACTOR is a demo account.
  //
  // These are the one thing here that is not simply invented data: an audit
  // entry describes what an administrator did to somebody else, and the whole
  // design of that table is that it is not the actor's to erase. So it is a
  // separate decision, made out loud — without the flag the purge stops here
  // rather than failing halfway through with a foreign-key error nobody can
  // read.
  const auditByDemoAdmins =
    userIds.length === 0
      ? 0
      : await prisma.adminAuditEvent.count({ where: { actorId: { in: userIds } } });


  if (auditByDemoAdmins > 0) {
    console.log(
      `  ${auditByDemoAdmins} audit entr(ies) were written BY a demo account.`,
    );
    console.log('  An audit entry records what an administrator did to somebody else,');
    console.log('  so it is not the actor’s data to erase and the purge will not');
    console.log('  assume. On a database that only ever held demo data this is demo');
    console.log('  activity too, and removing it is right:');
    console.log('');
    console.log('    npm run db:purge-demo -- --confirm --and-audit');
    console.log('');
    if (!andAudit) {
      console.log('  Nothing was removed.');
      console.log('');
      return;
    }
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
    if (andAudit && userIds.length > 0) {
      // First: the row references the actor, so it has to go before they do.
      await tx.adminAuditEvent.deleteMany({ where: { actorId: { in: userIds } } });
    }
    if (userIds.length > 0) {
  // Orders BEFORE people.
  //
  // `Order.customerId` is RESTRICT rather than CASCADE, and that is right for
  // production: nobody should be able to remove a customer and silently erase
  // the order history that a store and a rider were part of. It also means a
  // plain `DELETE FROM "User"` fails for anybody who has ever ordered — which
  // is every real customer, and it is why this purge did nothing but throw a
  // foreign-key error until CI ran it against seeded data.
  //
  // So the deletion is explicit here, in the one tool whose whole purpose is
  // to override that intent. Deleting an order cascades to its addresses,
  // status events, applied benefits and dispatch offers, and nulls the
  // references from wallet transactions and support tickets.
      // And the referral rows that name those orders, before the orders. Both
      // referral tables point at the order that paid them with SetNull, and
      // both have a CHECK requiring a REWARDED row to name it — so nulling
      // the column is exactly what the FK does and exactly what the CHECK
      // forbids. See the longer note in `purge-user.ts`.
      const demoOrders = await tx.order.findMany({
        where: { customerId: { in: userIds } },
        select: { id: true },
      });
      const demoOrderIds = demoOrders.map((order) => order.id);
      await tx.partnerReferral.deleteMany({
        where: { qualifyingOrderId: { in: demoOrderIds } },
      });
      await tx.referral.deleteMany({
        where: { qualifyingOrderId: { in: demoOrderIds } },
      });
      await tx.order.deleteMany({ where: { customerId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (storeIds.length > 0) {
      // After the accounts, so a membership row does not outlive its person.
      await tx.store.deleteMany({ where: { id: { in: storeIds } } });
    }
  });

  console.log(
    `  Purged ${userIds.length} account(s) and ${storeIds.length} store(s)` +
      (andAudit && auditByDemoAdmins > 0
        ? `, and ${auditByDemoAdmins} audit entr(ies)`
        : '') +
      (heldByLedger.size > 0
        ? `. Kept ${heldByLedger.size} the ledger names, as above`
        : '') +
      '. This cannot be undone.',
  );
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
