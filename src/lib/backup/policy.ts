/**
 * Backups: what this application can do about them, and what it cannot.
 *
 * The honest position first, because it decides everything else in this
 * directory. **The real backup is a feature of wherever the database is
 * hosted.** Point-in-time recovery on a managed Postgres restores to the
 * second, survives the machine this code runs on catching fire, and needs no
 * cron of ours. Nothing written here replaces it, and a repository that
 * shipped a `pg_dump` loop while implying otherwise would be worse than one
 * with no backup code at all.
 *
 * What this directory adds is the part a managed host does NOT give you:
 *
 *  - a portable dump you can take off the platform, which is the answer to
 *    "the provider suspended our account" and to "we are moving hosts";
 *  - a RESTORE DRILL, because a backup nobody has restored is a hope. This is
 *    the step almost nobody builds and the only one that proves the rest;
 *  - a record of when a backup last succeeded, so that "are backups running"
 *    is a question the console answers rather than a belief somebody holds.
 *
 * Everything in this file is pure so the policy can be tested at every value
 * rather than at whichever one the machine happens to have.
 */

/**
 * How a deployment says it takes backups.
 *
 * `host` is the honest declaration for the common case — the managed provider
 * does it — and it changes what the console claims: from "last backup 3 hours
 * ago" to "the host is responsible, and this application cannot see whether
 * that is true". Stating the limit is the whole point; a green tick this code
 * cannot justify is worse than no tick.
 */
export type BackupStrategy = 'script' | 'host' | 'none';

export function backupStrategy(
  raw: string | undefined = process.env.BACKUP_STRATEGY,
): BackupStrategy {
  if (raw === 'host') return 'host';
  if (raw === 'script') return 'script';
  return 'none';
}

/** How long before a missing backup is a problem worth a red panel. */
export const BACKUP_STALE_AFTER_HOURS = 36;

/**
 * A day and a half rather than a day.
 *
 * A daily cron that runs at 02:00 is 24 hours old at 01:59 the next night
 * through no fault of anybody's, and a check that goes red every night before
 * the run is a check people learn to ignore. Twelve hours of slack is enough
 * for a missed run to still be caught within a day.
 */
export function backupIsStale(
  lastSuccessAt: Date | null,
  now: Date,
  afterHours = BACKUP_STALE_AFTER_HOURS,
): boolean {
  if (lastSuccessAt === null) return true;
  return now.getTime() - lastSuccessAt.getTime() > afterHours * 60 * 60 * 1000;
}

export function hoursSince(at: Date, now: Date): number {
  return Math.max(0, Math.round(((now.getTime() - at.getTime()) / 3_600_000) * 10) / 10);
}

// -----------------------------------------------------------------------------
// Connecting without putting the password in the process list
// -----------------------------------------------------------------------------

export interface Connection {
  host: string;
  port: string;
  user: string;
  password?: string | undefined;
  database: string;
}

export class UnusableDatabaseUrlError extends Error {
  constructor(reason: string) {
    super(`DATABASE_URL cannot be used for a backup: ${reason}`);
    this.name = 'UnusableDatabaseUrlError';
  }
}

/**
 * Splits a connection string into parts.
 *
 * The reason this exists rather than passing the URL straight to `pg_dump`:
 * **argv is world-readable.** `pg_dump postgresql://tara:hunter2@host/db` puts
 * the database password in `ps` output for every process on the machine, and
 * in any shell history or process-list monitoring that happens to be running.
 * The parts go into the child's environment instead, which is not visible the
 * same way.
 */
export function parseConnection(databaseUrl: string | undefined): Connection {
  if (!databaseUrl) throw new UnusableDatabaseUrlError('it is not set');

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new UnusableDatabaseUrlError('it is not a URL');
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new UnusableDatabaseUrlError(`the scheme is ${url.protocol}, not postgres`);
  }

  const database = url.pathname.replace(/^\//, '');
  if (database.length === 0) throw new UnusableDatabaseUrlError('it names no database');

  return {
    host: url.hostname || 'localhost',
    port: url.port || '5432',
    user: decodeURIComponent(url.username) || 'postgres',
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    database,
  };
}

/**
 * The environment for a `pg_*` child process.
 *
 * `PGPASSWORD` is the documented way to hand a password to these tools without
 * it appearing in argv. `sslmode` is carried across because a managed host
 * usually requires it and a dump that fails on TLS at 02:00 is a dump nobody
 * notices missing.
 */
export function pgEnv(
  connection: Connection,
  databaseUrl: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sslmode = new URL(databaseUrl).searchParams.get('sslmode');
  return {
    ...base,
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGUSER: connection.user,
    PGDATABASE: connection.database,
    ...(connection.password === undefined ? {} : { PGPASSWORD: connection.password }),
    ...(sslmode === null ? {} : { PGSSLMODE: sslmode }),
  };
}

// -----------------------------------------------------------------------------
// Files
// -----------------------------------------------------------------------------

/** Where dumps go when nobody says otherwise. Gitignored. */
export const DEFAULT_BACKUP_DIR = 'backups';

/**
 * A name that sorts chronologically as a string.
 *
 * Colons are legal on Linux and a nuisance everywhere else — a dump copied to
 * a laptop or into object storage should not need quoting — so the ISO time is
 * written with dashes.
 */
export function backupFileName(now: Date, encrypted: boolean): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[:]/g, '-');
  return `tara-${stamp}.dump${encrypted ? '.enc' : ''}`;
}

export function isBackupFileName(name: string): boolean {
  return /^tara-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.dump(\.enc)?$/.test(name);
}

/**
 * Which dumps to delete, keeping the newest `keep`.
 *
 * Returns a LIST rather than deleting anything, so the caller can print it and
 * so this is testable without a filesystem. Files that do not match the naming
 * pattern are never returned: a directory somebody also keeps notes in must
 * not lose them to a retention pass.
 */
export function selectForDeletion(names: readonly string[], keep: number): string[] {
  if (keep < 1) return [];
  const ours = names.filter(isBackupFileName).sort();
  return ours.slice(0, Math.max(0, ours.length - keep));
}

// -----------------------------------------------------------------------------
// What the console is allowed to claim
// -----------------------------------------------------------------------------

export interface BackupPosture {
  strategy: BackupStrategy;
  /** What to show a person, in one sentence. */
  headline: string;
  /** Whether this warrants a red panel. */
  alarming: boolean;
  /** Whether the application can actually see that backups happened. */
  verifiable: boolean;
}

/**
 * The console's claim about backups, and its confidence in it.
 *
 * Three postures, and the middle one is the reason this function exists rather
 * than an `if` on the health page. A deployment that relies on its host's
 * point-in-time recovery is doing the right thing, and this application has no
 * way to confirm it — so the console says exactly that instead of either
 * nagging or displaying a reassurance it cannot support.
 */
export function backupPosture(input: {
  strategy: BackupStrategy;
  lastSuccessAt: Date | null;
  lastVerifiedAt: Date | null;
  now: Date;
}): BackupPosture {
  const { strategy, lastSuccessAt, lastVerifiedAt, now } = input;

  if (strategy === 'none') {
    return {
      strategy,
      headline:
        'No backup strategy is declared. The credits ledger and the order ' +
        'history exist nowhere else.',
      alarming: true,
      verifiable: false,
    };
  }

  if (strategy === 'host') {
    const extra =
      lastSuccessAt === null
        ? ''
        : ` A local dump was also taken ${hoursSince(lastSuccessAt, now)}h ago.`;
    return {
      strategy,
      headline:
        'The database host is responsible for backups. This application ' +
        'cannot see whether that is true — check it on the provider, and ' +
        'restore one to be sure.' +
        extra,
      alarming: false,
      verifiable: false,
    };
  }

  if (lastSuccessAt === null) {
    return {
      strategy,
      headline:
        'Backups are set to run from the script, and none has ever succeeded.',
      alarming: true,
      verifiable: true,
    };
  }

  const stale = backupIsStale(lastSuccessAt, now);
  const verified =
    lastVerifiedAt === null
      ? ' None has been restored yet, so none is proven — run npm run db:restore-check.'
      : ` Last proven by a restore ${hoursSince(lastVerifiedAt, now)}h ago.`;

  return {
    strategy,
    headline:
      `Last backup ${hoursSince(lastSuccessAt, now)}h ago.` +
      (stale ? ' That is older than a day and a half — the schedule has stopped.' : '') +
      verified,
    alarming: stale,
    verifiable: true,
  };
}
