# Progress

Living record of what is built, what is next, and what was decided along the
way. Updated with each phase.

---

## Note on phase numbering

The brief that produced this commit described itself as **superseding Phase 4
onward** of an existing plan, and asked for its changes to be folded into the
schema **before Phase 2 ran**.

When the brief arrived this repository had **zero commits** — no plan, no
schema, no `docs/`, nothing to supersede or amend. So rather than write a
Phase 4 and immediately replace it, the phases below are renumbered around what
actually happened:

- The brief's eight decisions are the **foundation**, not a revision to one.
- Because Phase 2 (schema migration) had not run, the changes are in the
  **initial migration** — `20260906134534_unified_multi_service_schema` — rather
  than a follow-up. That is exactly what "fold into the schema before Phase 2
  runs" asked for, and it means there is no legacy `RiderProfile` table, no
  food-only `Order`, and no migration to walk back.
- Phases 0–4 below are complete in this commit. Phases 5+ are the road ahead
  and replace whatever the original Phase 4 onward would have been.

If a plan document turns up elsewhere and its numbering matters, the mapping is:
this commit delivers everything the old plan's Phases 1–3 would have, with the
brief's changes already folded in.

---

## Status at a glance

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Toolchain and repository foundation | ✅ Done |
| 1 | Domain model design — registry, unified order, identity, fleet, credits, subscription | ✅ Done |
| 2 | Schema, initial migration, SQL guards, seed | ✅ Done |
| 3 | Core backend: state machine, credits ledger, pricing, dispatch, support | ✅ Done |
| 4 | Customer app shell: home, unified orders, credits, profile, help | ✅ Done |
| 5 | FOOD checkout end to end | ✅ Done |
| 6 | Real authentication (OTP) | ✅ Done |
| 7 | Merchant back office | ✅ Done |
| 8 | Fleet partner app | ✅ Done |
| 9 | Subscription tier: enrollment, renewal, plan screen | ✅ Built, launch gated |
| 10 | Second vertical | ⬜ Gated on demand |
| 11 | Notifications: outbox, inbox, SMS | ✅ Done |

---

## Phase 0 — Foundation ✅

Next.js App Router + React + TypeScript, Prisma against PostgreSQL, Tailwind,
Vitest. Strict TypeScript including `noUncheckedIndexedAccess`.

ESLint carries a `no-restricted-syntax` rule rejecting any comparison against a
service-key literal, so the registry rule is caught at edit time rather than in
review.

## Phase 1 — Domain model ✅

All eight decisions from the brief, in full. See
[architecture.md](./architecture.md) for the reasoning behind each; the headline
choices:

- **Service registry.** Five `Service` rows; `FOOD` active, four
  `isComingSoon`. No hardcoded service list and no service-key branch anywhere,
  enforced by a grep test and by ESLint.
- **Unified order.** One `Order` table, shared columns real, vertical-specific
  fields in a validated `details` JSON container. Only the FOOD shape is
  implemented; the other four are written down and fail loudly.
- **Status handling.** One superset enum; allowed transitions defined **per
  service** in `ORDER_LIFECYCLES`. PARCEL skips merchant acceptance entirely.
  The state machine reads the map and contains no service-key literal.
- **Unified identity.** One `User` per person, `roles` as an **array**. One
  address book with `usageCount`, `lastUsedAt` and `isPickupCapable`.
- **Unified fleet.** `RiderProfile` → **`FleetPartner`**, with
  `enabledServices`, `vehicleType`, and per-service verification. Dispatch reads
  `enabledServices`; ranking logic unchanged.
- **Credits.** Ledger-only. No top-up, no transfers, no cash-out, spendable on
  orders only — enforced in code, in tests, and by SQL triggers and CHECK
  constraints. Balance derived from the ledger, never written directly.
- **Subscription.** Structured benefit records the pricing engine reads. One
  seeded plan, **inactive**.
- **Unified support.** One `SupportTicket` across all verticals; help section
  driven by the registry.

### Decisions worth remembering

- **Money is integer centavos everywhere.** Percentages are basis points, so
  7.5% needs no migration.
- **Address snapshots are denormalised onto orders.** An order must stay
  readable after the source address changes or is deleted.
- **`requiresMerchant` ≠ merchant acceptance.** The first is "must reference a
  store" (FOOD, MART); the second is a lifecycle step that only FOOD has.
  Conflating them is how the `if FOOD` branches come back.
- **`Service.intentGroup` owns grouping; the label file owns names.**
  `intent-groups.ts` contains no service keys, so regrouping the home screen is
  a data edit. Group names say what somebody is trying to do: *Food & grocery*,
  *Send & buy*, *Rides*, *Pay*.
- **`SupportTicket.serviceType` is nullable.** A literal reading of the brief
  would make it required, but an account-level problem belongs to no vertical
  and forcing one would make the data lie.
- **Free delivery does not zero the fee.** The fee stays at full value and the
  waiver is a discount line, so the receipt shows the customer what the tier
  bought them — and so the amount is not subtracted twice. (It was, briefly;
  the tests caught it.)
- **Credit-back is not a discount.** The customer pays full price and the
  credits arrive on completion, through the ledger.
- **Quoting writes nothing.** Benefit usage is committed only once the order
  exists, so an abandoned checkout cannot burn a monthly allowance.

## Phase 2 — Schema and data ✅

- `prisma/schema.prisma`: 28 models, 18 enums.
- Initial migration `20260906134534_unified_multi_service_schema`.
- `prisma/sql/wallet_append_only.sql`: append-only triggers on the credits
  ledger plus five CHECK constraints. Applied by `npm run prisma:guards`.
- `prisma/seed.ts`: 5 cities, 5 services (FOOD active in 3 cities), 3 stores
  with menus, 3 FAQ categories, 1 inactive subscription plan with 3 structured
  benefits, 2 promotions, 2 users — one of whom holds both `CUSTOMER` and
  `FLEET_PARTNER` on a single record, approved for FOOD and pending for RIDE.

`prisma/seed.ts` is the **only** file in the codebase that enumerates the five
services. That is the point of the registry.

## Phase 3 — Core backend ✅

| Module | Responsibility |
| --- | --- |
| `lib/services/registry.ts` | The only reader of the registry |
| `lib/orders/transitions.ts` | Per-service lifecycle config map |
| `lib/orders/state-machine.ts` | Reads the map; atomic, audited, concurrency-guarded |
| `lib/orders/details.ts` | Per-service details shapes; FOOD implemented |
| `lib/wallet/rules.ts` | Pure ledger rules — sign derivation, replay |
| `lib/wallet/ledger.ts` | The single mutation entry point |
| `lib/pricing/benefits.ts` | Pure benefit arithmetic |
| `lib/pricing/checkout.ts` | Registry + subscription + credits orchestration |
| `lib/fleet/dispatch.ts` | Candidates filtered by `enabledServices` |
| `lib/addresses/usage.ts` | Shared address book and order snapshots |
| `lib/support/tickets.ts` | Unified tickets and registry-driven FAQ |

## Phase 4 — Customer app shell ✅

Home (`/`) rebuilt around service selection: location with tap-to-change,
cross-service search, intent-grouped registry-driven tiles with dimmed
non-tappable coming-soon states, active-order strip across all verticals,
promotions, recent stores.

Bottom navigation Home / Orders / Credits / Profile. `/orders` is one
chronological list across every service. Also `/credits` (with the four
constraints stated in plain Filipino), `/profile` (roles from the array, fleet
approvals per service), `/help`, `/search`, `/addresses`, `/services/[key]`,
`/orders/[orderId]`, `/stores/[slug]`.

### Verification

- `npm run verify` — **62 tests**, all passing, no database needed.
- Verified against live PostgreSQL 16 with the SQL guards applied — **42
  end-to-end checks**, all passing.
- `npm run build` and `npm run lint` clean; every route returns 200 against
  seeded data.

---

## Phase 5 — FOOD checkout end to end ✅

The first real order. An order now goes cart → checkout → placement → tracking
→ completion or cancellation, verified through a browser as well as in tests.

### What was built

| Area | Detail |
| --- | --- |
| Delivery pricing | `DeliveryFeeRule` table keyed by `(serviceType, cityId)`; pro-rata per-km beyond an included distance; floors, ceilings, small-order and free-delivery thresholds. No rates in code. |
| Cart | `localStorage` via `CartProvider`; quantity steppers on the store menu; a cart bar showing a count, never a total. |
| Checkout | `/checkout` with address selection, tip, payment method, credits toggle and a server-computed breakdown. |
| Placement | `placeOrder()` — one `Serializable` transaction: order + address snapshots + `submitOrder()` + benefit usage + credits debit + address usage. |
| Timeouts | Per-service `timeouts` in the lifecycle config; `expireStaleOrders()` sweeps them and refunds credits. `npm run jobs:orders`. |
| Completion | `completeOrder()` grants accrued credit-back through the ledger. |
| Cancellation | Customer cancel, permitted only where the transition map allows, refunding credits to credits. |
| Tracking | Self-polling while live, pausing on a hidden tab, stopping at a terminal state. |
| Reference numbers | `DA-20260906-K3M9Q` — collision-resistant, replacing a `count()`-based generator. |

### Decisions worth remembering

- **Prices are re-read from the database, never taken from the client.** A
  request carries identifiers, quantities and notes — never a price.
  `quoteCheckout()` is the only thing that prices a cart, and `placeOrder()`
  calls it again for the number it charges, so displayed and charged totals
  cannot drift.
- **Rates are data.** `DeliveryFeeRule` exists so ops can change a fee without a
  deploy. `delivery-fee.ts` holds no numbers.
- **A city with no rule cannot be quoted.** Throwing beats silently applying a
  Manila rate in Cebu.
- **The cart is not a DRAFT order.** A quantity stepper should not write to
  Postgres. `DRAFT` exists for the placement transaction only.
- **Timeouts are lifecycle config, not job code.** The sweeper reads the map and
  knows nothing about merchants or budgets. A test asserts every timeout is a
  legal transition, so a bad policy fails in CI rather than at 3am.
- **Credit refunds read the ledger, not the order column.** The ledger is the
  truth about what was taken, and netting off prior refunds makes the operation
  idempotent.
- **Paying with credits is all or nothing.** Credits are the only non-cash rail,
  so a shortfall is refused with an explanation rather than part-charged.
- **The placeholder session now fails closed.** It returned the same seeded user
  to every visitor with no request state involved, so on a public URL every
  visitor would have been Juan Dela Cruz — including on `/orders` and
  `/credits`, where the ownership check would have passed for all of them. It
  refuses in production unless `ALLOW_INSECURE_DEMO_SESSION=1`. Note the
  consequence: `npm run build && npm start` locally needs that flag.

### Things fixed along the way

- **`RIDER_ASSIGNED` allowed only SYSTEM**, which contradicted
  `FleetPartner.acceptanceRate` — that field only means something if partners
  *accept* offers. Now permits `FLEET_PARTNER` too, with a test.
- **`count()`-based ticket numbers** would collide under concurrency and fail an
  insert at random. Replaced.
- **`commitBenefitUsage` and `spendOnOrder`** opened or used their own client,
  so their work sat outside the caller's transaction. Both now compose.
- **Two copies of `haversineMeters`** — factored into `src/lib/geo.ts`.
- **The tracking screen's "Susunod" hint** listed every cancellation state,
  reading as a menu of ways the order might fail. Forward path only.
- **The cart bar rendered on `/checkout`**, where it is redundant and covered
  the total. Hidden there and on `/orders`.

### Verification

- `npm run verify` — **91 tests** (up from 62), no database needed.
- **53 end-to-end checks** against live PostgreSQL 16, on top of the
  foundation's 42. Idempotent: the ledger is reset with a compensating
  `ADJUSTMENT` rather than a delete, since it is append-only.
- Driven through a real browser end to end: three items added, a ₱449 quote
  (₱400 subtotal + ₱39 delivery over 0.7km + ₱10 service fee), a tip re-quoting
  to ₱499, placement, tracking with ETA and timeline, cart cleared, the order
  appearing in the unified history, then cancellation.
- `npm run jobs:orders` swept six orders left waiting past the merchant window.

## Phase 6 — Authentication ✅

Phone number plus a one-time code. The placeholder is gone, along with its
`ALLOW_INSECURE_DEMO_SESSION` escape hatch.

### What was built

| Area | Detail |
| --- | --- |
| Phone normalisation | Every way a Filipino writes their number (`0917…`, `+63 917…`, `639…`, dashes, brackets) collapses to one E.164 identity. Landlines rejected. |
| One-time codes | 6 digits, 5-minute expiry, 5 attempts, HMAC-keyed with `AUTH_SECRET`, constant-time compare, single use, newest-code-wins. |
| Throttles | 45s resend cooldown, 3 codes per phone per 15 min, 12 per source address per hour — each refusal saying when to come back. |
| Sessions | Opaque 256-bit token in an httpOnly cookie; only its SHA-256 hash stored. Sliding 30-day window, revocable, with a live-sessions list and "sign out everywhere else". |
| SMS | Provider interface; console sender for development, Semaphore adapter for production, and a hard refusal to run production with neither. |
| Signup | Login and signup are the same request. The account is created when the code is verified, with no name; `/welcome` collects it. |
| Route protection | `src/middleware.ts` for a cheap cookie-presence bounce; real validation server-side on every page and action. |
| Housekeeping | Spent codes and dead sessions pruned by `npm run jobs:orders`. |

### Decisions worth remembering

- **`User.fullName` is nullable now.** A phone-first signup knows the number
  before the name. A placeholder in that column would make every reader guess
  whether the value was real; `onboardedAt` gates the app instead.
- **No enumeration.** Requesting a code answers identically whether the number
  is registered or not, and "no code outstanding" reads the same as "wrong
  code" so the form is not an oracle.
- **Codes are HMAC-keyed, sessions are plain SHA-256.** Six digits is a million
  possibilities, so a code needs a secret to resist an offline attack. A
  256-bit random token has no dictionary, so keying it would only tax every
  request.
- **Sessions are server-side rows, not JWTs.** A signed token asserting "valid
  for 30 days" cannot be revoked when a phone is stolen.
- **Sign-out revokes, it does not delete.** History survives, and a stolen
  token cannot be resurrected by re-inserting a row.
- **Middleware is not load-bearing.** It cannot reach Prisma on the edge
  runtime, so it only bounces obviously signed-out traffic. A forged cookie
  gets past it and then resolves to nobody — verified.
- **Production refuses the console SMS sender.** A sender that writes to a
  terminal nobody reads would make every login report success while no code
  arrives. That is worse than failing loudly.
- **The login form works without JavaScript.** For low-end Android phones on
  patchy mobile data this is not a nicety: a `useState`-driven form loses what
  was typed before hydration and leaves the button disabled.

### Things fixed along the way

- **The login form 500'd before hydration.** `getClientIp()` calls `headers()`,
  which is unavailable on the native form-post path — so a pre-hydration login
  failed outright. A throttling input must never fail a sign-in; it is now
  wrapped and degrades to the per-phone throttle.
- **`INITIAL_LOGIN_STATE` was exported from a `'use server'` module**, where
  only async functions may be exported. It never reached the client as the value
  written, so the login screen rendered on its *second* step. Moved to
  `src/lib/auth/login-state.ts`.
- **Server actions were calling other server actions**, which loses the request
  scope `headers()` and `cookies()` need. The orchestration moved to plain
  functions in `src/lib/auth/login.ts`; actions read request values and pass
  them in.
- **`middleware.ts` at the repo root did nothing.** With a `src/` directory
  Next expects `src/middleware.ts`. Every route was reachable signed out until
  it moved.
- **Ticket numbers and the login page's redirect validation** were duplicated
  logic; both now use one implementation.

### Verification

- `npm run verify` — **186 tests** (up from 91), no database needed.
- **33 end-to-end checks** against live PostgreSQL 16: the plaintext code never
  in the database, only the newest code working, single use, lockout after five
  wrong guesses (and the *right* code refused afterwards), expiry, an
  undelivered code consumed rather than left usable, a landline rejected before
  any SMS, a code requested as `+63` verifying as `09xx`, session lookup by
  hash, and pruning.
- Driven through a real browser: signed-out redirect carrying the destination →
  bad number → code sent → wrong code → real code → `/welcome` → onboarding
  gate blocking `/checkout` → name → session across pages → httpOnly cookie
  unreadable by script → sign-out → forged cookie rejected with no data leaked
  → sign back in as an existing account, skipping `/welcome`.

## Phase 7 — Merchant back office ✅

Taken ahead of the fleet app, because it was the binding constraint: until
something could accept an order, every order placed was cancelled by the timeout
sweep eight minutes later.

### What was built

| Area | Detail |
| --- | --- |
| Store access | `StoreMember` join table with OWNER / MANAGER / STAFF. Replaces the unused `Store.ownerUserId`. |
| Authorisation | `requireStoreAccess(storeId, minRole)` and `requireOrderStoreAccess(orderId)` — the latter reads the store from the order's own record. |
| Queue | Three stages from the kitchen's own rhythm; per-card buttons derived from the lifecycle map; 20-second auto-refresh. |
| Actions | Accept, start preparing, reject with a reason and credit refund, mark ready (handing to dispatch), +10 minutes with an audit event. |
| Menu | Availability toggle for STAFF; price editing for MANAGER and above. |
| Settings | Prep time, store open/closed, the store's live services from the registry, and who has access. |
| History | Finished orders with cancellation reasons. |
| Shell | Its own layout and tabs; the customer bottom nav hidden here and on the auth screens. |

### Decisions worth remembering

- **Store access is a join table, not an owner column.** The real shape is
  many-to-many both ways: an owner plus staff on one store, and one owner across
  several. An owner column forces a second source of truth the first time either
  happens.
- **Authorisation reads the ORDER's store**, never a store id sent alongside it.
  Otherwise a merchant accepts a neighbour's order by editing a form field.
- **Access failures are indistinguishable** from a missing store, so the screen
  cannot be used to probe for other stores' ids.
- **The buttons are the map's decision, not the screen's.** A card offers what
  `allowedTransitions` filtered by `isActorPermitted(..., MERCHANT)` returns, so
  a vertical with a different merchant leg gets the right controls for free.
- **Mark-ready is two transitions**, because they belong to different actors:
  the merchant says the food is ready, the SYSTEM starts looking for a rider. A
  merchant cannot do the second — finding a partner is ours.
- **A rejection reason reaches the customer verbatim.** "Wala nang adobo" beats
  a silent cancellation they have to phone about.
- **+10 minutes writes an event**, not just a new `etaAt`. A delay should be
  visible in the timeline and in support, not a quietly moved number.
- **Price editing is safe** because orders snapshot what they charged. Verified:
  changing a menu price leaves an existing order's receipt untouched.
- **STAFF can close the store.** Someone has to be able to stop orders when the
  rice runs out and the owner is not there.

### Verification

- `npm run verify` — **204 tests** (up from 186).
- **34 end-to-end checks** against live PostgreSQL 16, including a second
  store's queue not containing the first's orders, menu writes scoped to the
  store, an accepted order surviving the timeout sweep while an unaccepted one
  of the same age is cancelled, and a price change not rewriting an existing
  order.
- Driven through a real browser with two sessions side by side: a customer
  places an order while the merchant accepts it, marks it preparing, adds ten
  minutes, marks it ready; then rejects a second order with a reason the
  customer reads on their tracking screen. Plus a two-store owner getting a
  picker, and both a rival merchant and a customer getting not-found on somebody
  else's store.

## Phase 8 — Fleet partner app ✅

The loop closes here. An order now goes from a customer's cart to COMPLETED
without anybody touching the database by hand.

### What was built

| Area | Detail |
| --- | --- |
| Offers | `DispatchOffer` — a record with a 60-second window, a rank, and a response, fanned out to three partners at a time. |
| Dispatch loop | Runs on the existing cron: close lapsed offers, fan out, then the timeout sweep. No worker. |
| Acceptance rate | Recomputed from the offer record. SUPERSEDED excluded, EXPIRED counted, no history means benefit of the doubt. |
| Onboarding | Apply with a vehicle and a set of services; every service PENDING, `enabledServices` empty until approved. |
| Approval | `npm run fleet:approve -- <phone> FOOD` — a deliberate act, since approval must not be self-service and there is no admin console yet. |
| Availability | Online/offline with a position, required because dispatch ranks on distance. |
| Offers board | Only services the partner is approved for; earnings, distance, and a live countdown. |
| Active job | Both addresses, tappable contact numbers, one big next-step button chosen by the lifecycle map. |
| Give back | Returns an order to the pool rather than cancelling it. |
| Earnings | Fee plus tip, on COMPLETED orders only. |

### Decisions worth remembering

- **Offers are records, not a transient push.** Without a row saying "offered
  and unanswered", `acceptanceRate` is decorative — and the record is what makes
  the race safe.
- **SUPERSEDED does not count against anyone.** Being beaten to a job by a
  closer partner is not a decision they made; counting it would punish people
  for working in a busy area. EXPIRED does count.
- **A new partner ranks at 100%, not 0%.** `computeAcceptanceRate` returns null
  with no history and ranking substitutes 1. A zero would bury them on their
  first shift.
- **Three at a time, not one.** A sequential cascade with a 60-second window
  means a customer waits five minutes while five partners ignore their phone.
- **One offer per partner per order**, enforced by a unique key. Re-offering the
  same job to the same person destroys an acceptance rate quietly.
- **Dispatch has no worker**, and that is documented rather than hidden: latency
  is bounded by cron frequency, which the twenty-minute timeout absorbs.
- **Approval is not self-service.** Applying creates PENDING rows and nothing
  else. The approval script is the honest stand-in for an admin console.
- **Going online needs a position.** A partner with no location can never be a
  candidate, so "online" would mean receiving nothing and blaming the app.
- **A partner keeps the full delivery fee even when a subscription waived it.**
  That waiver is our marketing cost, not a pay cut — which works only because
  Phase 5 kept the fee at full value and recorded the waiver as a discount.
- **Giving a job back returns it to the pool.** The food is still on a counter;
  cancelling would throw away a recoverable order.

### Things fixed along the way

Two spurious lifecycle edges, both found by a test asking which statuses a
partner can act from:

- **A rider could cancel an order from `PENDING_PAYMENT`** and
  `PENDING_MERCHANT_ACCEPTANCE`, where no rider exists yet. `PRE_PICKUP_CANCELLATIONS`
  was applied uniformly; there is now a narrower `PRE_DISPATCH_CANCELLATIONS`
  without `CANCELLED_BY_RIDER`.
- **`READY_FOR_PICKUP → RIDER_AT_PICKUP` was unreachable.** Arriving at a store
  requires having been assigned, and assignment *is* the `RIDER_ASSIGNED`
  transition, so the edge claimed something untrue.

Neither was exploitable — the actions guard on assignment anyway — but a map
that asserts false things is a map nobody can trust.

### Two acceptance rates, one metric

Re-shooting the screens for review turned up a display bug the tests could not
see: the offers board read `FleetPartner.acceptanceRate` — the *ranking* column,
which defaults to `1` so a new partner is not buried — and rendered **94% next
to an empty offer history**, while the profile screen, which guards on the offer
records, correctly said *No offers yet* on the same account. Both screens now
compute from the records via `computeAcceptanceRate()`, the board shows an em
dash with no history, and `getPartnerEarnings()` no longer carries the field, so
the display path cannot read the ranking prior at all. Three grep tests hold the
line.

### Verification

- `npm run verify` — **233 tests** (up from 204).
- **36 end-to-end checks** against live PostgreSQL 16, including two partners
  racing one order, an ignored offer denting the rate while a lost race does
  not, dispatch reporting nobody in range, and a job handed back landing in the
  pool rather than cancelled.
- Driven through a real browser with three separate sessions: a customer places
  an order with a ₱50 tip, the merchant cooks and readies it, the cron
  dispatches, the partner accepts and works it to delivery, the customer's
  timeline reaches twelve events at COMPLETED, and a new applicant is blocked
  from going online until the approval script is run.

## Phase 9 — Subscription tier ✅ Built, launch still a decision

The pricing engine already read benefits; what was missing was every way onto a
plan, off it, and out of it. That half is now built, so launching is a decision
rather than a project.

### What landed

- **`SubscriptionOrigin`** on `UserSubscription`, required with no default:
  `PAID`, `COMPED`, `PROMOTIONAL`. Grants carry `grantedByUserId` and
  `grantNote`.
- **`src/lib/subscriptions/`** — `plans.ts` (read plans, describe benefits from
  their columns), `enrollment.ts` (enroll, cancel, month-to-date usage),
  `renewal.ts` (the term sweep), `payment.ts` (the charge seam).
- **`/plus`** — the plan built from benefit rows, month-to-date consumption for a
  subscriber, cancel, and an entry point on the profile.
- **`npm run plan:activate`** — the launch switch, and the only one.
  **`npm run plan:comp`** — grant or end a subscription, `--by` an admin, with a
  reason.
- **Three SQL guards**: one live subscription per person (partial unique index),
  a grant must name its grantor, a terminal subscription must say when it ended.
- **An ops admin in the seed** (`0917 000 9999`). Without an account holding
  ADMIN or SUPPORT_AGENT, neither a grant nor a ledger ADJUSTMENT is possible.

### The thing that decided the shape of this phase

**A paid subscription cannot be created, and that is the credits constraint
working.** The app bills cash on delivery, collected by a rider against one
order, or credits — which are rewards we grant, spendable on orders only,
enforced in code, in SQL triggers and in tests. Neither rail can take ₱99 a
month. Charging it to credits would break the constraint outright and would be a
comp wearing revenue's clothes.

So `payment.ts` holds the seam with no implementation, `PAID` enrollment is
refused at the door, and `/plus` says why instead of offering a button that
would fail. Grants are the only way onto a plan today, which is honest: they are
what we can actually deliver.

**Launching therefore means two decisions, not one.** Flipping `isActive` turns
the benefits on for anyone holding a subscription — useful immediately for a
pilot cohort, staff, or goodwill. Selling it needs a payment provider first.

### Still to decide before selling it

- Would free delivery over ₱299 (8×/month) pay for itself at current fees?
- Is the 2% credit-back ceiling of ₱200/month the right exposure?
- Does ₱99/month clear the average monthly delivery-fee spend of the customers
  most likely to subscribe?
- **Which payment provider**, and whether a paid cancellation should keep its
  benefits to the end of the term (it should; the code names both places to
  change).

### A login bug this phase's verification found

Signing in **500'd for anyone who submitted the code before the page hydrated**.
A pre-hydration submission arrives as a plain form post, which Next runs with no
request scope, so `cookies()` throws — and the session row had already been
written by then, leaving a token nobody held in the table on every attempt.

Yesterday's browser runs passed only because the script happened to wait for
hydration; this run did not, and caught it. Three changes:

1. `createSession()` resolves the cookie store **before** writing the row, and
   throws a typed `SessionCookieUnavailableError` instead of a raw one.
2. The login action catches it and returns "the page is still loading, try
   again" rather than a 500.
3. The code step's submit waits for hydration, with a `<noscript>` note saying
   plainly that finishing a sign-in needs JavaScript — because a login *is* a
   cookie, and that one step genuinely cannot degrade.

Four tests cover it, including that no `Session` row is written when the cookie
cannot be set. Two of them fail against the old ordering.

### Verification

- `npm run verify` — **260 tests** (up from 233): 23 on the subscription
  lifecycle, 4 on the session cookie.
- **32 end-to-end checks** against live PostgreSQL, re-runnable: the launch gate,
  paid enrollment refused, a grant with no grantor refused in both the code and
  the database, the one-live-subscription index, benefits applying at checkout
  and stopping at their caps, an inactive plan granting nothing to an existing
  subscriber, the grant term expiring with `endedAt` set to the term end, the
  paid path going PAST_DUE then EXPIRED after grace, and cancellation freeing the
  slot.
- **A browser run** of the whole surface: sign-up closed with the reason,
  a comp granted from the CLI appearing on `/plus` with month-to-date lines,
  checkout showing *Libreng delivery −₱39* and *5% off −₱20* with the fee still
  at full value, cancel, and the plan pulled — profile hiding the row again.
- **The no-JavaScript path** checked separately: step one still works, step two
  says why it cannot.

## Phase 10 — Second vertical ⬜ Gated on demand

Which of MART, PARCEL, PABILI or RIDE goes second should come from the
coming-soon tiles, not from a hunch. Instrument taps on dimmed tiles first;
that is the measurement those records exist for.

Activating one is:

1. Implement its `details` shape in `ORDER_DETAILS_SPECS` (the placeholder is
   already written down).
2. Review its lifecycle in `ORDER_LIFECYCLES` (already drafted).
3. Build its ordering flow.
4. Approve fleet partners for it via per-service verification.
5. Set `isActive: true` and populate `availableCityIds`.

Steps 1 and 3 are the real work. The home screen, order history, search, help,
credits, subscription benefits, dispatch and support need **no changes** — that
is the return on this phase's design, and the thing to protect in review.

## Phase 11 — Notifications ✅

Taken ahead of Phase 10 on purpose: a second vertical is gated on demand data
nobody has yet, while the biggest hole in the working product was that **a store
or a partner who closed the tab learned nothing.** Every screen polled while it
was open, and that was all.

### What landed

- **An outbox.** `Notification` (one event, one recipient, both forms of the copy
  rendered and stored) and `NotificationDelivery` (one attempt per channel, with
  its own status, attempts and error).
- **`src/lib/notifications/`** — `policy.ts` (urgency, channel defaults, quiet
  hours, retries), `order-events.ts` (the per-status map), `templates.ts`,
  `enqueue.ts`, `channels.ts`, `deliver.ts`, `inbox.ts`.
- **Two channels**: the in-app inbox, and SMS through the sender the login flow
  already uses. Push is a third adapter behind the same interface.
- **`/notifications`** — one inbox for one account across all three apps, with an
  unread badge in the customer, merchant and fleet headers, and a row on the
  profile.
- **A delivery pass in the cron**, last in the run so everything that run
  enqueued goes out in it.
- **Four SQL guards**: a SENT row must say when, a FAILED row must say why,
  attempts never go negative, and the inbox can never be a preference row.

### Restraint was the hard part

SMS costs money per message, so the policy is as much about what we do *not*
send. `urgency` exists for exactly this: SMS defaults **on** for OPERATIONAL and
**off** for INFORMATIONAL. Four kinds text by default — a new order, a dispatch
offer, a rider outside the door, and a cancellation. The customer's other five
progress messages are inbox-only, which the browser run shows: six rows in the
inbox, one marked *na-text*.

Quiet hours (22:00–06:00 Manila) **defer** an informational text to 06:00 rather
than dropping it, and operational ones ignore them — a store that finds out at
6am about an order placed at 1am has already lost it.

### The constraint that shaped the code

Enqueueing happens inside the transaction that caused it, so an order that moved
and a message saying so either both happen or neither does. That means a failed
insert would abort the caller's transaction at the database level, and catching
it in TypeScript would not put it back. So the insert uses `skipDuplicates`
(`ON CONFLICT DO NOTHING`) on the dedupe key instead of catching a unique
violation — a duplicate is the ordinary case and must never cost a delivered
order. A test asserts the file handles no `P2002`.

### Verification

- `npm run verify` — **287 tests** (up from 260): 27 on the notification policy,
  the status map, the templates and the transaction-safety rule.
- **30 end-to-end checks** against live PostgreSQL, re-runnable: both store
  members notified and neither the customer nor a repeat transition writing a
  second row, an informational kind getting the inbox only, the delivery pass
  being idempotent, an opted-out channel recorded as SKIPPED while a colleague
  still gets the text, a 2am informational text deferred to 6am while its inbox
  copy is immediate, and all four SQL guards refusing a dishonest row.
- **A browser run** of the whole loop: a customer places an order, the cron texts
  both store members, the store sees a badge it did not ask for, opening the
  notification marks it read and lands on the queue, a partner is texted
  *"New TARA job — ₱89.00, 60s to answer"*, and the customer
  ends with six inbox rows of which exactly one was texted.
- **One copy bug the real send caught**: `"Deliveryapp— ₱89.00"` (the product
  still had that name then), a missing space
  from a joined string. Now a test that fails against it.

---

## Interface language: English ✅

The original brief asked for Filipino-market group names and gave examples —
*Kainan*, *Tindahan*, *Padala*, *Pabili*, *Sakay*. The product later decided the
interface should be English, so every user-facing string was translated:

| Was | Now |
| --- | --- |
| Kainan | Food |
| Tindahan | Mart |
| Padala | Parcel |
| Pabili | Errands |
| Sakay | Rides |

Group headings became *Food & grocery*, *Send & buy*, *Rides*, *Pay*.

**What stayed Filipino, on purpose:** dish names (*Sinigang na Baboy*, *Isaw ng
Manok*), store names (*Aling Nena Carinderia*), and place names. A carinderia
sells sinigang, not pork sour soup — translating those would make the catalogue
read like a machine wrote it. Menu *categories* were translated, because those
are app furniture.

**The change was cheap in exactly the way the architecture predicted.** Service
names are five `displayName` rows in the seed and group labels are one config
file, so a vertical's name is data — the tiles, search placeholder, order
history, notification copy and benefit labels all followed from the same rows.
Everything else was screen copy: about 400 strings across 56 files, plus the
notification templates, the OTP message and the seeded FAQ.

Two things worth noting from doing it:

- **Nothing in the domain layer changed.** No service key, status enum, lifecycle
  map or database column moved. The only tests that needed editing were the ones
  asserting display text — five assertions.
- **A bulk find-and-replace was the wrong tool** and was reverted: short words
  are substrings of longer ones, so *Bago* inside *Bagong order* produced
  "Newng order". The second attempt matched whole phrases only.

`<html lang>` is now `en-PH`.

---

## Name: TARA ✅

The product is called **TARA**. *Tara* is the invitation everybody already uses
— *let's go* — which is the whole app in one word, and it survives being read in
English.

What moved:

- **Display copy** — the login wordmark, page title, the plan (*TARA Plus*), the
  origin label *Given by TARA*, and every SMS: *"123456 is your TARA code"*,
  *"New TARA order"*, *"New TARA job"*.
- **Identifiers** — the session cookie is `tara_session`, the cart's local
  storage key is `tara.cart.v1`, the package is `tara`, and `.env.example`
  points at a `tara` database.
- **Docs** — README, architecture and this file.

Two consequences worth stating rather than discovering:

- **Renaming the session cookie signs everybody out.** There are no real users,
  so it costs nothing now; doing it after launch would need the old name read as
  a fallback for a release or two.
- **Renaming the cart key drops carts in progress**, for the same reason and with
  the same fix if it ever matters.

The `Service` display names are untouched by this: they are rows, and the app
name is not one of them.

---

---

## Known gaps

- **No push.** The inbox and SMS reach people; a free channel that reaches a
  closed tab does not exist yet. It is one adapter behind
  `NotificationChannelAdapter` — a subscription table, VAPID keys, the same
  `deliver()` — and it should be the next thing built, because every SMS it
  replaces is money.
- **Notification latency is the cron interval.** Nothing on a request path waits
  for a gateway, which is right, but it means a store hears about an order up to
  one cron tick late.
- **Dispatch has no worker.** Offers are created by cron, so how fast a partner
  sees a job depends on how often it runs.
- **No admin console.** Fleet approval, plan activation and subscription grants
  are CLI scripts; store membership is seeded or edited by hand.
- **No subscription payment rail.** A tier exists and can be granted, but not
  sold. See Phase 9.
- **No live location on the tracking screen.** The customer sees statuses, not a
  moving pin, even though partner positions are stored.
- **No ratings.** `ratingAvg` and `ratingCount` are read by dispatch ranking but
  nothing writes them.
- **Store membership is seeded, not managed.** There is no UI to invite staff or
  change a role — `StoreMember` rows are written by the seed or by hand.
- **The Semaphore SMS adapter is unverified against the live API.** Written from
  its documented request shape and exercised only against a stub; this codebase
  has no gateway account. Now that notifications ride on it too, one real send
  proves out both the login codes and the whole outbox.
- **No account recovery.** Losing the phone number means losing the account —
  there is no email fallback and no support-assisted transfer.
- **No CAPTCHA.** The three throttles are the only abuse defence on code
  requests, which is thin if someone brings many source addresses.
- **No realtime.** Tracking polls every 15 seconds; there is no push.
- **Menu categories sort alphabetically**, so "Add-ons" leads the menu ahead of
  "Rice meals". Needs a sort field on the category, or categories as rows.
- **Icons are emoji.** `serviceGlyph()` is a lookup, so swapping in a real icon
  set touches one map.
- **Item options are modelled but not offered.** `FoodItemSnapshot.options`
  carries priced add-ons and placement stores them; no UI collects them yet.
- **Surge is a column, not a calculation.** `Order.surgeCentavos` exists and
  pricing passes it through; nothing sets it.
- **ETA is an estimate from a straight line.** `estimateEta()` uses prep time
  plus haversine distance at a fixed average speed, not routing.
- **`prisma/sql` guards need `psql`** on the deploy host, and must be applied
  after every `migrate deploy` (`npm run db:setup` does both).
