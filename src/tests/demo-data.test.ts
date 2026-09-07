import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_DATABASE_HOSTS,
  databaseHostLooksLocal,
  demoDataIsUsable,
  describeDatabaseHost,
  seedRefusalReason,
  signInIsPermitted,
  SIGN_IN_REFUSED_MESSAGE,
} from '@/lib/demo/policy';

/**
 * The demo data, and why it cannot be allowed to matter.
 *
 * `prisma/seed.ts` writes six accounts on real Philippine number formats, one
 * of them holding ADMIN. Everything in this file is about the two ways that
 * stops being dangerous: the rows cannot be signed into in production, and the
 * seed refuses to write them anywhere it was not clearly asked to.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

/** Source with comments blanked out, for rules asserted by position or absence. */
function codeOnly(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

/** Just the fields the policy reads. */
function account(fields: { isBlocked?: boolean; isDemo?: boolean }) {
  return { isBlocked: fields.isBlocked ?? false, isDemo: fields.isDemo ?? false };
}

describe('when demo data counts', () => {
  it('is usable in development, in test, and with no NODE_ENV at all', () => {
    expect(demoDataIsUsable('development')).toBe(true);
    expect(demoDataIsUsable('test')).toBe(true);
    expect(demoDataIsUsable(undefined)).toBe(true);
  });

  it('is not usable in production', () => {
    expect(demoDataIsUsable('production')).toBe(false);
  });

  it('treats only the exact string as production', () => {
    // A near miss must fail SAFE — which here means "not production", because
    // the alternative is a deployment that silently keeps the seeded admin
    // usable. So these are deliberately checked, not assumed.
    expect(demoDataIsUsable('Production')).toBe(true);
    expect(demoDataIsUsable('prod')).toBe(true);
    expect(demoDataIsUsable('staging')).toBe(true);
  });
});

describe('who may hold a session', () => {
  it('lets an ordinary account in', () => {
    expect(signInIsPermitted(account({}), 'production')).toBe(true);
    expect(signInIsPermitted(account({}), 'development')).toBe(true);
  });

  it('refuses a blocked account in every runtime', () => {
    expect(signInIsPermitted(account({ isBlocked: true }), 'production')).toBe(false);
    expect(signInIsPermitted(account({ isBlocked: true }), 'development')).toBe(false);
  });

  it('refuses a demo account in production', () => {
    // The whole point. 0917 000 9999 holds ADMIN in the seed, and somebody
    // owns that number in real life.
    expect(signInIsPermitted(account({ isDemo: true }), 'production')).toBe(false);
  });

  it('allows a demo account outside production, because that is what it is for', () => {
    expect(signInIsPermitted(account({ isDemo: true }), 'development')).toBe(true);
    expect(signInIsPermitted(account({ isDemo: true }), undefined)).toBe(true);
  });

  it('refuses a blocked demo account outside production too', () => {
    expect(
      signInIsPermitted(account({ isDemo: true, isBlocked: true }), 'development'),
    ).toBe(false);
  });

  it('says nothing about which rule refused', () => {
    // A stranger who happens to own a seeded number must not learn from the
    // screen that the account is special. Blocked and demo read identically.
    expect(SIGN_IN_REFUSED_MESSAGE).not.toMatch(/demo/i);
    expect(SIGN_IN_REFUSED_MESSAGE).not.toMatch(/block/i);
    expect(SIGN_IN_REFUSED_MESSAGE).not.toMatch(/seed/i);
  });
});

describe('recognising a local database', () => {
  it('accepts the usual local connection strings', () => {
    expect(databaseHostLooksLocal('postgresql://postgres@localhost:5432/tara')).toBe(true);
    expect(
      databaseHostLooksLocal('postgresql://postgres@127.0.0.1:5433/tara?schema=public'),
    ).toBe(true);
    expect(databaseHostLooksLocal('postgresql://postgres@[::1]:5432/tara')).toBe(true);
  });

  it('accepts what a database container is called in every compose file', () => {
    expect(databaseHostLooksLocal('postgresql://postgres@db:5432/tara')).toBe(true);
    expect(databaseHostLooksLocal('postgresql://postgres@postgres:5432/tara')).toBe(true);
    expect(databaseHostLooksLocal('postgresql://u@host.docker.internal:5432/t')).toBe(true);
  });

  it('rejects a managed host', () => {
    expect(
      databaseHostLooksLocal('postgresql://u:p@ep-cool-name-123.eu-central-1.aws.neon.tech/db'),
    ).toBe(false);
    expect(databaseHostLooksLocal('postgresql://u:p@db.example.com:5432/tara')).toBe(false);
  });

  it('rejects a hostname that merely contains a local one', () => {
    // "localhost.attacker.example" is not localhost.
    expect(databaseHostLooksLocal('postgresql://u@localhost.example.com/tara')).toBe(false);
    expect(databaseHostLooksLocal('postgresql://u@not-localhost/tara')).toBe(false);
  });

  it('rejects nothing and nonsense', () => {
    expect(databaseHostLooksLocal(undefined)).toBe(false);
    expect(databaseHostLooksLocal('')).toBe(false);
    expect(databaseHostLooksLocal('not a url at all')).toBe(false);
  });

  it('is case-insensitive about the host', () => {
    expect(databaseHostLooksLocal('postgresql://u@LOCALHOST:5432/tara')).toBe(true);
  });

  it('keeps the allowed list to hosts that are somebody own machine', () => {
    // A guard on the guard: adding a public hostname here would quietly open
    // the seed to a real deployment.
    for (const host of LOCAL_DATABASE_HOSTS) {
      expect(host).not.toMatch(/\.(com|net|org|ph|io|dev|tech|cloud)$/);
    }
  });
});

describe('where the seed may write', () => {
  const local = 'postgresql://postgres@127.0.0.1:5433/tara';

  it('permits a local database in development', () => {
    expect(seedRefusalReason({ nodeEnv: 'development', databaseUrl: local })).toBeNull();
  });

  it('refuses when NODE_ENV is production, whatever the host', () => {
    const reason = seedRefusalReason({ nodeEnv: 'production', databaseUrl: local });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/NODE_ENV/);
  });

  it('refuses a remote database even with no NODE_ENV', () => {
    // The likelier mistake by far: a terminal with a production DATABASE_URL
    // exported and nothing else set.
    const reason = seedRefusalReason({
      nodeEnv: undefined,
      databaseUrl: 'postgresql://u:p@db.example.com:5432/tara',
    });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/db\.example\.com/);
  });

  it('refuses when there is no DATABASE_URL', () => {
    expect(seedRefusalReason({ nodeEnv: 'development' })).not.toBeNull();
  });

  it('says why in terms of what would land', () => {
    const reason = seedRefusalReason({ nodeEnv: 'production', databaseUrl: local }) ?? '';
    expect(reason).toMatch(/administrator/);
  });

  it('lets --force past both checks', () => {
    // A check with no way past it gets deleted rather than respected.
    expect(
      seedRefusalReason({
        nodeEnv: 'production',
        databaseUrl: 'postgresql://u:p@db.example.com:5432/tara',
        force: true,
      }),
    ).toBeNull();
  });

  it('never puts credentials in the refusal', () => {
    const reason =
      seedRefusalReason({
        nodeEnv: undefined,
        databaseUrl: 'postgresql://admin:sup3rsecret@db.example.com:5432/tara',
      }) ?? '';
    expect(reason).not.toMatch(/sup3rsecret/);
    expect(reason).not.toMatch(/admin:/);
  });

  it('describes a host without leaking the password', () => {
    expect(describeDatabaseHost('postgresql://admin:sup3rsecret@db.example.com:5432/t')).toBe(
      'db.example.com:5432',
    );
    expect(describeDatabaseHost(undefined)).toMatch(/unset/);
    expect(describeDatabaseHost('nonsense')).not.toMatch(/nonsense/);
  });
});

/**
 * Everything below reads source rather than behaviour, because these are
 * invariants a future edit breaks silently. Each one has already been the
 * mistake it now prevents, or is one keystroke away from it.
 */
describe('the seed marks everything it writes', () => {
  const seed = source('prisma/seed.ts');

  /**
   * The body of every `prisma.<model>.upsert({...})` call, by balanced braces.
   *
   * A regex cannot do this: the argument contains nested objects, and matching
   * to the first `}` would find `isDemo` in the wrong block or miss it in the
   * right one.
   */
  function upsertBodies(model: string): string[] {
    const needle = `prisma.${model}.upsert(`;
    const bodies: string[] = [];
    let from = 0;
    for (;;) {
      const start = seed.indexOf(needle, from);
      if (start === -1) break;
      let depth = 0;
      let index = start + needle.length;
      for (; index < seed.length; index += 1) {
        const char = seed[index];
        if (char === '(' || char === '{') depth += 1;
        else if (char === ')' || char === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      bodies.push(seed.slice(start, index + 1));
      from = index + 1;
    }
    return bodies;
  }

  it('finds the accounts and stores it is supposed to check', () => {
    // If the seed stops using upsert, this whole describe block would pass by
    // examining nothing. Fail instead.
    expect(upsertBodies('user').length).toBeGreaterThanOrEqual(3);
    expect(upsertBodies('store').length).toBeGreaterThanOrEqual(1);
  });

  it('marks every seeded account isDemo, on create AND on update', () => {
    for (const body of upsertBodies('user')) {
      expect(body).toMatch(/isDemo:\s*true/);
      // Twice: once in `create`, once in `update`. A database seeded before
      // the column existed is only marked when the seed runs again.
      expect(body.match(/isDemo:\s*true/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('marks every seeded store isDemo', () => {
    // The store loop marks one object and uses it for both create and update,
    // so the check follows that indirection rather than looking for the
    // literal inside the call — a store added to the list above cannot miss
    // the flag, because the flag is not written per store.
    expect(seed).toMatch(/const demoStore = \{ \.\.\.storeData, isDemo: true \};/);
    for (const body of upsertBodies('store')) {
      expect(body).toMatch(/create: demoStore/);
      expect(body).toMatch(/update: demoStore/);
    }
  });

  it('checks its target before writing anything', () => {
    expect(seed).toMatch(/assertSeedTargetIsAllowed\(\);/);
    // First statement of main(), so no query can precede the refusal.
    expect(seed).toMatch(/async function main\(\) \{\n\s*assertSeedTargetIsAllowed\(\);/);
  });
});

describe('the sign-in gate is in both places', () => {
  it('is checked where a session is read back, not only at login', () => {
    // A cookie outlives the deploy that created it.
    expect(source('src/lib/auth/session.ts')).toMatch(/signInIsPermitted\(session\.user\)/);
  });

  it('is checked at login', () => {
    expect(source('src/lib/auth/login.ts')).toMatch(/signInIsPermitted\(user\)/);
  });

  it('leaves no second, divergent copy of the rule', () => {
    // Both files used to test `isBlocked` directly. One policy function now
    // decides, so neither should reach for the column again.
    expect(source('src/lib/auth/login.ts')).not.toMatch(/\.isBlocked/);
    expect(source('src/lib/auth/session.ts')).not.toMatch(/\.isBlocked/);
  });
});

describe('the purge can only remove what it listed', () => {
  const purge = source('scripts/purge-demo.ts');

  it('selects only demo rows', () => {
    expect(purge).toMatch(/where: \{ isDemo: true \}/);
  });

  it('deletes only the ids it listed, never by predicate', () => {
    // A `deleteMany({ where: { isDemo: true } })` would be one edit away from
    // `{ isDemo: false }`. Keying every delete on the id arrays gathered for
    // the summary means what the operator confirmed is exactly what goes.
    const deletes = purge.match(/deleteMany\(\{[^}]*\}/g) ?? [];
    expect(deletes.length).toBeGreaterThan(0);
    for (const call of deletes) {
      expect(call).toMatch(/\{ in: (userIds|storeIds) \}/);
    }
  });

  it('opts into the append-only hatch for one transaction only', () => {
    expect(purge).toMatch(/SET LOCAL tara\.allow_purge/);
    expect(purge).not.toMatch(/SET tara\.allow_purge/);
  });

  it('does nothing without --confirm', () => {
    expect(purge).toMatch(/--confirm/);
    expect(purge).toMatch(/Nothing was removed/);
  });

  /**
   * Two failures found by putting this command in CI, where it ran against
   * seeded data for the first time. Both made the purge do nothing at all
   * while looking like it had been written.
   */
  it('deletes orders before people', () => {
    // `Order.customerId` is RESTRICT, which is right for production — nobody
    // should be able to erase the order history a store and a rider were part
    // of by deleting a customer. It also means a plain user delete fails for
    // anybody who has ever ordered, which is every real customer.
    const orders = purge.indexOf('order.deleteMany');
    const users = purge.indexOf('user.deleteMany');
    expect(orders).toBeGreaterThan(0);
    expect(orders).toBeLessThan(users);
  });

  it('keeps an account the credits ledger names, and says why', () => {
    // A demo administrator who corrected somebody's credits is named on that
    // ADJUSTMENT row, and the database requires them to stay named. Deleting
    // the row instead would change what a real customer is owed in order to
    // tidy up a demo account.
    expect(purge).toMatch(/WalletTransactionType\.ADJUSTMENT/);
    expect(purge).toMatch(/heldByLedger/);
    expect(source('scripts/purge-demo.ts')).toMatch(/KEPT, because the credits ledger/);
  });

  it('makes the same ordering true of the single-account purge', () => {
    // Comments stripped: the explanation above the code quotes `DELETE FROM
    // "User"` while saying why it is not enough on its own, and a plain
    // indexOf finds the explanation first.
    const single = codeOnly('scripts/purge-user.ts');
    const orders = single.indexOf('DELETE FROM "Order"');
    const users = single.indexOf('DELETE FROM "User"');
    expect(orders).toBeGreaterThan(0);
    expect(orders).toBeLessThan(users);
  });
});

describe('the admin grant', () => {
  const grant = source('scripts/grant-admin.ts');

  it('will not create an account', () => {
    // The account exists because somebody signed in with that number, which
    // is the only proof available that they hold the phone.
    expect(grant).not.toMatch(/user\.create\(/);
    expect(grant).not.toMatch(/user\.upsert\(/);
  });

  it('writes an audit row in the same transaction as the change', () => {
    expect(grant).toMatch(/\$transaction/);
    expect(grant).toMatch(/recordAdminAction/);
  });

  it('insists on a reason', () => {
    expect(grant).toMatch(/normaliseReason/);
  });

  it('refuses an account that could not use the role anyway', () => {
    expect(grant).toMatch(/signInIsPermitted/);
  });
});
