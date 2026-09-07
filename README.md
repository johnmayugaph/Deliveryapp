# Deliveryapp

A multi-service delivery app for the Philippine market: **Kainan** (food),
**Tindahan** (mart), **Padala** (parcel), **Pabili**, and **Sakay** (rides) —
one product, not five apps sharing a login.

Only Kainan is live. The other four exist in the database as coming-soon
records so the home screen can show them greyed out, which measures demand
before any of them costs engineering time.

- **[docs/architecture.md](docs/architecture.md)** — how it is built and why.
- **[docs/PROGRESS.md](docs/PROGRESS.md)** — what is done and what is next.

## The three rules

1. **A vertical is data, not a branch.** There is no hardcoded list of services
   and no `if (serviceType === 'FOOD')` in shared logic. Everything reads the
   `Service` registry. Enforced by ESLint and by
   `src/tests/no-service-branches.test.ts`.
2. **Credits are a ledger.** No top-up, no transfers, no cash-out; spendable on
   orders only. Every balance change goes through one function that recalculates
   the balance from the ledger. Enforced in code, in tests, and by SQL triggers.
3. **Prices come from the database, never from the client.** A request carries
   identifiers and quantities. `quoteCheckout()` is the only thing that prices a
   cart, and placement calls it again for the number it charges.

## Getting started

Requires Node ≥ 20.11 and PostgreSQL. `psql` must be on `PATH` to apply the SQL
guards.

```bash
npm install
cp .env.example .env          # point DATABASE_URL at your database, and set
                              # AUTH_SECRET (openssl rand -hex 32)
npm run prisma:migrate        # create the schema
npm run prisma:guards         # append-only ledger triggers + CHECK constraints
npm run db:seed               # five services, three stores, two users
npm run dev
```

`npm run db:setup` runs migrate/guards/seed together against an existing
database — use it on a deploy, where the guards **must** be reapplied after
every `migrate deploy`.

### Signing in

Phone number plus a six-digit code — no passwords. In development there is no
SMS gateway, so **the code is printed to the server console**: sign in with the
seeded customer `0917 123 4567` and copy the code out of your `npm run dev`
output.

```
  ┌─ SMS (development) ─────────────────────────────
  │ to:   +639171234567  (0917 ••• 4567)
  │ body: 428913 ang Deliveryapp code mo. …
  └─────────────────────────────────────────────────
```

Any other Philippine mobile number works too and creates a fresh account.
In production, configure `SEMAPHORE_API_KEY` — with no gateway set, a
production build refuses to start a login rather than pretend to send a code.

### Cron

Order timeouts are swept by a job, not a background thread — put
`npm run jobs:orders` on a cron every minute or two, or orders will sit waiting
on a merchant forever. The same job prunes spent login codes and dead sessions.

### The merchant side

A store's back office lives at `/merchant`. Sign in as one of the seeded
merchants and the customer profile offers a link in:

| Number | Who | Access |
| --- | --- | --- |
| `0917 000 1111` | Nena Bautista | Owner of Aling Nena Carinderia |
| `0917 000 2222` | Ben Ocampo | Owner of two stores — exercises the picker |
| `0917 000 3333` | Rosa Lim | Staff at Nena's: queue only, no prices |
| `0917 000 9999` | Ops Admin | Grants subscriptions and ledger adjustments |

### The subscription tier

*Deliveryapp Plus* is seeded **inactive**. `npm run plan:activate -- plus-monthly`
turns it on everywhere — the pricing engine, `/plus` and enrollment all read that
one flag.

It cannot be **sold** yet, and that is deliberate: the app bills cash on delivery
or credits, and credits are spendable on orders only, so neither rail can take a
monthly fee. Paid enrollment is refused until a gateway exists. Granting works:

```bash
npm run plan:comp -- 0917 123 4567 --by 0917 000 9999 "Pilot cohort"
npm run plan:comp -- 0917 123 4567 --cancel
```

`0917 000 9999` is the seeded ops admin. A grant must name its grantor and a
reason — enforced by a CHECK constraint, not just by the script.

### The fleet side

A partner's app lives at `/fleet`. Maria (`0918 987 6543`) is seeded as both a
customer and a fleet partner on one account — approved for Kainan, pending for
Sakay, which is the per-service model in action.

Any other account can apply at `/fleet/apply`. Approval is **not** self-service;
approve from the command line:

```bash
npm run fleet:approve -- 0917 555 1234 FOOD
npm run fleet:approve -- 0917 555 1234 --reject RIDE "Expired licence"
```

Dispatch has no background worker — offers are created by `npm run jobs:orders`,
so run it (or wait for your cron) after a merchant marks an order ready.

### The whole loop

With all three sides in place an order goes: customer orders → merchant accepts,
cooks, marks ready → cron dispatches → partner accepts, collects, delivers →
order completes and any subscription credit-back is granted. Nothing needs
touching by hand.

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
| `npm run jobs:orders` | Dispatch offers, order timeouts, auth housekeeping (cron) |
| `npm run fleet:approve` | Approve or reject a fleet partner for a service |
| `npm run plan:activate` | List plans, or launch/pull one — the whole launch switch |
| `npm run plan:comp` | Grant or end a subscription, attributed to an admin |

## Layout

```
prisma/
  schema.prisma          the source of truth: 28 models, 18 enums
  seed.ts                the ONLY file that enumerates the five services
  sql/                   invariants Prisma's schema language cannot express
src/
  app/                   Next.js App Router screens
  components/            presentation, plus the client-side cart
  lib/
    services/registry.ts the only reader of the Service registry
    auth/                phone normalisation, one-time codes, sessions, SMS
    orders/              lifecycle map, state machine, details, placement, timeouts
    wallet/              the credits ledger and its pure rules
    pricing/             delivery rates and subscription-aware checkout pricing
    fleet/               dispatch, offers, and the partner's own view
    subscriptions/       plans, enrollment, renewal, and the unbuilt charge seam
    merchant/            store access and the order queue
    support/             unified tickets
  tests/                 260 tests, database-free
```

## Money

Integer **centavos**, everywhere. Percentages are **basis points** (1250 =
12.5%). Never store money as a float.
