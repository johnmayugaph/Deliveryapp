# TARA

A multi-service delivery app for the Philippine market: **Food**, **Mart**,
**Parcel**, **Errands**, and **Rides** — one product, not five apps sharing a
login.

*Tara* is the invitation everyone already uses — *let's go* — which is the
whole product in one word.

The interface is in English. Service names live in the `Service` table, so
renaming a vertical — or shipping a Filipino build — is a row edit, not a code
change.

Only Food is live. The other four exist in the database as coming-soon
records so the home screen can show them greyed out, which measures demand
before any of them costs engineering time.

- **[docs/architecture.md](docs/architecture.md)** — how it is built and why.
- **[docs/PROGRESS.md](docs/PROGRESS.md)** — what is done and what is next.

## Brand

| | |
| --- | --- |
| Wordmark | `tara`, lowercase, `font-bold`, tracking `-0.045em` — `src/components/brand/Wordmark.tsx` |
| In prose | TARA |
| Blue | `#077aff` (`brand-500`) |
| Buttons | `brand-700` `#0a56c4` — white on `brand-500` is 4.0:1, which misses AA for body text |
| Typeface | [Urbanist](https://fonts.google.com/specimen/Urbanist), 300–800, via `next/font` |

Urbanist is the closest free match to the brand artwork on the three features
that give the wordmark its character: a single-storey `a` built from a circle and
a straight stem with **no tail**, a `t` whose stem **curves into a tail** at the
baseline, and flat-cut terminals. The artwork's own face looks like Circular,
Sofia Pro or Gilroy — all commercial, and none of them identifiable from a
raster with certainty.

**To make it exact:** get the font from the file the artwork was designed in (a
Canva or Figma text layer names it), then buy a webfont licence, drop the
`.woff2` in `src/app/fonts/` and point `fontFamily.sans` at it. Nothing else
changes. For the wordmark specifically there is a better answer than a font at
all: hand over the original vector and it ships as SVG paths, which is what most
brands do with a logo.

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
database, and it is what a deploy should run: the guards **must** be reapplied
after every `migrate deploy`, and the seed is the only thing in this
repository that creates cities, services and delivery fee rules — migrations
alone leave a database the app answers `200` from while telling every customer
"No service is available in your area yet".

**Deploying for real: [`docs/DEPLOY.md`](docs/DEPLOY.md).** Every command in it
was run against a real database and a real production build, and it says what
that found.

### Signing in

Phone number plus a six-digit code — no passwords. In development there is no
SMS gateway, so **the code is printed to the server console**: sign in with the
seeded customer `0917 123 4567` and copy the code out of your `npm run dev`
output.

```
  ┌─ SMS (development) ─────────────────────────────
  │ to:   +639171234567  (0917 ••• 4567)
  │ body: 428913 is your TARA code. Do not share it with anyone. …
  └─────────────────────────────────────────────────
```

Any other Philippine mobile number works too and creates a fresh account.
In production, configure `SEMAPHORE_API_KEY` — with no gateway set, a
production build refuses to issue a code rather than pretend to send one. It
refuses before writing anything, tells the person asking that waiting will not
help, logs which variable to set, and says so on the login screen itself,
which is the only screen still reachable when nobody can sign in.

### Cron

Order timeouts are swept by a job, not a background thread — put
`npm run jobs:orders` on a cron every minute or two, or orders will sit waiting
on a merchant forever. The same job creates dispatch offers, **delivers the
notification outbox**, ends lapsed subscriptions, and prunes spent login codes
and dead sessions.

Nothing on a request path waits for an SMS gateway, so how quickly a store hears
about a new order is bounded by how often this runs.

### Notifications

One inbox per account at `/notifications`, shared across all three apps, plus
two channels that reach a closed tab.

**Push** carries everything, because it costs nothing per message. It needs a
VAPID key pair, generated once:

    npm run push:keys        # then paste the three lines into .env

Keep that pair. Rotating it does not rotate a credential — it invalidates every
existing subscription, because each browser bound its subscription to the public
key it was handed. RFC 8291 encryption and RFC 8292 tokens are implemented here
rather than pulled in, and the output is pinned byte-for-byte against the
reference implementation in `src/tests/push-crypto.test.ts`.

**SMS** is the expensive fallback, for the messages where somebody is waiting on
an action: a new order, a dispatch offer, a rider at the door, a cancellation.
Progress updates never text — every informational text is a peso spent to be
slightly annoying. To prove a gateway works before trusting it:

    npm run sms:send-one -- 09171234567

In development the texts print to the `npm run dev` console like login codes do.
Quiet hours are 22:00–06:00 Manila and apply to both channels: informational
messages wait for morning, operational ones do not.

With a channel unconfigured, its deliveries stay PENDING rather than being
discarded — `/admin/health` is where that shows up, and the backlog goes out on
the first pass after the keys appear.

### The merchant side

A store's back office lives at `/merchant`. Sign in as one of the seeded
merchants and the customer profile offers a link in:

| Number | Who | Access |
| --- | --- | --- |
| `0917 000 1111` | Nena Bautista | Owner of Aling Nena Carinderia |
| `0917 000 2222` | Ben Ocampo | Owner of two stores — exercises the picker |
| `0917 000 3333` | Rosa Lim | Staff at Nena's: everything but Payouts |
| `0917 000 9999` | Ops Admin | Grants subscriptions and ledger adjustments |

Tabs a member's role cannot open are not shown. Payouts is the only screen
that refuses outright — Menu, Staff and Settings admit a staff member and
degrade to read-only, which is why they are still listed for one. Which role
reaches which screen lives in `src/lib/merchant/roles.ts`, and the tab bar and
the staff screen's role explanation both read from it, so what an owner is told
a role grants cannot drift from the gate that runs.

On the **Settings** tab, the first thing a shop sees is whether customers can
order from it — and if not, what is stopping it and who can clear it. Every
reason on that list is one the customer's own path applies: TARA has taken the
shop off the app, no service is attached, the service has not launched in this
city, delivery is not priced there, nothing on the menu is available, or the
shop is simply closed. The rules are gathered in
`src/lib/merchant/storefront-policy.ts`, and the facts come from the same
places a customer's request reads them, so the panel cannot tell a shop it is
open for business when checkout would refuse.

The header of every merchant screen agrees with it. The Bukas/Sarado pill used
to be emerald whenever the shop's own switch was on, so a shop TARA had taken
off the app read *open* on six screens out of seven. It now turns amber when
opening would change nothing, with one line under it naming the problem and a
tap to Settings for the reason. The switch is never disabled — it is the shop's
most urgent control and a kitchen that has run out of rice must still be able
to stop orders.

Two distinctions on that screen are load-bearing. Being *closed* is not a
fault: a kitchen that shut at 10pm is told everything else is ready, with no
button offered, because the switch is already in the header. And *nobody can
find you* is kept apart from *they find you and cannot finish* — from behind
the counter both are an empty queue, and they are different phone calls. The
services list says whether each service is live **in this shop's city**, not
whether TARA has launched it somewhere.

On the **Staff** tab, both places a role is chosen say what it means: what each
rung adds over the one below, with the takings called out, and the money role
marked on the dropdown option itself.

On the **History** tab, a finished order that had a discount says so and says
who paid for it — the benefit, the status that conferred it, and the amount,
with one line under the list confirming the shop's own share was untouched. It
describes the benefit rather than the customer on purpose: a tier is derived
from recent points and is not stored on the order, so an old receipt cannot
honestly name one where no benefit applied.

The **Regulars** tab answers the two questions a shop has about TARA's loyalty
statuses: how much of its business comes from customers who have earned one,
and what those benefits cost the shop — which is nothing, because the shop is
paid its full food subtotal less its usual commission whatever discounts the
customer had. The one exception is dispatch priority, which really does reorder
the rider queue, and the screen says so plainly rather than only listing what
a status gives.

### If somebody loses their phone

The phone number is the identity, so losing it used to mean losing the account.
Two routes back, and both go through the same one function so neither can skip a
safeguard.

**Self-service**, at `/recover`: a code to an email address the person confirmed
*before* they lost the number, then a code to the new number. Two channels —
email alone never grants a session and never moves anything, it only earns the
right to prove control of a new number. Needs `RESEND_API_KEY` and `EMAIL_FROM`;
with neither set the route says so plainly rather than failing later.

**Support-assisted**, on the person's page in `/admin`: for the majority who
never added an email. The reason field is the verification — write what you
actually checked, because "customer asked" is the shape a social-engineering
success takes and it stays in the log.

Four things happen either way, and an administrator cannot turn any of them off:

- **Credits are frozen for three days.** This is the control that matters. It
  does not make takeover harder, it makes it *worthless* — the balance cannot be
  spent until long after the alert has landed. The ledger computes the freeze
  from `frozenUntil` on every spend, so it lifts the instant it expires.
- **The old number is texted.** Sent from `AccountRecovery.previousPhone`, which
  after the change is the only place that number survives. Deliberately NOT
  through the notification outbox — the outbox resolves recipients from the user
  row, which now holds the new number, so it would send the warning to whoever
  triggered it.
- **Every session is revoked**, including an attacker's.
- **An append-only row records it**, with the method, both numbers, and the
  reason. Only the alert columns can ever be updated.

The remaining hole is honest: somebody who controls both the old email and the
new phone can do this. What the freeze and the alert buy is time to notice.

### The admin console

`/admin`, for an account with the `ADMIN` role. The seed creates one:
`+639170009999`.

Six screens: an overview of what is happening right now across every service,
orders with registry-driven filters, people by search, the launch switches, the
notification delivery health, and the audit log.

Three things about it are load-bearing rather than incidental:

- **Every action is authorised server-side, in the action itself.** Not in
  middleware — that runs on the edge runtime where Prisma is unavailable, so it
  can see a session cookie but not whose it is. Not only in the layout either: a
  server action is its own entry point.
- **Nothing privileged happens without an audit row**, written in the same
  transaction as the change it describes, with a reason of at least eight
  characters. The table refuses UPDATE and DELETE by trigger, so the log cannot
  be edited by the people it is about.
- **Credits go through the ledger.** The console cannot set a balance; it calls
  `recordAdjustment`, which writes a `WalletTransaction` and recalculates. A
  single adjustment is capped at ₱500 — a support tool that can issue unlimited
  credit is a support tool that will.

Launching a vertical is two form posts on `/admin/services`: available in a
city, then live. No deploy. A service with no city cannot be switched on, and
withdrawing its last city switches it off.

### The subscription tier

*TARA Plus* is seeded **inactive**. `npm run plan:activate -- plus-monthly`
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
customer and a fleet partner on one account — approved for Food, pending for
Rides, which is the per-service model in action.

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
| `npm run push:keys` | Generate the VAPID pair. Once, ever — see Notifications |
| `npm run db:purge-user` | Permanently remove an account. Blocking is almost always what you want |
| `npm run sms:send-one` | Send one real SMS, to prove a gateway works |

## Layout

```
prisma/
  schema.prisma          the source of truth: 35 models, 26 enums
  seed.ts                the ONLY file that enumerates the five services
  sql/                   invariants Prisma's schema language cannot express
src/
  app/                   Next.js App Router screens
  components/            presentation, plus the client-side cart
  lib/
    services/registry.ts the only reader of the Service registry
    auth/                phone normalisation, one-time codes, sessions, SMS
      email/             addresses, and the provider behind recovery codes
      recovery.ts        the one function that moves a phone number
    orders/              lifecycle map, state machine, details, placement, timeouts
    wallet/              the credits ledger and its pure rules
    pricing/             delivery rates and subscription-aware checkout pricing
    fleet/               dispatch, offers, and the partner's own view
    subscriptions/       plans, enrollment, renewal, and the unbuilt charge seam
    notifications/       the outbox: policy, templates, channels, delivery
      push/              RFC 8291 encryption, RFC 8292 tokens, the send
    admin/               console authorisation, the audit trail, its queries
    merchant/            store access and the order queue
    support/             unified tickets
  tests/                 450 tests, database-free
```

## Money

Integer **centavos**, everywhere. Percentages are **basis points** (1250 =
12.5%). Never store money as a float.
