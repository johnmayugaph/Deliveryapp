#!/usr/bin/env tsx
/**
 * Takes a portable dump of the database.
 *
 *     npm run db:backup
 *     npm run db:backup -- --keep 14 --dir /mnt/backups
 *
 * READ THIS FIRST. The real backup is a feature of wherever the database is
 * hosted: point-in-time recovery on a managed Postgres restores to the second
 * and survives this machine catching fire. Turn it on. Nothing here replaces
 * it, and treating this script as the whole answer would be the most expensive
 * mistake in the repository.
 *
 * What this adds is the part a managed host does not give you: a file you can
 * take off the platform. That is the answer to "the provider suspended our
 * account", to "we are moving hosts", and to "somebody ran a migration that
 * dropped a column three weeks ago and nobody noticed".
 *
 * It is deliberately boring: `pg_dump -Fc`, optionally encrypted, verified by
 * reading the archive's own table of contents back, recorded in `BackupRun`,
 * and old dumps pruned. Custom format rather than plain SQL because
 * `pg_restore` can then restore selectively — one table, or everything but
 * one table — which is what an actual recovery usually needs.
 *
 * Then run `npm run db:restore-check`. A backup nobody has restored is a hope.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { prisma } from '../src/lib/prisma';
import {
  DEFAULT_BACKUP_DIR,
  UnusableDatabaseUrlError,
  backupFileName,
  parseConnection,
  pgEnv,
  selectForDeletion,
} from '../src/lib/backup/policy';
import { encryptStream, isEncryptionConfigured } from '../src/lib/backup/encryption';
import { redactMessage } from '../src/lib/monitoring/redact';

interface Args {
  dir: string;
  keep: number;
}

function parseArgs(argv: string[]): Args {
  let dir = DEFAULT_BACKUP_DIR;
  let keep = 7;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--dir' && argv[index + 1] !== undefined) {
      dir = argv[index + 1]!;
      index += 1;
    } else if (arg === '--keep' && argv[index + 1] !== undefined) {
      const value = Number.parseInt(argv[index + 1]!, 10);
      if (Number.isFinite(value) && value >= 1) keep = value;
      index += 1;
    }
  }

  return { dir, keep };
}

/** Whether a `pg_*` tool is on PATH at all. */
async function toolExists(tool: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(tool, ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function main() {
  const { dir, keep } = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

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

  if (!(await toolExists('pg_dump'))) {
    // The same failure that makes `npm run prisma:guards` unreliable on a
    // managed host, and worth the same warning: most build images do not
    // include the Postgres client tools. A backup that silently never runs is
    // the worst possible version of this feature.
    console.error('');
    console.error('  pg_dump is not on PATH, so no dump can be taken.');
    console.error('');
    console.error('  Install the Postgres 16 client tools on whichever machine runs');
    console.error('  this schedule — it does not have to be the application server,');
    console.error('  and often should not be. Debian/Ubuntu:');
    console.error('');
    console.error('    apt-get install -y postgresql-client-16');
    console.error('');
    console.error('  Until then, rely on the host’s point-in-time recovery and set');
    console.error('  BACKUP_STRATEGY=host so the console stops claiming otherwise.');
    console.error('');
    process.exit(2);
  }

  const encrypt = isEncryptionConfigured();
  const fileName = backupFileName(startedAt, encrypt);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);

  console.log('');
  console.log(`  Dumping ${connection.database} at ${connection.host}:${connection.port}`);
  console.log(`  into ${filePath}`);
  if (!encrypt) {
    console.log('');
    console.log('  NOT ENCRYPTED. This file will contain every customer’s phone');
    console.log('  number and home address in plaintext. Set BACKUP_ENCRYPTION_KEY');
    console.log('  to a long passphrase, and keep it somewhere that survives the');
    console.log('  loss of this machine — a dump you cannot decrypt is not a backup.');
  }
  console.log('');

  const run = await prisma.backupRun.create({
    data: { startedAt, fileName, encrypted: encrypt },
    select: { id: true },
  });

  try {
    const { bytes, checksum } = await dump({
      filePath,
      databaseUrl: databaseUrl!,
      connection,
      encrypt,
    });

    // Read the archive's table of contents back. This is the cheap half of
    // proving the file: it establishes that pg_restore can parse what we
    // wrote, which catches a truncated write, a full disk, and a dump that
    // failed halfway with a zero exit somewhere in a pipe.
    const tables = await countTablesInArchive(filePath, encrypt);

    await prisma.backupRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        ok: true,
        sizeBytes: bytes,
        checksum,
        verifyNote: `archive lists ${tables} table(s)`,
      },
    });

    console.log(`  Wrote ${(bytes / 1_048_576).toFixed(2)} MB`);
    console.log(`  sha256 ${checksum}`);
    console.log(`  archive lists ${tables} table(s)`);
    console.log('');

    const pruned = await prune(dir, keep);
    if (pruned.length > 0) {
      console.log(`  Pruned ${pruned.length} old dump(s), keeping the newest ${keep}.`);
      console.log('');
    }

    console.log('  NOT YET PROVEN. Run this next, ideally on a schedule too:');
    console.log('');
    console.log('    npm run db:restore-check');
    console.log('');
  } catch (error) {
    const message = redactMessage(error instanceof Error ? error.message : String(error));
    await prisma.backupRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, error: message },
    });
    // Best effort: a half-written file is worse than none, because it looks
    // like a backup in a directory listing.
    await rm(filePath, { force: true }).catch(() => {});
    console.error('');
    console.error(`  Backup FAILED: ${message}`);
    console.error('');
    process.exit(1);
  }
}

/** Runs pg_dump, writing to `filePath`, and returns the size and checksum. */
async function dump(input: {
  filePath: string;
  databaseUrl: string;
  connection: ReturnType<typeof parseConnection>;
  encrypt: boolean;
}): Promise<{ bytes: number; checksum: string }> {
  const { filePath, databaseUrl, connection, encrypt } = input;

  // The connection details go in the ENVIRONMENT, never in argv: a password
  // on a command line is visible in `ps` to every process on the machine.
  const child = spawn(
    'pg_dump',
    [
      // Custom format: compressed, and restorable selectively.
      '--format=custom',
      // The dump is a snapshot of one moment even while orders are being
      // placed, which is the whole reason to use pg_dump rather than copying
      // files out from under a running server.
      '--serializable-deferrable',
      '--no-owner',
      '--no-privileges',
      '--verbose',
    ],
    { env: pgEnv(connection, databaseUrl), stdio: ['ignore', 'pipe', 'pipe'] },
  );

  /**
   * The exit code, awaited AFTER the output is consumed but subscribed NOW.
   *
   * This ordering is not stylistic. `child.on('close', resolve)` attached
   * after reading stdout to completion is a promise that may never settle: for
   * a small database the child has already exited by then, 'close' has already
   * fired, and it does not fire again — so the script hung and then exited
   * silently with status 0, leaving a BackupRun row that said "not ok" with no
   * error and a dump file that was actually fine. It failed only on the
   * encrypted path at first, purely because that path happened to be fast
   * enough to lose the race.
   */
  const exited = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
  });

  const stderr: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    // `--verbose` narrates every table, so this matches pg_dump's own message
    // PREFIXES rather than the word "error" anywhere in the line — otherwise
    // "dumping contents of table public.ErrorReport" is reported as a problem,
    // which is how a scary-looking log teaches somebody to ignore the log.
    if (/^pg_dump: (error|fatal|warning):/m.test(text) || /could not|permission denied/i.test(text)) {
      stderr.push(text);
      process.stderr.write(`  pg_dump: ${text.trim()}\n`);
    }
  });

  const out = createWriteStream(filePath, { mode: 0o600 });
  const finished = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });

  let result: { bytes: number; checksum: string };

  if (encrypt) {
    result = await encryptStream(child.stdout, out, process.env.BACKUP_ENCRYPTION_KEY!);
    out.end();
  } else {
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of child.stdout) {
      const buffer = chunk as Buffer;
      digest.update(buffer);
      bytes += buffer.length;
      out.write(buffer);
    }
    out.end();
    result = { bytes, checksum: digest.digest('hex') };
  }

  await finished;

  const code = await exited;
  if (code !== 0) {
    throw new Error(
      `pg_dump exited ${code}${stderr.length > 0 ? `: ${stderr.join(' ').trim()}` : ''}`,
    );
  }
  if (result.bytes === 0) {
    throw new Error('pg_dump produced an empty file');
  }

  return result;
}

/**
 * Reads the archive's table of contents.
 *
 * For an encrypted dump this has to decrypt to a temporary file first, which
 * is also a real test of the key: a passphrase that cannot open the file it
 * just wrote is a problem to discover now rather than during a recovery.
 */
async function countTablesInArchive(filePath: string, encrypted: boolean): Promise<number> {
  const { readFile, writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { decryptBuffer } = await import('../src/lib/backup/encryption');

  let target = filePath;
  let scratch: string | undefined;

  if (encrypted) {
    const plain = decryptBuffer(
      await readFile(filePath),
      process.env.BACKUP_ENCRYPTION_KEY!,
    );
    scratch = await mkdtemp(path.join(tmpdir(), 'tara-backup-'));
    target = path.join(scratch, 'plain.dump');
    await writeFile(target, plain, { mode: 0o600 });
  }

  try {
    const listing = await new Promise<string>((resolve, reject) => {
      const child = spawn('pg_restore', ['--list', target], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve(Buffer.concat(chunks).toString('utf8'))
          : reject(new Error(`pg_restore --list exited ${code}`)),
      );
    });

    return listing.split('\n').filter((line) => / TABLE DATA /.test(line)).length;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Deletes all but the newest `keep` dumps, and only files we wrote. */
async function prune(dir: string, keep: number): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const doomed = selectForDeletion(names, keep);
  for (const name of doomed) {
    await rm(path.join(dir, name), { force: true }).catch(() => {});
  }
  return doomed;
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
