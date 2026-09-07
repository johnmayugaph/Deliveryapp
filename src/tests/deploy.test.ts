import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The deployment configuration.
 *
 * Every assertion here is a mistake that was actually made while writing these
 * files, or one that a plausible edit would reintroduce. None of it can be
 * caught by tsc, and only some of it by running CI — a Dockerfile that puts
 * `pg_dump` on the customer-facing image builds perfectly.
 */

function file(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function yaml<T = Record<string, unknown>>(relativePath: string): T {
  return parse(file(relativePath)) as T;
}

interface Workflow {
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      steps: { name?: string; run?: string; uses?: string; env?: Record<string, string> }[];
    }
  >;
}

interface Compose {
  services: Record<
    string,
    {
      build?: { target?: string };
      image?: string;
      environment?: Record<string, string>;
      command?: string;
      ports?: string[];
      profiles?: string[];
      volumes?: string[];
    }
  >;
}

// -----------------------------------------------------------------------------
// The variable that broke CI before it ever ran
// -----------------------------------------------------------------------------

describe('every command that loads the Prisma schema has both URLs', () => {
  const workflow = yaml<Workflow>('.github/workflows/ci.yml');

  /**
   * `prisma/schema.prisma` declares `directUrl = env("DIRECT_URL")` for
   * connection-pooled hosts, and the Prisma CLI refuses to LOAD a schema whose
   * referenced variables are missing — error P1012, before it looks at a
   * database at all. A developer never sees this because their `.env` has both
   * variables; a runner has no `.env`, so every Prisma step fails with a
   * validation error that says nothing about the real cause.
   */
  it('sets DIRECT_URL alongside DATABASE_URL, everywhere', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const runsPrisma = job.steps.some(
        (step) => step.run?.includes('prisma') ?? false,
      );
      if (!runsPrisma) continue;

      // Either on the job, or on each step that needs it.
      const jobHasBoth =
        job.env?.DATABASE_URL !== undefined && job.env?.DIRECT_URL !== undefined;
      const everyPrismaStepHasBoth = job.steps
        .filter((step) => step.run?.includes('prisma'))
        .every(
          (step) =>
            (step.env?.DATABASE_URL !== undefined && step.env?.DIRECT_URL !== undefined) ||
            jobHasBoth,
        );

      expect(everyPrismaStepHasBoth, `job "${name}" runs prisma without DIRECT_URL`).toBe(
        true,
      );
    }
  });

  it('never puts a real connection string in the workflow', () => {
    // The placeholders are obviously unusable on purpose. A CI file is public
    // on a public repository.
    const source = file('.github/workflows/ci.yml');
    for (const match of source.matchAll(/postgres(?:ql)?:\/\/[^\s'"]+/g)) {
      expect(match[0]).toMatch(/@127\.0\.0\.1|@localhost/);
    }
  });

  it('runs a production build, which is the only thing that catches two real bugs', () => {
    // A `'use server'` module exporting a constant, and an edge-runtime import
    // that stops instrumentation from compiling. Both happened; tsc and ESLint
    // pass both.
    const steps = workflow.jobs.checks!.steps.map((step) => step.run ?? '');
    expect(steps.some((run) => run.includes('npm run build'))).toBe(true);
    expect(steps.some((run) => run.includes('npm run typecheck'))).toBe(true);
    expect(steps.some((run) => run.includes('npm test'))).toBe(true);
  });

  it('applies the SQL guards, which nothing else would catch', () => {
    // The guards shell out to psql. A broken trigger definition does not fail
    // a build, a test or a type check — it silently leaves the credits ledger
    // editable.
    const runs = workflow.jobs.database!.steps.map((step) => step.run ?? '').join('\n');
    expect(runs).toMatch(/prisma migrate deploy/);
    expect(runs).toMatch(/prisma:guards/);
  });

  it('proves a backup restores, on every push', () => {
    const runs = workflow.jobs.backup!.steps.map((step) => step.run ?? '').join('\n');
    expect(runs).toMatch(/db:backup/);
    expect(runs).toMatch(/db:restore-check/);
    // And that a damaged one is refused, which is the property that makes the
    // encryption worth having.
    expect(runs).toMatch(/0xff/);
  });

  it('asks for no more permission than it needs', () => {
    const raw = yaml<{ permissions: Record<string, string> }>('.github/workflows/ci.yml');
    expect(raw.permissions).toEqual({ contents: 'read' });
  });

  it('cancels superseded runs', () => {
    const raw = yaml<{ concurrency: { 'cancel-in-progress': boolean } }>(
      '.github/workflows/ci.yml',
    );
    expect(raw.concurrency['cancel-in-progress']).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The image
// -----------------------------------------------------------------------------

describe('the Dockerfile', () => {
  const dockerfile = file('Dockerfile');

  /** The lines belonging to one build stage. */
  function stage(name: string): string {
    const start = dockerfile.indexOf(`AS ${name}\n`);
    expect(start, `no stage named ${name}`).toBeGreaterThan(-1);
    const rest = dockerfile.slice(start);
    const next = rest.slice(1).search(/\nFROM /);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }

  it('builds both targets from one file', () => {
    expect(dockerfile).toMatch(/AS web\n/);
    expect(dockerfile).toMatch(/AS ops\n/);
  });

  it('keeps the Postgres client OFF the customer-facing image', () => {
    // pg_dump and psql on the machine that answers requests is attack surface
    // for no benefit: nothing on a request path shells out to either.
    expect(stage('web')).not.toMatch(/postgresql-client/);
    expect(stage('ops')).toMatch(/postgresql-client-16/);
  });

  it('installs Postgres 16 specifically, not whatever Debian ships', () => {
    // Debian bookworm ships 15, and pg_dump 15 REFUSES to dump a 16 server.
    expect(stage('ops')).toMatch(/apt\.postgresql\.org/);
    expect(stage('ops')).not.toMatch(/install -y postgresql-client\b/);
  });

  it('serves as a non-root user', () => {
    expect(stage('web')).toMatch(/USER node/);
    expect(stage('ops')).toMatch(/USER node/);
  });

  it('binds to every interface, or nothing outside the container connects', () => {
    expect(stage('web')).toMatch(/HOSTNAME=0\.0\.0\.0/);
  });

  it('copies the three things the standalone bundle needs', () => {
    // Verified by running exactly this layout: server.js plus .next/static for
    // the hashed assets and public/ for the icons and the service worker.
    const web = stage('web');
    expect(web).toMatch(/\.next\/standalone/);
    expect(web).toMatch(/\.next\/static/);
    expect(web).toMatch(/\/app\/public/);
  });

  it('has a healthcheck that fails when the database is unreachable', () => {
    // So a rolling deploy does not route traffic to an instance that cannot
    // answer. /api/health returns 503 in that case.
    expect(stage('web')).toMatch(/HEALTHCHECK/);
    expect(stage('web')).toMatch(/api\/health/);
    // curl is not in the slim image; adding it to make one request would be
    // the only reason it was there.
    expect(stage('web')).not.toMatch(/curl.*api\/health/);
  });

  it('installs dependencies from the lockfile, not from the registry', () => {
    // Comments stripped first: the Dockerfile EXPLAINS why it is not `npm
    // install`, and a plain grep finds the explanation.
    const code = dockerfile
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(code).toMatch(/npm ci/);
    expect(code).not.toMatch(/npm install\b/);
  });

  it('takes no secret as a build argument', () => {
    // An ARG is visible in `docker history` forever.
    expect(dockerfile).not.toMatch(/^ARG .*(SECRET|KEY|PASSWORD|TOKEN)/im);
  });
});

describe('the dockerignore', () => {
  const ignored = file('.dockerignore');

  it('keeps .env out of every layer', () => {
    // `docker history` shows layers even after a later step deletes a file.
    expect(ignored).toMatch(/^\.env$/m);
  });

  it('keeps database dumps out', () => {
    // A dump is every customer's phone number and home address in one file.
    expect(ignored).toMatch(/^backups\/$/m);
  });

  it('keeps the inputs the ops image needs IN', () => {
    // scripts/ and src/ are what the ops image runs, so they must not be
    // excluded — a tidy-up that adds them would break every job.
    expect(ignored).not.toMatch(/^scripts/m);
    expect(ignored).not.toMatch(/^src/m);
  });
});

// -----------------------------------------------------------------------------
// The compose deployment
// -----------------------------------------------------------------------------

describe('docker compose', () => {
  const compose = yaml<Compose>('docker-compose.yml');

  it('runs the order sweep, which is not optional', () => {
    // Without it: no dispatch, no notifications, no timeouts, no refunds.
    // Orders sit there forever.
    const cron = compose.services.cron!;
    expect(cron.command).toMatch(/jobs:orders/);
    expect(cron.build?.target).toBe('ops');
  });

  it('runs a backup AND the restore drill', () => {
    const backup = compose.services.backup!;
    expect(backup.command).toMatch(/db:backup/);
    expect(backup.command).toMatch(/db:restore-check/);
  });

  it('points the restore drill at the volume the dumps land on', () => {
    // The drill defaults to ./backups next to the source, which inside a
    // container is not where the mounted dumps are — it would report "no
    // dumps" while backups piled up elsewhere.
    const backup = compose.services.backup!;
    expect(backup.volumes?.some((v) => v.includes(':/backups'))).toBe(true);
    expect(backup.command).toMatch(/db:backup -- --dir \/backups/);
    expect(backup.command).toMatch(/db:restore-check -- --dir \/backups/);
  });

  it('defines the ops service the documentation tells people to run', () => {
    const ops = compose.services.ops!;
    expect(ops.build?.target).toBe('ops');
    // Under a profile, so `docker compose up` does not start a container whose
    // whole purpose is to be invoked with a job.
    expect(ops.profiles).toContain('tools');
    expect(ops.environment?.DIRECT_URL).toBeDefined();
  });

  it('does not expose the database to the host', () => {
    expect(compose.services.db!.ports).toBeUndefined();
  });

  it('does not put the application on a public port', () => {
    // The thing facing the internet should be a reverse proxy holding the
    // certificate: the session cookie is `secure`, so plain http means nobody
    // stays signed in.
    for (const port of compose.services.web!.ports ?? []) {
      expect(port).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('refuses to start without a password and a secret', () => {
    const raw = file('docker-compose.yml');
    expect(raw).toMatch(/POSTGRES_PASSWORD:\$\{POSTGRES_PASSWORD:\?|POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
    expect(raw).toMatch(/AUTH_SECRET: \$\{AUTH_SECRET:\?/);
  });

  it('pins the database to the major version the schema was written against', () => {
    expect(compose.services.db!.image).toMatch(/^postgres:16/);
  });
});
