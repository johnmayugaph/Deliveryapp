# Deliveryapp

A multi-service delivery app for the Philippine market: **Kainan** (food),
**Tindahan** (mart), **Padala** (parcel), **Pabili**, and **Sakay** (rides) —
one product, not five apps sharing a login.

Only Kainan is live. The other four exist in the database as coming-soon
records so the home screen can show them greyed out, which measures demand
before any of them costs engineering time.

- **[docs/architecture.md](docs/architecture.md)** — how it is built and why.
- **[docs/PROGRESS.md](docs/PROGRESS.md)** — what is done and what is next.

## The two rules

1. **A vertical is data, not a branch.** There is no hardcoded list of services
   and no `if (serviceType === 'FOOD')` in shared logic. Everything reads the
   `Service` registry. Enforced by ESLint and by
   `src/tests/no-service-branches.test.ts`.
2. **Credits are a ledger.** No top-up, no transfers, no cash-out; spendable on
   orders only. Every balance change goes through one function that recalculates
   the balance from the ledger. Enforced in code, in tests, and by SQL triggers.

## Getting started

Requires Node ≥ 20.11 and PostgreSQL. `psql` must be on `PATH` to apply the SQL
guards.

```bash
npm install
cp .env.example .env          # then point DATABASE_URL at your database
npm run prisma:migrate        # create the schema
npm run prisma:guards         # append-only ledger triggers + CHECK constraints
npm run db:seed               # five services, three stores, two users
npm run dev
```

`npm run db:setup` runs migrate/guards/seed together against an existing
database — use it on a deploy, where the guards **must** be reapplied after
every `migrate deploy`.

The seeded demo customer is Juan Dela Cruz (`+639171234567`). Authentication is
not built yet: `src/lib/auth/session.ts` resolves that user directly, and is
the one file to replace in Phase 6.

Because that placeholder returns the same person to **every** visitor, it
refuses to run in production. `npm run dev` is unaffected; a production start
needs `ALLOW_INSECURE_DEMO_SESSION=1`, and only for a throwaway demo:

```bash
ALLOW_INSECURE_DEMO_SESSION=1 npm start
```

Order timeouts are swept by a job, not a background thread — put
`npm run jobs:orders` on a cron every minute or two, or orders will sit
waiting on a merchant forever.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | `prisma generate` then a production build |
| `npm run verify` | Typecheck + the full test suite (no database needed) |
| `npm test` | Vitest |
| `npm run lint` | ESLint, including the no-service-branch rule |
| `npm run prisma:guards` | Apply `prisma/sql/*.sql` |
| `npm run db:seed` | Seed |
| `npm run jobs:orders` | Sweep orders that waited past their vertical's timeout (cron) |

## Layout

```
prisma/
  schema.prisma          the source of truth: 24 models, 16 enums
  seed.ts                the ONLY file that enumerates the five services
  sql/                   invariants Prisma's schema language cannot express
src/
  app/                   Next.js App Router screens
  components/            presentation, plus the client-side cart
  lib/
    services/registry.ts the only reader of the Service registry
    orders/              lifecycle map, state machine, details, placement, timeouts
    wallet/              the credits ledger and its pure rules
    pricing/             delivery rates and subscription-aware checkout pricing
    fleet/               dispatch, filtered by approved services
    support/             unified tickets
  tests/                 91 tests, database-free
```

## Money

Integer **centavos**, everywhere. Percentages are **basis points** (1250 =
12.5%). Never store money as a float.
