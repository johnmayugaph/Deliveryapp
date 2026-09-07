#!/usr/bin/env tsx
/**
 * Restores the newest dump into a scratch database and checks it.
 *
 *     npm run db:restore-check
 *     npm run db:restore-check -- --file backups/tara-2026-09-08T02-00-00Z.dump
 *
 * This is the step that makes the rest worth having. A dump that has never
 * been restored is a hope: it can be truncated, encrypted with a key nobody
 * has, taken from the wrong database, or missing the one table somebody needs,
 * and every one of those looks exactly like a working backup in a directory
 * listing. The morning you find out is the worst possible morning.
 *
 * So this restores it — into a brand-new database, never over the live one —
 * and then asks the restored copy four questions:
 *
 *   1. Are the tables all there?
 *   2. Did the data come back — specifically, is any table that holds rows in
 *      the live database empty in the restored copy? A DIFFERENCE in counts is
 *      expected and reported without alarm, because the dump is a snapshot and
 *      the business keeps taking orders; an emptied table is not movement.
 *   3. Does the credits ledger still add up to the wallet balances? That is
 *      the invariant the whole financial side rests on, and it is checked
 *      against the RESTORED data rather than the live data, so a dump that
 *      lost transactions is caught even when its row counts look plausible.
 *   4. Are the append-only triggers still present? They are what make the
 *      ledger and the audit trail trustworthy, and a restore that quietly
 *      drops them produces a database that works and cannot be trusted.
 *
 * The scratch database is dropped afterwards, whatever happened.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import {
  DEFAULT_BACKUP_DIR,
  UnusableDatabaseUrlError,
  isBackupFileName,
  parseConnection,
  pgEnv,
} from '../src/lib/backup/policy';
import {
  BackupKeyMissingError,
  decryptBuffer,
  looksEncrypted,
} from '../src/lib/backup/encryption';

/** Tables whose absence means the dump is not usable, whatever else restored. */
const MUST_EXIST = [
  'User',
  'Order',
  'Wallet',
  'WalletTransaction',
  'AdminAuditEvent',
  'AccountRecovery',
  'Service',
];

/** Triggers that make the financial and identity records trustworthy. */
const MUST_HAVE_TRIGGERS = [
  'wallet_transaction_no_update',
  'admin_audit_no_update',
  'account_recovery_no_rewrite',
];

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });
}

/** One SQL query against a named database, as a tab-separated string. */
async function query(
  sql: string,
  database: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await run(
    'psql',
    ['--dbname', database, '--no-psqlrc', '--tuples-only', '--no-align', '--command', sql],
    env,
  );
  if (result.code !== 0) {
    throw new Error(`psql failed: ${result.stderr.trim().slice(0, 300)}`);
  }
  return result.stdout.trim();
}

async function newestDump(dir: string): Promise<string> {
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter(isBackupFileName)
    .sort();
  const newest = names.at(-1);
  if (newest === undefined) {
    throw new Error(
      `No dumps in ${dir}. Run npm run db:backup first — there is nothing to check.`,
    );
  }
  return path.join(dir, newest);
}

async function main() {
  const argv = process.argv.slice(2);
  const fileIndex = argv.indexOf('--file');
  const explicit = fileIndex === -1 ? undefined : argv[fileIndex + 1];

  const databaseUrl = process.env.DATABASE_URL;
  let connection;
  try {
    connection = parseConnection(databaseUrl);
  } catch (error) {
    if (error instanceof UnusableDatabaseUrlError) {
      console.error(`\n  ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }

  const env = pgEnv(connection, databaseUrl!);
  const filePath = explicit ?? (await newestDump(DEFAULT_BACKUP_DIR));
  const fileName = path.basename(filePath);

  console.log('');
  console.log(`  Checking ${filePath}`);
  console.log('');

  // Decrypt to a temporary file if needed. `pg_restore` needs a real file.
  const file = await readFile(filePath);
  let scratchDir: string | undefined;
  let dumpPath = filePath;

  if (looksEncrypted(file.subarray(0, 8))) {
    if (!process.env.BACKUP_ENCRYPTION_KEY) throw new BackupKeyMissingError();
    scratchDir = await mkdtemp(path.join(tmpdir(), 'tara-restore-'));
    dumpPath = path.join(scratchDir, 'plain.dump');
    await writeFile(dumpPath, decryptBuffer(file, process.env.BACKUP_ENCRYPTION_KEY), {
      mode: 0o600,
    });
    console.log('  Decrypted with BACKUP_ENCRYPTION_KEY.');
  }

  // A name nobody would pick for anything real, with a timestamp so two
  // concurrent checks cannot collide.
  const scratchDatabase = `tara_restore_check_${Date.now()}`;
  const findings: string[] = [];
  let ok = false;

  try {
    // Row counts from the LIVE database first, to compare against. Taken
    // before the restore so a long restore does not widen the window in which
    // the live numbers move.
    const liveCounts = await tableCounts(connection.database, env);

    console.log(`  Creating ${scratchDatabase}`);
    const created = await run('createdb', [scratchDatabase], env);
    if (created.code !== 0) {
      throw new Error(`createdb failed: ${created.stderr.trim().slice(0, 300)}`);
    }

    try {
      console.log('  Restoring…');
      const restored = await run(
        'pg_restore',
        ['--dbname', scratchDatabase, '--no-owner', '--no-privileges', '--exit-on-error', dumpPath],
        env,
      );
      if (restored.code !== 0) {
        throw new Error(`pg_restore failed: ${restored.stderr.trim().slice(0, 400)}`);
      }

      // 1. Every table that matters is present.
      const present = (
        await query(
          `select table_name from information_schema.tables where table_schema = 'public'`,
          scratchDatabase,
          env,
        )
      )
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const missing = MUST_EXIST.filter((table) => !present.includes(table));
      if (missing.length > 0) {
        throw new Error(`the restored copy has no ${missing.join(', ')} table`);
      }
      findings.push(`${present.length} tables`);

      // 2. The data came back.
      //
      // A difference from the live counts is NOT a failure: the dump is a
      // snapshot and the database keeps taking orders, so any busy table
      // legitimately differs by the time this runs. What IS a failure is a
      // table that holds rows in the live database and none in the restored
      // copy — that is not movement, that is data that did not come back, and
      // it is the failure a row count is actually able to catch.
      const restoredCounts = await tableCounts(scratchDatabase, env);
      const rows = Object.values(restoredCounts).reduce((sum, n) => sum + n, 0);
      findings.push(`${rows} rows`);

      const emptied = Object.entries(liveCounts)
        .filter(([table, live]) => live > 0 && (restoredCounts[table] ?? 0) === 0)
        .map(([table, live]) => `${table} (${live} live, 0 restored)`);
      if (emptied.length > 0) {
        throw new Error(`tables came back empty: ${emptied.join(', ')}`);
      }

      const moved = Object.entries(liveCounts)
        .filter(([table, live]) => (restoredCounts[table] ?? 0) !== live)
        .map(([table, live]) => `${table} ${live}→${restoredCounts[table] ?? 0}`);
      if (moved.length > 0) {
        findings.push(
          `changed since the dump, as expected on a live database: ` +
            `${moved.slice(0, 3).join(', ')}${moved.length > 3 ? `, +${moved.length - 3} more` : ''}`,
        );
      }

      // 3. The credits ledger still adds up — checked against the RESTORED
      //    data, which is the only way to catch a dump that lost transactions
      //    but kept a plausible row count.
      const mismatches = await query(
        `select count(*) from "Wallet" w
           where w."balanceCentavos" <> coalesce(
             (select sum(t."amountCentavos") from "WalletTransaction" t
               where t."walletId" = w.id), 0)`,
        scratchDatabase,
        env,
      );
      if (mismatches !== '0') {
        throw new Error(
          `${mismatches} wallet(s) in the restored copy do not match their ledger`,
        );
      }
      findings.push('ledger balances all match');

      // 4. The append-only triggers came back with it.
      const triggers = (
        await query(
          `select tgname from pg_trigger where not tgisinternal`,
          scratchDatabase,
          env,
        )
      ).split('\n').map((line) => line.trim());

      const missingTriggers = MUST_HAVE_TRIGGERS.filter((name) => !triggers.includes(name));
      if (missingTriggers.length > 0) {
        // Deliberately a finding rather than a failure: the triggers live in
        // prisma/sql and are applied by `npm run prisma:guards`, so a restore
        // into a fresh database legitimately needs that step afterwards. The
        // point is to say so out loud, because a restored database that works
        // and cannot be trusted is the worse outcome.
        findings.push(
          `run npm run prisma:guards after restoring — missing ${missingTriggers.join(', ')}`,
        );
      } else {
        findings.push('append-only triggers present');
      }

      ok = true;
    } finally {
      console.log(`  Dropping ${scratchDatabase}`);
      await run('dropdb', ['--if-exists', scratchDatabase], env);
    }
  } finally {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }

  const note = findings.join('; ');

  // Attach the result to the BackupRun for this file, if there is one. A dump
  // restored from somebody's laptop may have no row here, and that is fine.
  const updated = await prisma.backupRun.updateMany({
    where: { fileName },
    data: { verifiedAt: new Date(), verifyNote: note.slice(0, 500) },
  });

  console.log('');
  console.log(`  RESTORED AND CHECKED: ${note}`);
  if (updated.count === 0) {
    console.log('  (no BackupRun row for this file, so nothing was recorded)');
  }
  console.log('');
  if (!ok) process.exit(1);
}

/**
 * EXACT row counts for every table, keyed by table name.
 *
 * `count(*)` per table rather than `pg_stat_user_tables.n_live_tup`, which was
 * the first version of this and was worse than useless. That column is an
 * estimate maintained by the stats collector: it reads zero on a freshly
 * restored database until autovacuum gets round to it, so the check cheerfully
 * reported that a table with nine rows had two, and a comparison that prints
 * nonsense is how a verification tool teaches people to ignore it.
 *
 * Still one round trip: the counts are unioned into a single statement. Table
 * names come from the catalogue, and are matched against a strict pattern
 * anyway before being interpolated.
 */
async function tableCounts(
  database: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, number>> {
  const names = (
    await query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
      database,
      env,
    )
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));

  if (names.length === 0) return {};

  const sql = names
    .map((name) => `select '${name}' as t, count(*) as n from "${name}"`)
    .join(' union all ');

  const counts: Record<string, number> = {};
  for (const line of (await query(sql, database, env)).split('\n')) {
    const [name, count] = line.split('|');
    if (name && count !== undefined) {
      counts[name.trim()] = Number.parseInt(count.trim(), 10) || 0;
    }
  }
  return counts;
}

main()
  .catch((error) => {
    console.error('');
    console.error(`  RESTORE CHECK FAILED: ${error instanceof Error ? error.message : error}`);
    console.error('');
    console.error('  This is the failure worth having now rather than during a recovery.');
    console.error('');
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
