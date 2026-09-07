import type { User } from '@prisma/client';

/**
 * What demo data is allowed to do.
 *
 * `prisma/seed.ts` creates six accounts and four stores so that a fresh clone
 * has something to click. Every one of those accounts uses a real Philippine
 * number format, and one of them — 0917 000 9999 — holds ADMIN. Whoever owns
 * that number in real life can request a login code for it, because the login
 * flow has no way to know the row was invented.
 *
 * That is the whole problem this module exists to remove, and it removes it in
 * the only way that survives being forgotten: a row marked `isDemo` cannot be
 * signed into in production, whatever else is true about it. Purging the demo
 * data is still the right thing to do — `npm run db:purge-demo` — but a
 * deployment where somebody skipped that step is now merely untidy instead of
 * wide open.
 *
 * Everything here is a pure function of its inputs, including the environment,
 * so the rules can be tested at every value rather than at whichever one the
 * test runner happens to have.
 */

/**
 * Whether demo rows are usable in this runtime.
 *
 * Deliberately the narrowest possible check: only a literal `production`
 * disables them. A staging deployment that sets NODE_ENV=production gets the
 * production behaviour, which is correct — staging is where you find out.
 */
export function demoDataIsUsable(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== 'production';
}

/**
 * The one sentence anybody refused a sign-in sees.
 *
 * Identical for a blocked account and for a demo account, on purpose. A
 * stranger who happens to own a seeded number should learn nothing from the
 * screen about why, and support has the console for the real answer.
 */
export const SIGN_IN_REFUSED_MESSAGE =
  'This account cannot be accessed. Contact support.';

/**
 * Whether this account may hold a session right now.
 *
 * ONE function, called both where a session is created and where a session is
 * read back, so a demo account cannot be signed in by a cookie that predates
 * the deploy either.
 */
export function signInIsPermitted(
  user: Pick<User, 'isBlocked' | 'isDemo'>,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  if (user.isBlocked) return false;
  if (user.isDemo && !demoDataIsUsable(nodeEnv)) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Where the seed is allowed to write
// -----------------------------------------------------------------------------

/**
 * Hosts that are somebody's own machine.
 *
 * `db` and `postgres` are here because that is what a container is called in
 * every compose file anybody writes, and a developer whose database runs in
 * Docker should not have to pass a flag to seed it.
 */
export const LOCAL_DATABASE_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
  'db',
  'postgres',
  'host.docker.internal',
];

/**
 * Whether a connection string points at a local database.
 *
 * An unparseable URL is NOT local. The whole point of this check is to be
 * wrong in the safe direction.
 */
export function databaseHostLooksLocal(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false;
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    return false;
  }
  // A bracketed IPv6 literal arrives as [::1] and comes back as ::1 from the
  // URL parser on some runtimes and not others.
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return LOCAL_DATABASE_HOSTS.includes(bare);
}

export interface SeedTarget {
  nodeEnv?: string | undefined;
  databaseUrl?: string | undefined;
  /** The operator passed `--force`, having read the refusal. */
  force?: boolean;
}

/**
 * Why the seed must not run, or null if it may.
 *
 * Two independent reasons, checked in the order that matters. NODE_ENV is the
 * declared intent; the database host is what is actually about to be written
 * to — and the second catches the far more likely mistake, which is running
 * `npm run db:seed` in a terminal that has a production DATABASE_URL in it and
 * no NODE_ENV at all.
 *
 * `--force` overrides both, because there is a legitimate case — filling a
 * staging database with demo data on purpose — and a check with no way past it
 * gets commented out rather than respected.
 */
export function seedRefusalReason(target: SeedTarget): string | null {
  if (target.force) return null;

  if (!demoDataIsUsable(target.nodeEnv)) {
    return (
      'NODE_ENV is production. The seed creates accounts with real Philippine ' +
      'number formats, one of them an administrator, so it refuses to run here.'
    );
  }

  if (!databaseHostLooksLocal(target.databaseUrl)) {
    const host = describeDatabaseHost(target.databaseUrl);
    return (
      `DATABASE_URL points at ${host}, which is not a local database. The seed ` +
      'creates accounts with real Philippine number formats, one of them an ' +
      'administrator, so it refuses to write them anywhere it was not clearly ' +
      'asked to.'
    );
  }

  return null;
}

/** The host of a connection string, for a message. Never the credentials. */
export function describeDatabaseHost(databaseUrl: string | undefined): string {
  if (!databaseUrl) return 'no database at all (DATABASE_URL is unset)';
  try {
    return new URL(databaseUrl).host || 'an unnamed host';
  } catch {
    return 'a connection string this script could not parse';
  }
}
