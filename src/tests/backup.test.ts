import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_STALE_AFTER_HOURS,
  UnusableDatabaseUrlError,
  backupFileName,
  backupIsStale,
  backupPosture,
  backupStrategy,
  hoursSince,
  isBackupFileName,
  parseConnection,
  pgEnv,
  selectForDeletion,
} from '@/lib/backup/policy';
import {
  BackupFormatError,
  decryptBuffer,
  encryptStream,
  isEncryptionConfigured,
  looksEncrypted,
} from '@/lib/backup/encryption';

/**
 * Backups.
 *
 * The honest framing first, because it shapes what is worth testing: the real
 * backup is the host's point-in-time recovery, and nothing in this repository
 * replaces it. What is tested here is the part this code is actually
 * responsible for — a portable dump, taken without leaking the password, kept
 * for a sensible time, encrypted if a key exists, and a console that does not
 * claim more than it can see.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function codeOnly(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

/** Collects everything written, so a stream can be asserted on. */
function sink(): Writable & { written: () => Buffer } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk as Buffer));
      callback();
    },
  });
  return Object.assign(stream, { written: () => Buffer.concat(chunks) });
}

// -----------------------------------------------------------------------------
// The password must not reach argv
// -----------------------------------------------------------------------------

describe('connecting to the database to dump it', () => {
  const url = 'postgresql://tara:hunter2@db.example.com:6543/tara_prod?sslmode=require';

  it('splits a connection string into parts', () => {
    expect(parseConnection(url)).toEqual({
      host: 'db.example.com',
      port: '6543',
      user: 'tara',
      password: 'hunter2',
      database: 'tara_prod',
    });
  });

  it('defaults the port when the URL omits it', () => {
    expect(parseConnection('postgresql://postgres@localhost/tara')).toMatchObject({
      host: 'localhost',
      port: '5432',
    });
  });

  it('reads the libpq local-socket form', () => {
    // `postgres:///tara` means "this machine", and it is what a developer's
    // environment often holds.
    expect(parseConnection('postgres:///tara')).toMatchObject({
      host: 'localhost',
      port: '5432',
      user: 'postgres',
      database: 'tara',
    });
  });

  it('decodes a password with URL-escaped characters', () => {
    // A password with an @ or a / in it is common and breaks naive splitting.
    expect(
      parseConnection('postgresql://tara:p%40ss%2Fword@host/db').password,
    ).toBe('p@ss/word');
  });

  it('refuses what it cannot use, rather than guessing', () => {
    expect(() => parseConnection(undefined)).toThrow(UnusableDatabaseUrlError);
    expect(() => parseConnection('not a url')).toThrow(UnusableDatabaseUrlError);
    expect(() => parseConnection('mysql://u@h/db')).toThrow(UnusableDatabaseUrlError);
    expect(() => parseConnection('postgresql://u@h/')).toThrow(UnusableDatabaseUrlError);
  });

  it('puts the credentials in the environment', () => {
    // A minimal base standing in for process.env, so the test also proves the
    // rest of the environment survives — a child with no PATH cannot run.
    const base = { NODE_ENV: 'test', PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    const env = pgEnv(parseConnection(url), url, base);
    expect(env.PATH).toBe('/usr/bin');
    expect(env).toMatchObject({
      PGHOST: 'db.example.com',
      PGPORT: '6543',
      PGUSER: 'tara',
      PGDATABASE: 'tara_prod',
      PGPASSWORD: 'hunter2',
      PGSSLMODE: 'require',
    });
  });

  it('omits PGPASSWORD when there is no password, rather than sending empty', () => {
    const noPassword = 'postgresql://postgres@localhost:5432/tara';
    const base = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    expect(pgEnv(parseConnection(noPassword), noPassword, base)).not.toHaveProperty(
      'PGPASSWORD',
    );
  });

  it('never passes the connection string to pg_dump on the command line', () => {
    // argv is world-readable: `pg_dump postgresql://tara:hunter2@…` puts the
    // database password in `ps` output for every process on the machine.
    const script = codeOnly('scripts/backup-db.ts');
    const spawnCall = script.slice(script.indexOf("spawn(\n    'pg_dump'"));
    expect(spawnCall).toMatch(/env: pgEnv\(/);
    expect(script).not.toMatch(/spawn\('pg_dump', \[databaseUrl/);
    expect(script).not.toMatch(/--dbname.*databaseUrl/);
  });
});

// -----------------------------------------------------------------------------
// Files and retention
// -----------------------------------------------------------------------------

describe('naming and keeping dumps', () => {
  const at = new Date('2026-09-08T02:07:31.482Z');

  it('names a dump so that sorting by name sorts by time', () => {
    expect(backupFileName(at, false)).toBe('tara-2026-09-08T02-07-31Z.dump');
  });

  it('marks an encrypted dump as one', () => {
    expect(backupFileName(at, true)).toBe('tara-2026-09-08T02-07-31Z.dump.enc');
  });

  it('avoids colons, which are a nuisance off Linux', () => {
    // These files get copied to laptops and into object storage.
    expect(backupFileName(at, false)).not.toContain(':');
  });

  it('recognises its own files and nothing else', () => {
    expect(isBackupFileName('tara-2026-09-08T02-07-31Z.dump')).toBe(true);
    expect(isBackupFileName('tara-2026-09-08T02-07-31Z.dump.enc')).toBe(true);
    expect(isBackupFileName('notes.md')).toBe(false);
    expect(isBackupFileName('tara-backup.sql')).toBe(false);
    expect(isBackupFileName('tara-2026-09-08T02-07-31Z.dump.old')).toBe(false);
  });

  it('deletes the oldest and keeps the newest', () => {
    const names = [
      'tara-2026-09-01T02-00-00Z.dump',
      'tara-2026-09-02T02-00-00Z.dump',
      'tara-2026-09-03T02-00-00Z.dump',
      'tara-2026-09-04T02-00-00Z.dump',
    ];
    expect(selectForDeletion(names, 2)).toEqual([
      'tara-2026-09-01T02-00-00Z.dump',
      'tara-2026-09-02T02-00-00Z.dump',
    ]);
  });

  it('never touches a file it did not write', () => {
    // A backup directory somebody also keeps a README in must not lose it.
    const names = ['README.md', 'restore-notes.txt', 'tara-2026-09-01T02-00-00Z.dump'];
    expect(selectForDeletion(names, 0)).toEqual([]);
    expect(selectForDeletion(names, 1)).toEqual([]);
  });

  it('keeps everything when asked to keep more than there are', () => {
    expect(selectForDeletion(['tara-2026-09-01T02-00-00Z.dump'], 7)).toEqual([]);
  });

  it('refuses to delete everything when told to keep none', () => {
    // `--keep 0` is far more likely to be a mistake than an intention.
    expect(selectForDeletion(['tara-2026-09-01T02-00-00Z.dump'], 0)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Staleness
// -----------------------------------------------------------------------------

describe('when a missing backup becomes a problem', () => {
  const now = new Date('2026-09-08T02:00:00Z');

  it('treats never as stale', () => {
    expect(backupIsStale(null, now)).toBe(true);
  });

  it('is not upset by a daily backup taken this morning', () => {
    expect(backupIsStale(new Date('2026-09-08T00:00:00Z'), now)).toBe(false);
  });

  it('tolerates a full day plus slack', () => {
    // A daily cron at 02:00 is 24 hours old at 01:59 the next night through
    // nobody's fault. A check that goes red every night before the run is a
    // check people learn to ignore.
    expect(backupIsStale(new Date('2026-09-07T01:00:00Z'), now)).toBe(false);
    expect(BACKUP_STALE_AFTER_HOURS).toBeGreaterThan(24);
  });

  it('does complain when a run has plainly been skipped', () => {
    expect(backupIsStale(new Date('2026-09-06T02:00:00Z'), now)).toBe(true);
  });

  it('measures age in hours a person can read', () => {
    expect(hoursSince(new Date('2026-09-07T20:00:00Z'), now)).toBe(6);
    expect(hoursSince(new Date('2026-09-08T02:30:00Z'), now)).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// What the console is allowed to claim
// -----------------------------------------------------------------------------

describe('the posture the console reports', () => {
  const now = new Date('2026-09-08T02:00:00Z');

  it('reads the strategy from the environment, defaulting to none', () => {
    expect(backupStrategy('host')).toBe('host');
    expect(backupStrategy('script')).toBe('script');
    expect(backupStrategy(undefined)).toBe('none');
    expect(backupStrategy('yes please')).toBe('none');
  });

  it('is alarmed when nothing is declared', () => {
    const posture = backupPosture({
      strategy: 'none',
      lastSuccessAt: null,
      lastVerifiedAt: null,
      now,
    });
    expect(posture.alarming).toBe(true);
    expect(posture.headline).toMatch(/nowhere else/);
  });

  /**
   * The case this function exists for.
   *
   * A deployment relying on its host's point-in-time recovery is doing the
   * right thing, and this application has no way to confirm it. So the console
   * says exactly that — rather than nagging somebody who is already covered,
   * or showing a green tick it cannot justify.
   */
  it('does not nag, and does not pretend, about host-managed backups', () => {
    const posture = backupPosture({
      strategy: 'host',
      lastSuccessAt: null,
      lastVerifiedAt: null,
      now,
    });
    expect(posture.alarming).toBe(false);
    expect(posture.verifiable).toBe(false);
    expect(posture.headline).toMatch(/cannot see whether that is true/);
  });

  it('says so when the script is the strategy and has never run', () => {
    const posture = backupPosture({
      strategy: 'script',
      lastSuccessAt: null,
      lastVerifiedAt: null,
      now,
    });
    expect(posture.alarming).toBe(true);
    expect(posture.verifiable).toBe(true);
  });

  it('reports a recent backup calmly', () => {
    const posture = backupPosture({
      strategy: 'script',
      lastSuccessAt: new Date('2026-09-08T00:00:00Z'),
      lastVerifiedAt: new Date('2026-09-07T00:00:00Z'),
      now,
    });
    expect(posture.alarming).toBe(false);
    expect(posture.headline).toMatch(/Last backup 2h ago/);
    expect(posture.headline).toMatch(/proven by a restore/);
  });

  it('says a backup is unproven until somebody has restored one', () => {
    // A dump nobody has restored is a hope, and the console should not let
    // that pass as a working backup.
    const posture = backupPosture({
      strategy: 'script',
      lastSuccessAt: new Date('2026-09-08T00:00:00Z'),
      lastVerifiedAt: null,
      now,
    });
    expect(posture.headline).toMatch(/none is proven/);
    expect(posture.headline).toMatch(/db:restore-check/);
  });

  it('notices that a schedule has stopped', () => {
    const posture = backupPosture({
      strategy: 'script',
      lastSuccessAt: new Date('2026-09-04T02:00:00Z'),
      lastVerifiedAt: null,
      now,
    });
    expect(posture.alarming).toBe(true);
    expect(posture.headline).toMatch(/the schedule has stopped/);
  });
});

// -----------------------------------------------------------------------------
// Encryption
// -----------------------------------------------------------------------------

describe('encrypting a dump at rest', () => {
  const passphrase = 'a long passphrase kept somewhere else';

  it('is off unless a key is set', () => {
    expect(isEncryptionConfigured(undefined)).toBe(false);
    expect(isEncryptionConfigured('')).toBe(false);
    expect(isEncryptionConfigured('x')).toBe(true);
  });

  async function encrypt(plain: Buffer): Promise<Buffer> {
    const input = new PassThrough();
    const out = sink();
    const done = encryptStream(input, out, passphrase);
    input.end(plain);
    await done;
    return out.written();
  }

  it('round-trips a dump', async () => {
    const plain = Buffer.from('PGDMP fake archive contents, +639171234567, 481923');
    const cipher = await encrypt(plain);
    expect(decryptBuffer(cipher, passphrase).equals(plain)).toBe(true);
  });

  it('leaves nothing readable in the file', async () => {
    const plain = Buffer.from('Juan Dela Cruz, 24 Kalayaan Ave, +639171234567');
    const cipher = await encrypt(plain);
    expect(cipher.toString('utf8')).not.toContain('Kalayaan');
    expect(cipher.toString('utf8')).not.toContain('639171234567');
  });

  it('reports the size and checksum of the file as written', async () => {
    const input = new PassThrough();
    const out = sink();
    const done = encryptStream(input, out, passphrase);
    input.end(Buffer.alloc(1_000, 3));
    const { bytes, checksum } = await done;
    expect(bytes).toBe(out.written().length);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different file every time from the same input', async () => {
    // A per-file salt and IV: two dumps of an unchanged database must not be
    // byte-identical, or an observer learns when nothing changed.
    const plain = Buffer.from('same input');
    const a = await encrypt(plain);
    const b = await encrypt(plain);
    expect(a.equals(b)).toBe(false);
    expect(decryptBuffer(b, passphrase).equals(plain)).toBe(true);
  });

  it('refuses the wrong key', async () => {
    const cipher = await encrypt(Buffer.from('secrets'));
    expect(() => decryptBuffer(cipher, 'not the key')).toThrow(BackupFormatError);
  });

  it('refuses a file with a single byte changed', async () => {
    // The reason for GCM rather than CBC: a damaged dump must fail loudly
    // instead of restoring a plausible-looking database.
    const cipher = await encrypt(Buffer.alloc(4_000, 9));
    const tampered = Buffer.from(cipher);
    const middle = Math.floor(tampered.length / 2);
    tampered.writeUInt8(tampered.readUInt8(middle) ^ 0xff, middle);
    expect(() => decryptBuffer(tampered, passphrase)).toThrow(BackupFormatError);
  });

  it('refuses a truncated file', async () => {
    const cipher = await encrypt(Buffer.alloc(4_000, 9));
    expect(() => decryptBuffer(cipher.subarray(0, cipher.length - 40), passphrase)).toThrow(
      BackupFormatError,
    );
  });

  it('refuses something that is not one of ours at all', () => {
    expect(() => decryptBuffer(Buffer.alloc(200, 1), passphrase)).toThrow(
      /header does not match/,
    );
    expect(() => decryptBuffer(Buffer.alloc(4), passphrase)).toThrow(/too short/);
  });

  it('can be identified without the key', async () => {
    const cipher = await encrypt(Buffer.from('x'));
    expect(looksEncrypted(cipher.subarray(0, 8))).toBe(true);
    expect(looksEncrypted(Buffer.from('PGDMP...'))).toBe(false);
  });

  it('says what to do when the key is missing, and why it matters', async () => {
    const { BackupKeyMissingError } = await import('@/lib/backup/encryption');
    expect(new BackupKeyMissingError().message).toMatch(/survives the loss of this machine/);
  });
});

// -----------------------------------------------------------------------------
// The shape of the scripts
// -----------------------------------------------------------------------------

describe('the backup script', () => {
  const script = codeOnly('scripts/backup-db.ts');

  it('records the attempt before it starts, so a failure leaves a trace', () => {
    // A table of only successes cannot answer "when did this start failing".
    const createIndex = script.indexOf('backupRun.create');
    const dumpIndex = script.indexOf('await dump(');
    expect(createIndex).toBeGreaterThan(0);
    expect(createIndex).toBeLessThan(dumpIndex);
  });

  it('reads the archive back rather than trusting the exit code', () => {
    expect(script).toMatch(/pg_restore/);
    expect(script).toMatch(/--list/);
  });

  it('refuses to call an empty file a backup', () => {
    expect(script).toMatch(/produced an empty file/);
  });

  it('deletes a half-written file, which is worse than none', () => {
    const failure = script.slice(script.indexOf('} catch (error) {'));
    expect(failure).toMatch(/rm\(filePath/);
  });

  it('subscribes to the child exit before reading its output', () => {
    // Attaching the 'close' listener afterwards is a promise that never
    // settles when the child has already gone — which is exactly what
    // happened, and it exited silently with status 0.
    const exitedIndex = script.indexOf("child.on('close'");
    const readIndex = script.indexOf('for await (const chunk of child.stdout)');
    expect(exitedIndex).toBeGreaterThan(0);
    expect(exitedIndex).toBeLessThan(readIndex);
  });

  it('says what to do when pg_dump is missing rather than failing obscurely', () => {
    expect(source('scripts/backup-db.ts')).toMatch(/postgresql-client-16/);
    expect(source('scripts/backup-db.ts')).toMatch(/BACKUP_STRATEGY=host/);
  });

  it('tells the operator the dump is not yet proven', () => {
    expect(source('scripts/backup-db.ts')).toMatch(/db:restore-check/);
  });
});

describe('the restore drill', () => {
  const script = codeOnly('scripts/restore-check.ts');

  it('never restores over the live database', () => {
    expect(script).toMatch(/createdb/);
    expect(script).toMatch(/tara_restore_check_/);
    const restore = script.slice(script.indexOf("'pg_restore'"));
    expect(restore).toMatch(/scratchDatabase/);
  });

  it('drops the scratch database whatever happened', () => {
    expect(script).toMatch(/finally \{[\s\S]{0,200}dropdb/);
  });

  it('checks the ledger against the RESTORED copy', () => {
    // The check that catches a dump which lost transactions but kept a
    // plausible row count.
    const check = script.slice(script.indexOf('balanceCentavos'));
    expect(check).toMatch(/scratchDatabase/);
  });

  it('counts rows exactly rather than reading an estimate', () => {
    // n_live_tup is maintained by the stats collector and reads zero on a
    // freshly restored database, which made the first version of this report
    // that a table with nine rows had two.
    expect(script).not.toMatch(/n_live_tup/);
    expect(script).toMatch(/count\(\*\)/);
  });

  it('treats an emptied table as a failure and a changed count as normal', () => {
    expect(script).toMatch(/came back empty/);
    expect(script).toMatch(/as expected on a live database/);
  });

  it('notices when the append-only triggers did not come back', () => {
    expect(script).toMatch(/wallet_transaction_no_update/);
    expect(script).toMatch(/prisma:guards/);
  });
});
