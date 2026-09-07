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
import { UserRole } from '@prisma/client';
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
          select: { orders: true, sessions: true, adminActions: true, storeMemberships: true },
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

  const userIds = users.map((user) => user.id);
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
