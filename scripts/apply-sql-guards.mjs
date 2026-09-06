#!/usr/bin/env node
/**
 * Applies the SQL guards in prisma/sql/ after a migration.
 *
 * Prisma migrations own the tables; these files own the invariants Prisma's
 * schema language cannot express — the append-only trigger on the credits
 * ledger and the CHECK constraints that force transaction signs. They are
 * idempotent, so running this repeatedly is safe.
 *
 * Invoked via `node --env-file-if-exists=.env`, because unlike the Prisma CLI a
 * plain node script does not read .env on its own.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.join(here, '..', 'prisma', 'sql');

/**
 * Prisma connection strings carry parameters libpq has never heard of, and psql
 * rejects the whole URL when it meets one. Strip them, and translate `schema`
 * into the search_path that psql does understand.
 */
function toLibpqUrl(prismaUrl) {
  const url = new URL(prismaUrl);
  const PRISMA_ONLY = [
    'schema',
    'pgbouncer',
    'connection_limit',
    'pool_timeout',
    'connect_timeout',
    'socket_timeout',
    'statement_cache_size',
    'sslidentity',
    'sslpassword',
    'sslaccept',
  ];

  const schema = url.searchParams.get('schema');
  for (const parameter of PRISMA_ONLY) {
    url.searchParams.delete(parameter);
  }

  return { url: url.toString(), schema };
}

const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'Set DATABASE_URL (or DIRECT_URL) before applying SQL guards. ' +
      'Run this via `npm run prisma:guards`, which loads .env.',
  );
  process.exit(1);
}

let connection;
try {
  connection = toLibpqUrl(databaseUrl);
} catch {
  console.error(`DATABASE_URL is not a valid URL: ${databaseUrl}`);
  process.exit(1);
}

const env = { ...process.env };
if (connection.schema) {
  env.PGOPTIONS = `${env.PGOPTIONS ?? ''} -c search_path=${connection.schema}`.trim();
}

const files = (await readdir(sqlDir)).filter((name) => name.endsWith('.sql')).sort();

for (const file of files) {
  const sql = await readFile(path.join(sqlDir, file), 'utf8');
  process.stdout.write(`Applying ${file} ... `);
  try {
    await execFileAsync(
      'psql',
      [connection.url, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql],
      { env },
    );
    console.log('ok');
  } catch (error) {
    console.log('failed');
    console.error(error.stderr || error.message);
    process.exit(1);
  }
}

console.log(`Applied ${files.length} guard file(s).`);
