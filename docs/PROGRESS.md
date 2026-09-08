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
| 12 | SMS verified at the wire; web push; the admin console | ✅ Built, one gap |
| 13 | Account recovery: a verified email, or support, with a credits freeze | ✅ Done |
| 14 | Demo data made harmless; the coming-soon tiles say something back | ✅ Done |
| 15 | The storefront made public — the front door opens | ✅ Done |
| 16 | A CAPTCHA on the login screen | ✅ Done |
| 17 | Error monitoring | ✅ Done |
| 18 | Backups, and the drill that proves them | ✅ Done |
| 19 | The Dockerfile, compose and CI | ✅ Built, never run |
| 20 | Support that reaches a person: threads, a public channel, a queue, an alert | ✅ Done |
| 21 | Store staff: invite by number, a first owner from the console, an owner who cannot vanish | ✅ Done |
| 22 | A map for the shop's pin, and three other ways to set it | ✅ Done |
| 23 | Address search on that map, through the server | ✅ Done |
| 24 | Ratings: written at last, derived, and private | ✅ Done |
| 25 | A ratings digest for the shop and the rider | ✅ Done |

Between phases 11 and 12: the interface was translated to English, the product
was named TARA, and the typeface and brand blue were set from the brand artwork.

The one gap in phase 12 is not code. Neither external channel has been proved
against its real provider, because the development environment's network policy
blocks every SMS gateway and every push service. See **Known gaps**.

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

## Typography and the brand blue ✅

The app had no webfont at all — it rendered in whatever the browser defaults to,
which on Android is Roboto and on iOS is San Francisco. The brand artwork uses a
geometric grotesque with a single-storey `a`, so:

- **Outfit**, weights 300–800, loaded through `next/font` and set as Tailwind's
  `sans` stack. Served from our own origin: no third-party request on first
  paint and no swap-in shift. Every existing `font-semibold` and `font-bold`
  kept working, because the change is the family and not the weights.
- **Display tracking** is applied once, to `h1`/`h2`/`h3` in `globals.css`,
  scaling with the heading — a wide geometric face looks loose at default
  spacing and the effect is worst on the biggest text.
- **The brand blue is `#077aff`**, sampled from the artwork, and the ramp was
  rebuilt around it.
- **A `Wordmark` component**, lowercase as the artwork draws it, with the
  tracking and weight in one place rather than re-typed per screen.

One accessibility decision worth recording: **white on `#077aff` is 4.0:1**,
which passes AA for large text and misses it for body. So the brand blue is
`brand-500` and used for the wordmark and large type, while buttons and small
white-on-blue labels use `brand-700` (`#0a56c4`). A brand colour is not worth an
unreadable label.

The artwork's own face looks like Gilroy or Sofia Pro — both commercial. Outfit
is the nearest thing that can be self-hosted without a licence; swapping in the
real file later is one line in `tailwind.config.ts`.

---

---

## Known gaps

- **Notification latency is the cron interval.** Nothing on a request path waits
  for a gateway, which is right, but it means a store hears about an order up to
  one cron tick late.
- **Dispatch has no worker.** Offers are created by cron, so how fast a partner
  sees a job depends on how often it runs.
- **The console does not cover everything the CLI does.** `/admin` handles
  services, people, stores, the fleet, support, credits, delivery health and
  the audit log. Plan activation (`npm run plan:activate`) and subscription
  grants (`npm run plan:comp`) are still CLI scripts. Fleet approval moved to
  the console in Phase 28; the script is kept for a deployment where nobody has
  console access yet.
- **Address search has never run against the real Nominatim.** The adapter is
  verified against a stub over a real socket — the exact query parameters, the
  User-Agent, the rate limit, every failure shape — and the environment has no
  route to `nominatim.openstreetmap.org`. What is unverified is their side:
  whether the results for a Philippine barangay are any good in practice.
- **A store's own details cannot be edited after it is created.** The console
  can create one and set whether customers see it; the shop can set its prep
  time, open/closed and — since Phase 27 — its whole menu. Changing a name, an
  address or which services a shop is for still needs a database edit. Rare
  enough to have been left, common enough to be worth naming.
- **No subscription payment rail.** A tier exists and can be granted, but not
  sold. See Phase 9.
- **No live location on the tracking screen.** The customer sees statuses, not a
  moving pin, even though partner positions are stored.
- **A rating cannot be left on a delivery that failed.** Deliberate — see
  Phase 24 — but it means the strongest opinions in the system never reach the
  average. What those customers get instead is an automatic refund and a
  support thread, which is the right answer and not the same answer.
- **A ratings digest waits up to an hour, by design.** Batching is what stops
  a busy shop getting thirty notifications, but it does mean a single rating on
  a quiet day is not immediate. Nobody is waiting on it.
- **Support has no public contact channel until somebody sets one.**
  `SUPPORT_PHONE`, `SUPPORT_EMAIL` and `SUPPORT_FACEBOOK` are all optional and
  nothing is invented, because a number nobody answers is worse than no number.
  Until one is set, somebody who cannot sign in has no way to reach anybody —
  `/admin/health` and `/admin/support` say so in red. It is the only gap here
  that costs somebody their account rather than a feature.
- **The support forms need JavaScript.** Not a preference: a pre-hydration form
  post runs with no request scope in Next 15.1, so `cookies()` throws and there
  is no way to know whose ticket it is. Verified in a browser with JavaScript
  off. The submit waits for hydration, a `<noscript>` note says why, and the
  phone number on the same screen is the path that works either way.
- **Nobody is assigned tickets automatically.** Whoever replies first owns it,
  and anyone can hand one back. With one or two people answering that is
  correct; with a rota it is not.
- **A store invitation reaches nobody by itself.** Nothing is texted to the
  invited number, on purpose — an invite form that could message any number
  would be a way to spend SMS credit on strangers, from our sender name. So
  whoever is hiring has to tell the person to install the app and sign in. Once
  they have an account the notification is automatic.
- **No real SMS has ever been sent.** The adapter is now verified at the wire —
  `sms-wire.test.ts` asserts the exact bytes a gateway receives over a real
  socket, and `npm run sms:send-one` sends one real message and prints the full
  result. What remains unverified is Semaphore's own side: whether a key is
  live, whether the sender name is registered, what a message costs, whether a
  handset rings. It could not be answered from the development environment,
  whose network policy answers 403 to CONNECT for every SMS gateway. It needs a
  machine with egress and an account.
- **No push subscription from a real push service.** The crypto is pinned
  byte-for-byte against the reference implementation and the whole server path
  is verified against a stand-in service over real TLS, but Chrome refuses the
  Push API in the incognito profile Playwright uses and the environment blocks
  the push services outright, so no endpoint could be obtained. The error path
  a person would see is verified; the happy path with a real endpoint is not.
- **Recovery depends on foresight, or on support.** Self-service recovery needs
  an email confirmed BEFORE the number was lost, and almost nobody will do that
  in advance. Everyone else goes through support, where the verification is
  whatever the administrator wrote in the reason field — which is auditable but
  not strong. Prompting for an address at the right moment (after a first
  successful order, not during signup) is the cheap improvement.
- **Recovery by email needs an email provider.** With `RESEND_API_KEY` unset the
  `/recover` route says so and only the support route works. The Resend adapter
  has never sent a real message, for the same reason the SMS one has not: the
  development environment blocks outbound mail providers too.
- **No CAPTCHA.** The three throttles are the only abuse defence on code
  requests, which is thin if someone brings many source addresses.
- **No realtime.** Tracking polls every 15 seconds. Push now reaches a closed
  tab, but the open tab still polls — a live pin would need a socket or SSE.
- **Icons are emoji.** `serviceGlyph()` is a lookup, so swapping in a real icon
  set touches one map.
- **A photograph is one size, and stored in the database.** 800px on the long
  edge, which is right for a phone and thin for a tablet or a future web
  storefront; and the bytes are in Postgres, so the backup grows with the
  menus. Both are deliberate (see Phase 29) and both are the first things to
  revisit if photos become the reason a page is slow or a dump is large. The
  seam is one route handler wide, so object storage is an adapter.
- **Surge is a column, not a calculation.** `Order.surgeCentavos` exists and
  pricing passes it through; nothing sets it.
- **ETA is an estimate from a straight line.** `estimateEta()` uses prep time
  plus haversine distance at a fixed average speed, not routing.
- **`prisma/sql` guards need `psql`** on the deploy host, and must be applied
  after every `migrate deploy` (`npm run db:setup` does both).

---

## Phase 12 — the second and third channels, and the console

**Real SMS: verified at the wire, unsent in fact.**
`src/tests/sms-wire.test.ts` runs the Semaphore adapter against a real HTTP
server on a loopback socket and asserts what a gateway actually receives: the
method, the content type, the four field names, and — the one that would be a
silent, billable bug — that the leading `+` of an E.164 number is
percent-encoded rather than sent raw, where a form decoder turns it into a
space. Plus every response path: the queued array, a bare object, a 200 with an
unreadable body, a 422 carrying its reason, a refused connection, and a gateway
that accepts the socket and then never answers.

`npm run sms:send-one` is the part testing cannot do. One recipient per
invocation; it refuses a second positional argument, because a script that can
send to a list is a script that can empty a prepaid balance by accident.
`SEMAPHORE_ENDPOINT` redirects sends so development can aim at a stub, and is
ignored when `NODE_ENV=production` — a variable that can point message delivery
somewhere else is a way to capture login codes. There is a test for the
*ignoring*, not just the honouring.

The send itself did not happen: the environment's network policy answers 403 to
CONNECT for api.semaphore.co, api.twilio.com, rest.nexmo.com and api.movider.co.

**Web push, as the third channel.** `NotificationChannelAdapter` claimed a new
channel would be a file rather than a refactor, and this was the test. It was.
RFC 8291 encryption and RFC 8292 tokens are written out rather than pulled in,
because a payload encrypted wrongly is *accepted* by the push service and
silently discarded by the browser with nothing raising anywhere — and the output
is pinned byte-for-byte against `http_ece` (the RFC author's own
implementation) across a fixed vector, a decrypt round-trip, and 200 randomised
rounds. Push carries every kind because it is free; SMS keeps its restraint;
quiet hours still apply to informational push.

Verified end to end against a stand-in push service over real TLS that decrypts
what it receives, and in a real browser via the Chrome DevTools Protocol: the
worker registers, renders the right title/body/tag/href, replaces a same-tag
notification, and falls back to something on an unparseable payload.

**The admin console.** Six screens at `/admin`. Every server action calls
`requireAdmin()` itself — a server action is its own entry point and a layout
check does not cover it — and a grep test enforces that, along with a required
reason and an audit row, on every exported action. `AdminAuditEvent` is
append-only by trigger and its `reason` is at least eight non-blank characters by
CHECK, both verified against a live database. Credits go through
`recordAdjustment` and are capped at ₱500. The console deliberately cannot force
an order's status, edit roles or phone numbers, or list every account.

**A bug the launch switch exposed.** `getServicesByIntentGroup()` hid a service
that was live in another city — so a vertical launched in Cebu vanished from
Manila entirely, neither usable nor coming. Unreachable until the console could
put a service into that state, and the outcome of the first real launch if it
had shipped. `isOrderableIn(service, cityId)` now separates "live" from "live
where you are", and the tile reads `orderableHere`.

---

## Phase 13 — account recovery

**The problem.** The phone number is the identity, so losing it meant losing
the account: the order history, the saved addresses and the credits balance,
with no route back. It was the top blocking gap for a real launch, and the one
certain to happen in the first week.

**Why it is dangerous to fix.** Whoever holds an account's number holds all of
that, so recovery is an account-takeover surface. The design is arranged around
making a successful takeover *worthless* rather than merely difficult, because
"difficult" is a bet against an attacker's patience.

**Four controls, and no route can skip one.** Both the self-service and the
support-assisted path go through `movePhoneNumber()`, inside one transaction:

1. **Two channels.** A code to an address verified before the loss, then a code
   to the new number. Email alone never grants a session and never moves
   anything — `recovery.ts` contains no `createSession`, and a grep test keeps
   it that way.
2. **Credits frozen for three days.** The control that removes the prize. The
   ledger computes it from `frozenUntil` on every spend rather than reading
   `isFrozen`, so the hold lifts the instant it expires instead of at the next
   cron tick. Refunds INTO a frozen balance still land — only spending is
   blocked, or a cancellation during the hold would lose somebody's money.
3. **The old number is told.** From `AccountRecovery.previousPhone`, the only
   place it survives the change. Deliberately not through the notification
   outbox, which resolves recipients from the user row — that would send the
   "your account was taken over" warning to whoever took it over. The
   maintenance sweep sends it instead.
4. **Every session revoked.**

Plus an append-only `AccountRecovery` row whose UPDATE trigger permits only the
two alert columns.

**A design problem the guards surfaced.** An append-only table makes the rows
referencing it undeletable: `onDelete: Cascade` from `User` runs as a DELETE and
hits the trigger, so no account could ever be removed — and the credits ledger
already had this property, unnoticed. Nearly right, since financial and identity
records are retained on purpose, but "nearly" is what gets a trigger dropped and
never recreated the first time somebody has a lawful erasure request. All three
append-only triggers now honour `SET LOCAL tara.allow_purge`, which cannot
outlive its transaction, and `npm run db:purge-user` is the one tool that uses
it.

**A mistake that cost two debugging rounds.** A `'use server'` module may export
only async functions. Both `tsc` and ESLint pass a file that breaks it; the
first sign is a 500 in the browser. It happened twice — a constant, then an enum
re-export — so `no-service-branches.test.ts` now asserts it, and the assertion
was checked against both real mistakes before being committed.

**Verified**: 24 checks against a live database (the move, the freeze refusing a
spend, the balance surviving, the alert sending once and not twice, all six
guards rejecting raw writes, the freeze expiring before any sweep, purpose-scoped
email codes, and the purge hatch closing again afterwards); and the whole flow in
a real browser — add an address, confirm it, recover onto a new number from a
clean browser, and sign in with it.

## Phase 13 — the demo data stops being a liability

The pre-launch review put "delete every demo account" first, ahead of the
database and the SMS gateway, and that ordering was right but the remedy was
wrong: the fix for a dangerous default is not a step in a document somebody has
to remember.

`User.isDemo` and `Store.isDemo` are written by the seed and read by
`src/lib/demo/policy.ts`. A demo account cannot hold a session in production —
checked both at login and every time a session is read back, so a cookie that
predates the deploy stops working as well. The refusal is word-for-word the one
a blocked account gets, so a stranger who happens to own `0917 000 9999` learns
nothing from the screen.

The seed itself now refuses two targets: `NODE_ENV=production`, and a
`DATABASE_URL` whose host is not local. The second is the one that matters —
the realistic mistake is not carelessness, it is `npm run db:seed` in a terminal
with a production connection string exported. `--force` gets past both, on the
grounds that a check with no way past it gets deleted rather than respected.

Two new commands close the loop the checklist opened:

- `npm run db:purge-demo` — prints the six accounts and three stores and stops;
  `--confirm` removes them. It deletes only the ids it printed. Audit entries
  written *by* a demo administrator need `--and-audit` too, because an audit row
  is the record of what was done to somebody else and is not the actor's to
  erase.
- `npm run admin:grant -- 09171234567 --reason "…"` — because purging removes
  the only administrator a fresh database has, and there is no screen for
  granting console access on purpose. It will not create the account: the
  person signs in once with their own number first, which is the only available
  proof that they hold it. The audit row names the account that gained the role,
  since a shell has no identity of its own — hence the mandatory reason.

**Verified in a production runtime, not just in unit tests.** Built, started
with `NODE_ENV=production`, and two sessions minted directly in the database:
the demo ops admin (ADMIN, `isDemo`) gets 404 on `/admin` and a redirect to
`/login` from `/profile`, while a real ADMIN on the same server gets 200 on
both. Plus 39 checks on the policy itself, including three source-level guards
verified against the real mistakes they prevent: an unmarked demo account added
to the seed, the target check moved out of first position, and the purge
switched from deleting listed ids to deleting by predicate.

489 tests pass; `npm run build` and `npm run lint` are clean.

## Phase 14 — the coming-soon tiles say something back

Four of the five tiles are dimmed and the question of which vertical to build
next was a guess. It is now a table.

A tap on a coming-soon tile records `ServiceInterest`: the service, the city,
and the person if there is one. The tile answers with the number of people who
have asked — "Noted — you and 33 others" — which is the only reward on offer
and, more usefully, an honest one. The console shows the same numbers beside
each launch switch, and beside each city in the "launch in another city" list,
which is where the decision is actually taken.

**The design decision worth naming.** An account that asked and a tap from
somebody not signed in are counted separately and never added together. An
account needed a code sent to a real phone; an anonymous tap is available to
anybody who can post a form. Summing them would put a number in front of a
launch decision that one person with a loop can move. So the fold is pure and
tested at every shape, the tile only ever shows accounts, and the console
labels the other tally as what it is. Anonymous taps share one counter row per
service and city, so a script costs storage nothing.

**And the tap is kept.** `announceLaunchedServices()` runs on the order cron
and tells everybody whose service has since gone live where they asked. It
queries current state rather than firing from the launch switch, so a launch
done any other way is still picked up and an administrator is not waiting on a
fan-out. Bounded per pass; deduped on the interest row, so switching a service
off and on again cannot tell somebody twice. Push and inbox only — the person
asked to be told, not to be texted at a peso a head.

**A finding.** Every route is behind the login wall, `/` included, so today
only signed-in people ever see a tile at all. The anonymous path is built and
tested but unreachable; `loadHomeData` already accepts a null user, so it needs
one line in the middleware's public prefixes to start measuring the population
that matters most before launch — strangers.

**Verified**: 30 checks against a live database (a repeat not becoming a second
person, five anonymous taps making one row, a live service refused and the same
service accepted in a city it has not reached, the console's per-city
breakdown, two people told exactly once at launch, no SMS queued, and a
withdraw-and-relaunch telling nobody again); 23 unit checks on the fold, the
copy and the policy; and the tile driven in a real browser — tapped, marked
ASKED, the count returned, and still marked after a reload with localStorage
cleared, because that state came from the database.

513 tests pass; `npm run build` and `npm run lint` are clean.

## Phase 15 — the front door opens

The home screen is public, and so is the rest of the storefront: `/`,
`/services/…`, `/stores/…`, `/search` and `/help`. A stranger can browse the
tiles, a service's stores and a store's menu, tap a coming-soon tile, and fill
a cart. Signing in is asked for where it is actually needed — `/checkout`, and
anything about a person rather than a product. Sixteen private paths still
bounce, carrying `?next=` so a deep link survives the detour, and the cart
lives in the browser so it survives it too.

**The subtle part was the matching, not the list.** `/` cannot be a prefix:
`'/admin'.startsWith('/')` is true, so one entry in the wrong list serves the
console to the internet with no error and nothing to notice. Prefixes now match
on a path boundary as well, which closes the other half of the same trap — a
future `/helpdesk` would otherwise be public on the strength of `/help` being
in a list. Both are asserted, and the assertions were checked against the real
mistake.

**Opening the door made two bits of tile copy false**, which is the part worth
recording. "You and 33 others" counted a stranger among 33 accounts they are
not one of, and "we will tell you" promised a message to somebody the product
cannot reach. The action now returns `canBeTold` and an anonymous visitor is
told "Noted — sign in to be told" — true, and the one thing that would let us
keep the promise. The tap is still counted.

**Verified as an actual stranger**, with no cookie in the jar: the five public
routes return 200 and the ten private ones 307 to `/login` with the
destination attached; the home screen renders with a Sign in button where the
notification bell would be; a coming-soon tap returns the honest line and holds
it across a reload; and tile → service → store → menu → add to cart → cart bar
→ `/checkout` → `/login?next=%2Fcheckout` works end to end with the cart
intact afterwards. 528 tests pass; build and lint clean.

## Phase 16 — a CAPTCHA on the login screen

The last unbuilt item on the pre-launch list that was about money rather than
paperwork. Three rate limits guarded the code request and held against a
careless script; they did not hold against somebody with a list of numbers and
a few hundred addresses, and every request through costs a peso.

Cloudflare Turnstile now sits in front of `sendLoginCode()`, behind the same
kind of interface the SMS gateway has. Free at any volume, silent for a normal
browser, and no advertising profile of the person signing in.

**Checked before anything is spent** — before the number is examined further,
before a row is written, before the gateway is called. That ordering is the
only one where a refusal costs nothing, and the only one that keeps the
no-enumeration property: a bot that fails the check learns nothing about the
number it tried.

**The design decision worth arguing about** is that this fails OPEN when
Cloudflare cannot be reached, against the instinct everywhere else in this
codebase. A missing or rejected token is refused — that is evidence. An
unreachable verifier is evidence of nothing but somebody else's outage, and
failing closed on it would stop every customer in the country ordering dinner
to prevent an attacker spending SMS credit that three independent limits still
cap. The CAPTCHA is a cost control; the security boundary is the code sent to a
phone somebody holds. There is a test asserting the asymmetry so that tidying
it into consistency is a failing build.

Half a key pair reads as "off", not as a lockout, and the console says so in
red — a secret with no site key renders no widget, so nobody could produce a
token and nobody could sign in.

**The honest price**: the first login step was built to work before the page
hydrated, and a CAPTCHA cannot be. With a pair configured, signing in needs
JavaScript, and the screen says so instead of showing a button that will be
refused.

**Verified**: 24 checks including wire-level assertions of the exact bytes
Cloudflare would receive (method, content type, secret, token, `remoteip`, and
the percent-encoding of a token containing `+` and `/`) and every response
shape siteverify can give. Then the whole path through the real login form
against a local stand-in — no token, a forged token and an expired token all
refused **with no code row written and no SMS attempted**, a good token
reaching the code step, our own bad secret letting the person through — and the
half-a-pair case confirmed not to lock anybody out. No real token has been
checked against Cloudflare: this environment has no route to it.

552 tests pass; build and lint clean.

## Phase 17 — error monitoring

The last code item on the "before customers" list. Before this, a page that
started failing was discovered when a customer said so, and most customers do
not say so — they leave.

**Not Sentry**, and the reasoning is worth recording. Sentry is a good product;
it is also a US processor receiving Philippine phone numbers, home addresses
and order contents inside error payloads, before this business has a privacy
policy or a named data protection officer. And it would do nothing at all until
somebody sets a DSN — the same "configured later, unprotected today" shape as
the SMS gateway. So the record lives in the same database as everything else,
needs no configuration, and works on the first deploy, behind a seam narrow
enough (`reportError(error, context)`) that forwarding to Sentry later is
another file. What is given up is source-mapped client stacks, which is a real
loss and the right trade at this stage.

`ErrorReport` is grouped by fingerprint — kind, redacted message, first frame
of our own code — with an occurrence counter. Four hundred failures in an hour
is one row saying "four hundred times, still happening", and a loop cannot fill
the disk.

**Redaction is the part that matters.** Every message is cleaned before it is
written: login codes, phone numbers, email addresses, API keys, session tokens,
JWTs and connection strings. All of those are strings this codebase can really
produce — a gateway rejection quotes the request body, which contains the login
code. An error log that captured the code it failed to send would be the
softest target in the database. It also makes grouping work, since two failures
differing only by a phone number only become one fault after both become
`[phone]`.

Caught in five places: `onRequestError` for page renders, route handlers and
server actions; a client boundary for components that throw in the browser; a
root boundary for the layout itself; and the maintenance sweep. Next's `digest`
is stored and shown at the bottom of the error screen, so "it says 986393595"
starts a support conversation instead of a guess.

**A bug worth writing down.** The first version hashed the fingerprint with
`node:crypto`. `instrumentation.ts` is compiled for the edge runtime as well as
for Node, so that failed the production build — and failed *silently* in
development: the instrumentation module never compiled, the hook was never
registered, and errors vanished with no sign that monitoring was off. That is
the worst possible failure for this feature and it cost an hour of digging
through Next's internals. The fingerprint is now four seeded FNV-1a lanes
written out in the file, which is also the right tool: a grouping key is not a
security primitive, and a collision merges two rare faults into one row.

Administrators are told once per fault, on the cron, at most five faults per
pass. Push and inbox, never SMS — a monitoring system that can run up a bill
during an error loop is one somebody switches off.

**Verified** against a production build by making a server component, a route
handler, a server action and a client component each throw: all four landed
with the right source, secrets redacted, three hits of one page grouped as
`occurrences = 3`, and the client row carrying the same digest as the server
row. The cron alerted once per fault and a second pass alerted nobody again.

594 tests pass; build and lint clean.

## Phase 18 — backups, and the drill that proves them

The honest part first: the real backup is the database host's point-in-time
recovery, and nothing in this repository replaces it. What was missing is
everything around it.

`npm run db:backup` takes a portable `pg_dump` — the answer to "the provider
suspended our account" and "we are moving hosts" — with the connection details
in the child's environment rather than argv, because a password on a command
line is visible in `ps` to every process on the machine. It reads the archive
back with `pg_restore --list` rather than trusting an exit code, records the
attempt in `BackupRun` before it starts so failures leave a trace, prunes old
dumps but only files matching its own naming pattern, and encrypts with
AES-256-GCM when `BACKUP_ENCRYPTION_KEY` is set — warning loudly when it is
not, because a dump is every customer's phone number and home address in one
file designed to be copied elsewhere.

`npm run db:restore-check` is the part that makes the rest worth having. It
restores into a brand-new scratch database, never over the live one, and checks
that the tables are there, that no table came back empty, that **the credits
ledger still adds up to the wallet balances in the restored copy** — which
catches a dump that lost transactions while keeping a plausible row count — and
that the append-only triggers survived. A count that merely *changed* is
reported without alarm, since the dump is a snapshot and the business keeps
taking orders.

The console now states a posture rather than a number: unset is red, `host` is
calm and says explicitly that this application cannot see whether the provider
is really doing it, and `script` reports the age and whether anything has ever
been restored. A green tick this code cannot justify is worse than no tick.

**Two bugs worth recording.** The first version attached the child process's
`close` listener after reading its stdout, so for a small database the event
had already fired and the promise never settled: the script hung and exited
silently with status 0, leaving a "not ok" row with no error next to a perfectly
good dump. It failed only on the encrypted path, purely by losing the race
faster. The second: the restore check read row counts from
`pg_stat_user_tables.n_live_tup`, an estimate that reads zero on a freshly
restored database — so it cheerfully reported that a table with nine rows had
two. A verification tool that prints nonsense is how people learn to ignore it.
Both are now asserted in tests.

**Verified** for real against Postgres 16: plaintext and encrypted dumps taken
and read back, both restored into a scratch database with the ledger checked
and the triggers found, retention pruning five of seven, and three failure
modes confirmed to fail — wrong key, no key, and one byte flipped in the middle
of an encrypted dump.

646 tests pass; build and lint clean.

## Phase 19 — the Dockerfile, compose and CI

Blocker 10 on the pre-launch list was "no Dockerfile, no CI, no deploy
configuration". There are now all three.

**Two images from one Dockerfile.** `web` serves requests and carries only the
standalone bundle — 86 MB of traced runtime files rather than 737 MB of
node_modules. `ops` runs the things that are not requests: migrations, the SQL
guards, the order sweep, backups, the restore drill. Splitting them keeps
`pg_dump` and `psql` off the machine that answers customer requests, where they
are attack surface for no benefit, while giving the jobs that genuinely need
Postgres 16 client tools a place to run. Sixteen specifically, from PGDG: 15
cannot dump a 16 server, and `psql` is what applies the ledger's append-only
triggers.

The standalone layout was verified by running it rather than by trusting the
docs — the exact three paths the Dockerfile copies, assembled in a temporary
directory, booted in 67 ms and rendered `/admin/health` with live queries.
`/api/health` was added for the container healthcheck and returns 503 when the
database is unreachable, so a rolling deploy does not send traffic to an
instance that cannot answer.

**CI has four jobs**, and each exists for a failure this project has actually
had: a production build (the only thing that catches a `'use server'` export or
an edge-runtime import), migrations plus the SQL guards against a real Postgres
(the only thing that catches a broken trigger), a backup-and-restore drill
including a deliberately corrupted dump, and a container build — CI is the
first place the images are built at all, since this development environment has
no Docker daemon.

**Simulating CI locally caught three bugs that would each have failed the first
push.** The Prisma CLI's `.env` overrides the shell, so every local "it works"
was meaningless until the file was moved aside. `DIRECT_URL` turns out to be
mandatory — the schema references it, and the CLI refuses to load a schema with
a missing variable before it touches a database, which a developer never sees
and a runner always would. And `docker compose run --rm ops …` named a service
the compose file never defined.

**And putting the demo purge in CI found two real bugs in it.** `Order.customerId`
is RESTRICT — correct for production, since nobody should erase the order
history a store and a rider were part of by deleting a customer — which meant
`db:purge-demo` and `db:purge-user` threw a foreign-key error for anybody who
had ever ordered, i.e. every real customer. Both now delete orders explicitly,
in the one place whose purpose is to override that intent. Then the ledger
refused too: a demo administrator who has corrected somebody's credits is named
on that ADJUSTMENT row and `wallet_transaction_adjustment_needs_admin` requires
them to stay named. Deleting the row instead would change what a real customer
is owed to tidy up a demo account, so the purge now keeps those accounts, names
them, and says blocking is the right ending — which is safe, because in
production they cannot hold a session at all.

677 tests pass; build and lint clean.

---

## Phase 20 — support that reaches a person ✅

The `SupportTicket` and `SupportTicketMessage` tables had existed since the
initial migration and **nothing read or wrote them**. `createSupportTicket` and
`listUserTickets` were dead code, the Help screen was FAQ articles with a
docstring describing a "Contact support" flow that did not exist, and the order
tracking screen linked to `/help?orderId=…` — a query parameter the help page
ignored. A customer with a problem had no way to tell anybody, and an operator
had nowhere to see one if they had.

**The gap that mattered more is the one a ticket system cannot close.** A
thread needs an account, and the person who most urgently needs support is the
one who cannot get into theirs: the SIM is gone, the code never arrives, the
number now belongs to somebody else. For them a form behind the login wall is a
locked door with a note on it. So this phase built two paths, not one:

- **Signed in** — `/help/contact` opens a thread, `/help/tickets` lists them,
  `/help/tickets/[id]` is the conversation. A reply notifies the customer.
- **Signed out** — a phone number, an email address or a Facebook page, from
  `SUPPORT_PHONE` / `SUPPORT_EMAIL` / `SUPPORT_FACEBOOK`, rendered on `/help`
  and `/recover`, both public. Nothing is invented and nothing is hardcoded;
  `/admin/health` reports `No public channel` in red until one is set.

On the operator side, `/admin/support` is the queue — worst first, priority
then length of silence — and `/admin/support/[id]` is the thread with the
customer, the related order and the controls. Every administrator is alerted
when a ticket is raised (in the same transaction as the ticket, so there is no
ordering where somebody asks for help and nobody is told), and again by
`chaseWaitingTickets()` in the order sweep once one has gone two hours with no
reply at all.

### What the work turned up

**The console's own invariant caught the new actions.** `admin-access.test.ts`
asserts that *every* exported action in `admin-actions.ts` calls
`requireAdmin()`, demands an eight-character reason, and writes an audit row.
Replying to a ticket does none of the last two, and it should not: the reply is
stored verbatim with its author and timestamp, which is more than an audit note
would say, and a mandatory reason would produce a column containing the word
"replied" eight hundred times. Rather than weaken the invariant with an
exemption list, the three support actions moved to their own module. The line
to hold is written down there: the moment one of them touches a balance, a role
or a phone number, it moves back and takes the reason with it.

**A claim about progressive enhancement turned out to be false, and testing it
is what showed that.** The forms were written on the assumption that
`useActionState` plus a server-side redirect would make them work with no
JavaScript. Driving them in a real browser with JavaScript disabled returned a
500: a pre-hydration form post runs with no request scope in Next 15.1, so
`cookies()` throws — and every action here needs the session cookie. The login
screen had already found this and says so for its code step. The claim, the
comments asserting it and the test asserting it were all wrong and were
replaced: the submit now waits for hydration, a `<noscript>` note explains, and
both point at the phone number, which is plain HTML and needs no session. The
fallback for "the bundle failed" is the same as the fallback for "I cannot sign
in".

**Three smaller things the drills found.** A customer's reply to a thread was
alerting administrators with the title "New support ticket", because all three
events share one notification kind — now told apart by `ticketEvent`, since an
administrator who learns the title is unreliable stops reading it. The queue was
being ordered by `orderBy: { priority: 'desc' }`, which works only because
Postgres sorts an enum by declaration order and would have silently reordered
the whole queue the day somebody tidied the enum. And the demo purge report
listed orders, sessions and store memberships but not the support threads it was
about to cascade away — a report that understates what it deletes.

Verified end to end in a real browser: a customer raises a ticket from `/help`,
it appears in the operator's queue, the operator replies, the state moves to
waiting on the customer, the customer sees the answer labelled as support and a
notice in their inbox. Then with JavaScript off: the submit is disabled, the
reason is on screen, and the phone number is reachable.

735 tests pass; build and lint clean.

---

## Phase 21 — store staff, and the store itself ✅

Phase 20's closing note said store staff still had to be added by hand. Looking
at it properly turned up something worse: **there was no way to create a store
at all** outside the seed. So onboarding a partner meant a person writing SQL
for the store row, its menu and its membership — and once you are in the
database writing a `Store`, adding its owner is one more INSERT, which is
exactly the workflow a staff screen was supposed to end. Building only the
invite screen would have left it unusable for the one case it was for: a new
partner.

Two screens, therefore, with a clear division:

- **`/merchant/<store>/staff`** — the shop's own. Add somebody by mobile
  number, change a role, remove them, withdraw an invitation nobody took up.
- **`/admin/stores`** — the console's. Create the shop, name its first owner,
  decide whether customers can see it. Nothing else: the menu, the prep time
  and the rest of the staff belong to the people who work there.

The hard part was never the form. It is that **the person a shop wants to add
has no account yet.** Fabricating one for an unverified number is what the
demo-data work exists to prevent, and telling the owner to come back later
means they never do. So access is offered to a phone number, held as a
`StoreInvite`, and redeemed on the first sign-in from that number — the moment
the OTP has proved who holds the SIM. Invitations expire after a fortnight,
because Philippine prepaid numbers get recycled and a forgotten invite to a
reassigned number would hand a stranger the order queue.

**Nothing is texted to the invited number**, and that is a decision. An invite
form that sent an SMS would let any shop owner message strangers at our
expense, from our sender name.

### The rules, and the one that is enforced twice

An owner may appoint anybody including another owner — ownership has to be
transferable by the person holding it, or a handover needs a support ticket and
people share the login instead. A manager may add staff and nothing more: only
an owner decides who else can change prices. Anybody may remove themselves.

And **a store always keeps at least one owner**, enforced in TypeScript for the
sentence and in `prisma/sql/store_members.sql` for the guarantee. That trigger
is `DEFERRABLE INITIALLY DEFERRED`, which is what makes a handover possible at
all: promoting the new owner and demoting the old one are two statements, and a
non-deferred check would reject whichever order they were written in.

### What the work turned up

**A hydration mismatch on two console pages, including one shipped in Phase
20.** `TableScroll` renders the `<table>` itself, and both new pages wrapped
another `<table>` inside it. Invalid nesting: the browser relocates the inner
table, React reports a mismatch, and the table quietly ignores the console's
own sizing. Nothing but a real browser found it — not tsc, not ESLint, not the
build, not any test. There is now a test that scans every console page for it.

**A refusal that named the wrong permission.** A manager trying to demote the
owner was told "only a manager or the owner can add staff" — true, and not the
problem, because the role they *requested* was staff. A misleading refusal
sends somebody to ask for the wrong permission, so the change-role check now
reports which half failed.

**A client component pulling `next/headers` into the browser bundle.**
`STORE_ROLE_LABELS` lived in `merchant/access.ts`, which reaches for the
session; the staff component imported one label and the production build
failed. The labels moved to the pure policy module, and a test now asserts that
module imports nothing server-only — the second time this class of bug has
appeared, after `describeAskCount` in Phase 14.

Verified end to end in a real browser: the console creates a shop and names an
owner who has no account; that number signs in with a real OTP read from the
development sender; the invitation becomes access; their inbox says so; they
open the shop, invite a staff member, promote them to manager; and the manager
is then given no control over the owner. Then directly against the database:
every escalation refused with an accurate sentence, and a legitimate handover
completed. The demo purge still runs clean against the new guard.

797 tests pass; build and lint clean.

---

## Phase 22 — the map picker ✅

Phase 21 left the store form asking for latitude and longitude as two numbers,
with a range check against the Philippines and a note that a map picker was
missing. It is the field on that form that matters most and looks least like
it: every delivery fee from a shop is measured from those two numbers, so a
transposed pair does not fail — it charges the wrong money forever, quietly.
And transcribing two eight-decimal numbers off a phone screen is exactly the
task people get wrong.

So `/admin/stores` now has a map, and **three ways in, all writing the same two
fields**: click or drag the pin; paste a Google Maps or Waze link; or type the
numbers. The number inputs are still the real form fields rather than a
read-out beside hidden ones — a map is not an accessible way to enter a
coordinate and must not be the only way, and that is also what keeps the form
correct when the map is broken.

The paste box exists because of how coordinates for a small shop are actually
obtained: somebody stands outside it, drops a pin on their phone and shares the
link. It handles a bare pair, `@lat,lng`, Google's `!3d!4d` place data,
`?q=`/`?ll=` from Google, Waze and Apple, and `geo:` from an Android share
sheet — and it prefers the **place** over the map centre, because a Google
place URL carries the pin twice and the two differ once somebody has panned. A
reversed pair is corrected rather than rejected, with the screen saying so;
that is only safe because Philippine latitude (4–21) and longitude (116–127) do
not overlap, so an invalid-as-given pair that is valid swapped can only be a
swap.

Tiles are OpenStreetMap by default, with `MAP_TILE_URL` for the day the volume
stops being light. It is read on the server and passed as a prop, not through a
`NEXT_PUBLIC_` variable that `docker build` would freeze.

### What the work turned up

**The map reported success with every tile failed, and only a browser found
it.** Leaflet's `load` event fires when the visible batch has *settled* —
loaded or errored, it does not distinguish — so `once('load') → ready` declared
a working map to an operator staring at a grey box. Latching on the first
`tileerror` would have been wrong the other way, since one missing tile over
the Sulu Sea is normal. Broken now means the batch settled and nothing loaded,
with a timeout for a tile server that accepts the connection and never answers.
Verified by pointing the app at a dead tile host: the panel explains itself and
names the two ways in that still work.

**The pin was about fifteen metres off, which is the whole accuracy budget.**
It started as a CSS teardrop — a rotated square with one square corner — and
the tip of a rotated square does not land where its bounding box says, so
`iconAnchor` was wrong. It is now an inline SVG with the tip at a known point.
(Leaflet's own default marker is not an option: its image comes from a relative
path no bundler resolves, which shows up as an invisible pin and no error.)

**The bounds were written out twice.** Phase 21 put the Philippine range check
inline in the server action; the picker needed the same numbers. They now live
in one module that both read, because a picker which lets somebody drop a pin
the server then rejects is worse than no picker.

**`npm install leaflet` pruned Playwright**, which was only ever an ambient
install in the development environment rather than a dependency. Reinstalled
with `--no-save`: there is no e2e suite for it to belong to yet, and a
devDependency nothing runs is dead weight. Leaflet itself is pinned exactly,
like every other dependency here — `npm ci` in the Dockerfile is the difference
between a reproducible image and one that picks up a new minor version at 3am.

Verified in a real browser against a local tile server, so the map genuinely
renders: choosing a city moves it, a click and a drag both fill the fields, a
pasted place link takes the place rather than the centre, a reversed pair is
corrected, a shortened link and a London coordinate are both refused with the
right sentence, Enter in the paste box does not submit the form, typing a
coordinate recentres the map — and a shop created through the whole form lands
in the database with the picked point. Then again with the tile host dead.

834 tests pass; build and lint clean. Leaflet is in its own chunk, so
`/admin/stores` first-load JS is unchanged apart from 2 kB of picker.

---

## Phase 23 — address search ✅

Phase 22 closed by naming address search as deliberately skipped: the city
centring and the paste box covered most of it, and a geocoder brings a usage
policy and a rate limit. Asked for, and worth having — somebody with a shop
name and a street should not have to pan across the archipelago to find it.

It goes to **Nominatim through the server**, and that is the decision the rest
follows from. Their policy asks for a `User-Agent` identifying the application,
which a browser cannot send, and caps requests at one a second, which is a
throttle worth having in one place rather than in every operator's tab. Doing
it server-side also keeps the third party at arm's length, exactly like the SMS
gateway, the push service and the CAPTCHA verifier — nothing here lets a
browser talk to somebody else's API directly. `requireAdmin()` on the action,
without which it would be an open geocoding proxy for anybody who found the
action id.

`countrycodes=ph` does most of the work on relevance, with a `viewbox` around
the city already chosen on the form and deliberately no `bounded=1`, so a shop
just over a city line is still findable. Candidates are checked against the
same Philippine bounds as everything else, so a result can never place a pin
the form would then refuse.

**None of it is load-bearing**, and the code says so: `GEOCODER_URL=off`
removes the box rather than leaving one that can only fail, and every failure
message names one of the three ways that still work. A test asserts that last
property, because a dead end is the one thing a convenience must never become.

### What the work turned up

**A React misuse that worked and logged an error.** The picker renders inside
the store form, so the search cannot be its own `<form>` — a nested form is
invalid HTML, the browser unnests it, and the outer form starts submitting on
the wrong button. So the action is dispatched by hand, and React only
establishes an action context automatically for a dispatch passed to a form's
`action` prop. Called bare it searched correctly *and* printed "an async
function was passed to useActionState, but it was dispatched outside of an
action context" into the console of a page whose whole purpose is to be trusted
with a shop's coordinates. Wrapped in `startTransition`, found by watching the
browser console rather than the screen.

**A stale message on a refusal decided client-side.** Typing two characters and
pressing Search left the previous result on screen, so somebody read "nothing
found" about a query that was never sent. `useActionState` cannot be written
to, so a client-side refusal needs its own slot.

Verified in a real browser against a stub Nominatim that logs what it receives:
the query carries `countrycodes=ph`, the city viewbox, the limit and the contact
address; the User-Agent identifies TARA; three candidates render and choosing
one places the pin and says to drag it onto the building; nothing-found, a
503 and a result outside the Philippines each produce their own sentence; two
searches in a burst reach upstream **once**; Enter searches without submitting
the store form; and the paste box and number fields keep working throughout.
Then again with `GEOCODER_URL=off`: no box, no credit line, everything else
intact.

870 tests pass; build and lint clean.

---

## Phase 24 — ratings ✅

`Store.ratingAvg` and `FleetPartner.ratingAvg` have been read in six places
since the first commit — the storefront, the service listing, search, the home
rail, the fleet profile, and **dispatch ranking** — and written by nothing
except the seed. Every one of those was showing or scoring a zero.

Now a customer rates a delivered order from the order screen: one review per
order, two optional scores, and an optional comment. Which scores apply comes
from the registry — a vertical with no merchant leg has no shop to rate, an
order nobody was dispatched to has no rider — so nothing in the flow knows
which services exist.

**The reviews are the truth and the aggregate is derived**, the same rule the
credits ledger follows and for a sharper reason: dispatch scores on
`FleetPartner.ratingAvg`, so a drifted average does not fail, it quietly offers
work to the wrong people. The aggregate is never incremented — it is recomputed
from the rows inside the transaction that changed them, both subjects every
time, because an edit that moves a score from the shop to the rider changes two
of them.

`npm run db:ratings-recompute` rebuilds everything and reports what it changed.
On a correct database that is nothing.

### Two privacy rules, and they are the design

Enforced by what the functions return rather than by remembering to redact:

- **A shop and a rider never see who rated them.** A rider who can see who gave
  them one star also knows that person's address. They get the order number
  instead, which identifies the transaction without identifying the person.
- **A comment never appears on a public page.** A free-text review on a shop
  page is a moderation burden and a defamation risk; the same sentence is worth
  a great deal to the operator and the merchant, who can act on it. The
  storefront shows stars only, and the form tells the customer both rules right
  next to the box.

The console's low-rating feed is the one place an identity and a comment appear
together, and it says so on the page.

### What the work turned up

**A check constraint that made a shop undeletable.** "A score implies a
subject" looks obviously right. But `storeId` is `ON DELETE SET NULL` so that
removing a shop does not erase the rider's half of the same review — so the
cascade nulls the id, the stars stay, and every DELETE of a shop with any
review on it fails on the check. Found by trying it against the real database,
which is the same shape of mistake as the RESTRICT foreign key that blocked the
demo purge in Phase 19. The invariant is a write-time one and now lives in
`submitReview` with a test on it.

**The seed was inventing ratings.** "4.7 from 412 reviews" was harmless while
nothing wrote ratings; it is a number no review supports now, and the first run
of `db:ratings-recompute` reported all four demo aggregates as drift. The seed
no longer writes them, so a demo shop shows "New" — which is true, and which
makes the feature demonstrable: complete an order, rate it, watch the number
appear.

**Every rating display was a claim nobody had earned.** They rendered
`★ 0.0` before, and one five-star review would have made a new shop look better
than a shop with two hundred reviews averaging 4.6. Below three reviews the
customer-facing badge now says "New" instead. A shop looking at its own numbers
still sees all of them, with a note saying customers do not.

Verified end to end in a real browser, against a real order placed through
`placeOrder` and walked to COMPLETED through the real state machine: the shop
shows "New" beforehand, the order list nudges, the form offers both scores and
explains where the comment goes, submitting clears the nudge — and then the
merchant sees the comment and the order number but **not** the customer, the
rider sees the same and their rating row reads 2.0 (1), and the console shows
the low rating **with** the author. Then arithmetically: three reviews flip the
badge from "New" to ★ 4.7, editing one review to one star moves the average to
3.33, and a from-scratch recompute agrees exactly.

908 tests pass; build and lint clean.

---

## Phase 25 — the ratings digest ✅

Phase 24 closed by naming this as a deliberate omission: a one-star alert is a
bad way to learn something and an easy thing to abuse. Both still true — and
neither is a reason to leave a complaint unread. The answer turned out to be
the shape of the message rather than its absence.

**One notification per subject, covering everything since the last one.** A
shop with a good lunch would otherwise get thirty of them, learn to swipe them
away, and miss the one that mattered. Batched, that becomes "3 new ratings for
the food at Aling Nena Carinderia, averaging 3.3. The lowest was 1 — open it to
read what they said."

The batching is a delay rather than a schedule: a batch goes out once its
oldest un-notified member is past an hour, so a rating that lands mid-rush
waits for the rest of the rush and nothing needs to know the time of day.

Three properties, each of which is the decision rather than the mechanism:

- **The numbers, never the words.** A comment is text somebody typed about a
  person, and a notification lands on a lock screen — the wrong place to read
  it, and the wrong place for somebody else to read it.
- **The worst score is named.** A digest that hid a one-star inside a good
  afternoon is one people learn to ignore, and the bad one is why you look.
- **INFORMATIONAL, so quiet hours hold it to 6am.** Nobody should learn they
  got one star at eleven at night. Never SMS: the volume is bounded by
  deliveries, which is the number that spikes on a good day.

At a shop it reaches MANAGER and above — staff work the queue, and a review of
the cooking is not theirs to answer. A shop with nobody at that level is
skipped rather than marked told, so its ratings wait for whoever is next given
the keys.

Verified against the real database and the real cron: nothing is due in the
first hour; backdating the batch produces exactly two digests (the shop, three
ratings averaging 3.33 lowest 1, to the OWNER; the rider, three averaging 4.0
lowest 2); the STAFF member at the same shop gets nothing; a second pass sends
nothing; a freshly un-notified rating produces a new digest rather than
colliding; both land in the right inbox with the right href, on IN_APP and PUSH
only — and no comment text appears in either.

### One thing found along the way, not fixed here

A non-admin hitting an `/admin` URL **records an error report**. The layout's
`notFound()` correctly wins the response, but the page's `requireAdmin()` throw
still reaches `onRequestError` and lands on /admin/errors. The 404 is right;
the error report is noise, and anybody could fill that page with it. Fixed in
Phase 26, because it belongs to the monitoring layer and not to ratings.

922 tests pass; build and lint clean.

## Phase 26 — only faults on the error page ✅

The gap Phase 25 left open, and it was worse than untidy. The error page is
read on the assumption that everything on it is broken; two of the four rows on
the real console were the system working correctly:

```
Error                     /help/contact   Connection closed.
AdminAccessRequiredError  /admin/support   That is only available to an administrator.
```

The first is a tab closed while the page was still streaming. The second is a
signed-in non-admin opening a bookmarked console URL: `requireAdmin()` throws,
the layout turns it into a 404, the customer gets the right response — and the
throw reaches `onRequestError` anyway. Anybody could have filled the page by
requesting `/admin` in a loop, which makes it a small denial-of-attention as
well as noise.

`lib/monitoring/expected.ts` is now the answer to "is this a fault", and the
whole module is a list plus one function. Three things about it are decisions
rather than mechanism:

- **The rule is the response, not the exception.** An error belongs on the
  ignore list only when what the customer received was correct. A refusal from
  an access check qualifies. `InsufficientCreditsError` reaching the hook does
  not — the refusal was right, but the 500 the customer saw means an action
  failed to catch it, and that is a fault.
- **The check runs first**, before the hash and before the database, so the
  loop case costs one set lookup instead of one write per request.
- **Matched by name, held to the classes by a test.** The module is reachable
  from the edge-compiled instrumentation hook, so it cannot import the error
  classes — a node-only import in that layer silently switches monitoring off,
  which is why the hash in `report.ts` is written out by hand. The test
  constructs all six classes and asserts both directions: every one is ignored,
  and no name in the list is one nothing throws any more.

Rather than dropping an ignored error silently, `reportError` returns
`notAFault: 'EXPECTED_REFUSAL' | 'ABANDONED_REQUEST'`. No caller reads it
today; it is there so that "nothing was written" and "why nothing was written"
are not the same answer.

**What this costs.** A role bug that wrongly refuses a legitimate administrator
now produces no error report. Accepted — the alternative is a page nobody
reads, and that bug is loud in the other direction, because the person locked
out says so within the minute. The list stays narrow for the same reason.

The abandoned-request match is on the message text, which is fragile, and
deliberately so: the name is plain `Error`, there is nothing else to key on,
and if React changes the wording the noise comes back and somebody notices. A
loose match would swallow real faults instead — `Connection closed. The
connection pool was exhausted.` from Prisma is still recorded, and there is a
test that says so.

Verified against the real server and the real database: three requests to
`/admin/support` and one to `/admin` as a non-admin all return 404, and the
existing `AdminAccessRequiredError` row stayed at one occurrence rather than
counting to five. Then straight at the reporter: the refusal and a dropped
connection both come back `recorded: false` with a reason, a `TypeError`
through the same call writes its row.

930 tests pass; build and lint clean.

## Phase 27 — a menu the shop can write ✅

Found while answering "what is next on the list": the merchant menu screen
edited a menu that nothing in the application could produce. `prisma.menuItem`
appeared exactly twice outside the seed, both `updateMany` — availability and
price on rows that already existed. No create, no rename, no delete.

So the launch step "replace the demo stores and menus with real ones" was not
doable: you could create a shop at `/admin/stores`, invite its owner, and then
publishing it was refused with

> That shop has no menu yet. A customer would find it, open it and see nothing
> — have the owner add items first.

which the owner could not do. The same shape as the store-creation gap in Phase
21: the back office had quietly assumed the seed file had already been there.

### One ordered list, sections as runs

`sortOrder` is a position in the store's entire menu, dense from zero, and a
section is a contiguous run inside it — the sections appear in the order their
first dish does. Every mutation resequences the list in the same transaction,
so the invariant holds after each edit instead of depending on each caller.

This also closes the "Add-ons leads the menu" gap that has been sitting under
Known gaps for weeks. It was listed as needing "a sort field on the category,
or categories as rows"; it needed neither. A `MenuCategory` table would turn a
rename into a migration of live rows and leave two places that can disagree
about what a section is called. The price of the run model is that a reorder
rewrites positions rather than one row, which for tens of hand-edited rows is
nothing.

Four decisions inside that are worth more than the mechanism:

- **A dish moves within its own section only.** Moving it past the edge of a
  run would silently recategorise it, so that is a reported no-op — "already at
  the end of its section" — rather than a surprise.
- **A section name snaps to the spelling already on the menu.** "add-ons" joins
  "Add-ons" instead of starting a second section beside it, because that mess
  can only be undone row by row.
- **The same name is refused inside one section, allowed across two.** Extra
  Rice as an add-on and as a rice meal are two sellable things; twice in one run
  is a double-tap the kitchen printout cannot tell apart.
- **Deleting really deletes**, and is safe for one specific reason: nothing
  holds a foreign key to `MenuItem` and every order snapshots the name and price
  it charged. The screen asks first, and the request carries the name the
  merchant was looking at — a phone left open in a kitchen is a stale view, and
  the destructive control on it is this one. A mismatch is refused with "this
  screen is out of date".

### Who may

Marking the pork out of stock stays at STAFF: the rice runs out at 8pm and
whoever is on the counter has to be able to say so. Adding, editing, renaming,
reordering and deleting need MANAGER, because they change what the business
sells rather than what is left today. The screen hides what a viewer cannot
use; every action re-checks, because a hidden button is not an authorisation
check.

Prices moved here too. `setItemPriceAction` was a second place that could write
`priceCentavos`, so it is gone and one module now decides what a price may be —
₱1 to ₱10,000, read from what a person actually types.

### Verified twice, because the ordering is the risky part

Against the real database, on a scratch store: eighteen checks covering every
operation, both refusals, the two no-ops, cross-store isolation (another shop's
item id matches nothing) and the merge that would collide. Then in a real
browser at 390px as three different people — fourteen checks, each polling the
rendered page rather than sleeping, so nothing was read mid-refresh.

The browser pass is the one that matters: Aling Nena's menu now renders **Rice
meals, Party trays, Add-ons** — the order the seed author wrote — where it used
to render Add-ons first. A dish added to a new section, a duplicate refused
however it was capitalised, `12.345` refused, a section moved up, a dish moved
down, a section renamed, a dish recategorised and repriced, the customer's page
showing the same arrangement, then deleted through its confirmation step. As
STAFF: no Edit, no Rename, no Remove, no add form, and the stock toggle still
working. A brand new shop with no menu shows the amber note explaining why it
cannot be published yet, and its first dish with no section given lands under
"Main".

975 tests pass; build and lint clean.

## Phase 28 — rider approval, in the console ✅

The last job in the whole application that could only be done over SSH.
Approving a rider was `npm run fleet:approve -- 0917… FOOD`, run by whoever had
the production database, for something that happens daily, from a phone, while
looking at a photograph of a licence.

`/admin/fleet` is now that job. The queue is one row per APPLICATION rather
than per partner, oldest first — that is the unit of the decision, and a rider
approved for food while still waiting on passengers should appear once, for the
thing outstanding.

### Three things the script could not do, and this does

- **Record who decided.** A shell has no identity, so `decidedByUserId` stayed
  null and no audit row was written. Both are now set, and the row on screen
  names the person.
- **Tell the rider.** `FLEET_VERIFICATION_DECIDED` is enqueued in the same
  transaction as the decision — named per service, because "you are approved"
  without saying for what is not actionable, and carrying the refusal reason
  verbatim, because the point of telling somebody their application failed is
  that they can fix it. IN_APP and PUSH, never SMS: they applied from inside
  this app, so the free channels reach them.
- **Refuse to decide an application nobody made.** The script upserts, so it
  will create an approval for a vertical whose documents nobody submitted —
  which is the exact mistake per-service verification exists to prevent. The
  console reads the row and refuses when there is none.

### The decisions themselves

**One per submission.** Each application renders its own controls with the
service in a hidden field, so nothing here can clear somebody for two verticals
at once. `enabledServices` is recalculated from the verification rows in the
same transaction, never assigned — dispatch reads that array on every candidate
query.

**The refusal reason belongs to the applicant.** It is written to
`rejectionReason`, which their own profile screen shows, and to the audit row —
one field, not two, because an administrator writing "see notes" in the box the
rider reads is how a refusal becomes a dead end. The form says so where it is
typed. An approval clears any previous reason.

**Suspension is a different judgement** and gets its own control and its own
audit action: not whether the documents are good, but whether somebody should
be working at all today. Approvals are left intact so reinstating is one click,
and `isOnline` is cleared — a partner left online while suspended is one
dispatch keeps considering and skipping while their own screen says they are
working.

### Two things found in the browser

**The console was showing stale state after every decision.** The actions call
`revalidatePath`, which invalidates the server's copy — but the page the
operator is looking at was rendered before the click, and a server action called
from inside a client function is a plain call, not a navigation. So an
application approved a moment ago still said "Pending", and clicking again
answered "already in that state". `ReasonForm` now calls `router.refresh()` on
success, which fixes **every** control in the console, not just this screen.
Verified: the refusal reason appears on the row without a reload.

**A row claimed the partner had been told when nobody had.** The seeded and
CLI-decided rows have no decider and sent no message, so "they were told" is
now shown only where a decider is recorded; those rows say "in a shell, so
nobody told them" instead. A comfortable lie about somebody still waiting to
hear is worse than an awkward truth.

### Verified against a production build, as two real people

Not the demo accounts: demo users are refused a session in production, which is
the protection working, so the run created a non-demo administrator and a
non-demo rider with a real pending application. Twenty-seven checks in a real
browser — the queue and its wait, the documents listed, an unapplied service
offering nothing, the audit reason blocked in the browser before it reaches the
server, a refusal landing live on the row with the reason and the decider, the
rider's own screen and inbox showing it per service and with the reason, a
reconsideration clearing the stale text, an approved row no longer offering
approval, both approvals offering suspension, the blanket suspension and the
reinstatement, and the approvals surviving both.

Afterwards the scratch rider was deleted and the scratch administrator left
inert — no roles, no sessions. It could not be deleted, and that is the audit
trail doing its job: it refuses to lose the actor of a recorded decision.

1021 tests pass; build and lint clean.

## Phase 29 — photographs on dishes ✅

`MenuItem.imageUrl` was in the very first schema and nothing ever wrote to it.
That is the honest reason it is now gone: a URL column is a promise that
something somewhere is hosting the file, and nothing was. The gap was never the
form field — it was that there was nowhere to put a photograph.

### Where the bytes go

**Into Postgres**, as a `MenuItemImage` row, for the same reasons the error
monitor is not Sentry: it works on the first deploy, with no bucket to create,
no credentials to rotate and nothing handed to a third party. The cost is that
the database dump grows with the menus, so `/admin/health` now shows the photo
count and their megabytes beside the backup size — "why did the dump get big"
should be answerable before it is a surprise.

The seam is one route handler wide: everything above it knows a photo by its id
and asks for `/menu-images/<id>`. Object storage later is an adapter, not a
migration.

### Nothing the browser says about the file is believed

`lib/media/image-bytes.ts` reads the type from the magic bytes and the size from
the header — a PNG's IHDR at a fixed offset, a JPEG's start-of-frame after
walking past the EXIF and ICC segments a phone puts in front of it. A declared
`image/jpeg` on an executable is a sentence anybody can write. The stored
`contentType` is therefore one this application decided, and the route serves it
with `nosniff` so the browser cannot decide otherwise either.

No image library, deliberately: reading two numbers out of a header is thirty
lines, and the alternative is a dependency that decodes attacker-supplied files
in the request path, which is the shape of every image-library CVE. **SVG is
refused** — it is a document that can carry script, and served from our own
origin it would be a stored cross-site script.

### Resized in the browser, and the reason is data cost

800px on the long edge. The first reason is mechanical: a camera photo is three
to six megabytes and a server action's body limit is one, so the upload would
fail before any of our code ran. The second is the one that matters: 800px is
twice the width of the phones this is for and lands at 15–90 KB, where storing
the original and letting an optimizer resize it would cost a shop's customers
about 150 KB a dish on a connection they pay for by the megabyte — for a
photograph rendered 72 pixels wide.

The resize is a convenience, not a check. The limits are enforced on the bytes
that arrive, because anything running in a browser is something its owner can
change.

### Two decisions worth keeping

**A replacement is a new row with a new id.** The obvious version — upsert,
keep the id — would leave every browser holding the OLD photograph under a URL
marked immutable for a year. Deleting and re-creating changes the URL, which is
what makes that cache header safe.

**Plain `<img>`, not `next/image`.** The file is already sized and served
immutable, so the optimizer would re-encode it into a cache directory this
container does not have, by fetching our own route from our own server while it
is answering a request — and it would make the storefront's photographs depend
on `sharp`, which is here as a transitive dependency of Next rather than one
this project declares.

And nothing is rendered where there is no photo: most menus start with none, and
a column of grey placeholders makes a text-only menu look broken rather than
plain.

### Verified with a real 3.5 MB file, in a real browser

Twenty checks, first attempt: a hand-written 1600×1200 PNG — larger than the
action body limit — resized in the browser and saved as **800×600, 15 KB**;
served from the route as `image/jpeg` whatever was uploaded, immutable, with
`nosniff`, and decoding in the page at 72px; readable with no session, because
the storefront is public; a text file refused with a sentence a shop can act on;
staff seeing the photo and none of the controls; a replacement producing a new
URL while the old one 404s; and removal taking it out of the row and the
database.

1052 tests pass; build and lint clean.

## Phase 30 — add-ons ✅

`FoodItemSnapshot.options` — a chosen option's name and what it added — has
been in the schema since the first version, and placement has always written
it. What never existed was a way for a shop to say what the choices ARE, so
the field could only ever be empty. Two rounds of notes in this file called it
"modelled but no UI", which understated it: it needed a table before it needed
a screen.

### Two numbers are the whole grammar

A group is a question with `minChoices`/`maxChoices`; an option is an answer
with a price delta. **(1,1)** is "pick a size" and cannot be skipped, so an
order never reaches a kitchen without saying which one. **(0,n)** is "any
add-ons you like". (2,3) is legal, because "choose two sides" is real. What is
refused is a group nobody can satisfy — and a required group whose answers have
all run out is announced on the shop's own screen as "nobody can order this
right now", because it is the one mistake here that a customer meets as a dead
end.

**A delta is zero or positive.** Selling something cheaper without the rice is
a different dish at a different price, and the honest way to do it is a second
menu item — three taps, now that the menu editor exists. One-directional money
means a line total cannot be argued down by a choice.

### Where the price is decided, and where it is only displayed

`resolveChoices(groups, ids)` takes ids and returns prices, never the reverse.
The store page runs it to show a running total; `quoteCheckout` runs it again
over rows read **through the menu item**, so an option id from another dish —
or another shop — is not in the result and is refused rather than priced. Four
refusals, four messages, because each has a different fix: not on this dish,
run out, too few, too many.

The cart still carries no prices. A line is `cartLineId(menuItemId, ids)`,
sorted so the same choices in a different order are one line, and the type is
**branded**: both a line id and a dish id are strings, so
`setQuantity(menuItemId, 2)` — what every one of these controls did before
dishes had choices — compiled perfectly and moved the wrong line. The brand
turned that into a compile error and caught it inside this change.

A dish that asks nothing keeps one-tap Add and its stepper. That is most of a
carinderia menu and it should not get slower because another dish has sizes.

### Two bugs the tests found in my own code

**The helpful refusal was unreachable.** A shop typing `-10` got "write the
price in pesos, like 15 or 0" — the generic parser rejects a minus sign before
the range check ever runs — so the message explaining to sell it as its own
dish could never appear. The minus is now caught first.

**A validation that could not fail.** `normaliseChoiceBounds` floored the
numbers and then asked whether they were integers, which is always true after
flooring: "at least 1.5" silently became 1. It now checks before rounding.

### Verified twice, and the money path first

Thirteen checks against the real database through `quoteCheckout`: the unit
price including the choices, the line total multiplying all of it, the snapshot
in the shop's order, the subtotal, and every tamper case — a missing required
size, two sizes, an option from another dish, one that ran out, a made-up id,
and more add-ons than allowed. Then twenty-two in a real browser at 390px: the
shop declaring a question and its answers, the negative price refused with the
useful sentence, a customer's panel with radios for one and checkboxes for
several, the out-of-stock answer disabled, Add refused until the size is
answered, ₱150 → ₱180 → ₱195 as the choices land, the same dish added twice
with different choices becoming two lines, checkout naming them and pricing
them, and a real order placed.

The placed order's snapshot, read out of Postgres afterwards: two lines of one
dish — Large with extra rice at ₱195, Regular at ₱150 — subtotal ₱345, each
choice carrying its name and the delta it added.

The demo carinderia's sinigang now seeds with a Size question and an Add-ons
question, so the first thing a shop owner opening the menu screen sees is what
the feature is rather than a note saying it exists.

1097 tests pass; build and lint clean.

## Phase 31 — Live tracking: the rider's pin on the customer's screen

A customer with an order in transit now gets a map: their address, the rider,
and how far apart the two are. Building it turned up something worse than a
missing feature.

### The action nothing called

`updateLocationAction` has existed since dispatch was built, and **nothing ever
called it**. A partner's position was written once — when they tapped Online —
and then aged for the rest of the shift. Two consequences, one of them live in
production logic for six phases: dispatch has been ranking candidates by
distance from wherever they were when they clocked in, and any map would have
shown a motorcycle parked outside wherever the rider had breakfast.

So the customer's map is the second half of this change. The first is
`LocationShare`, mounted in the fleet layout, which subscribes to
`watchPosition` while the partner is online and stops when they go offline.

`watchPosition` rather than a timer around `getCurrentPosition`: the browser is
already keeping a fix, and waking the radio every fifteen seconds is how an app
becomes the reason a rider's battery dies before their shift ends. The
**writes** are what get throttled — fifteen seconds and twenty-five metres — so
a phone at a red light is quiet.

The rider is told it is happening, in the header, with the numbers: a background
location share nobody mentions is the kind of thing that ends up in a news
story.

### Four gates, and every refusal is `null`

`riderPositionForCustomer` answers with a position or with nothing. Not an
error, not a partial answer — six separate `return null`s, because "why can't I
see the rider" is not a question the answer should help somebody explore. It
checks, in order: the order exists, **it belongs to the person asking**,
somebody is actually carrying it, a rider is assigned, the coordinates are not
null, the fix is under ninety seconds old, and the coordinates are inside the
Philippines.

`TRACKABLE_STATUSES` *is* `ACTIVE_JOB_STATUSES` — imported, not copied. A
tracking window maintained separately from the lifecycle drifts out of step with
it, and the drift shows up as a pin on a delivered order.

The order page asks for the rider's **name** and never the position columns. The
coordinates reach the browser through the polled action alone, four numbers at a
time.

### Distance, never an ETA

"3.8 km away", with a caption saying it is a straight line and that it
disappears if the signal goes quiet. Minutes across Metro Manila from a
straight-line distance is the number that makes somebody go and stand at a gate,
and there is no routing engine here — so the claim is not made, and a test greps
the component to keep it that way.

### Three bugs, two of them mine and only findable in a browser

**A fix refused for being early was refused forever.** `shouldShareFix` measured
the interval between the two *readings* rather than against the clock. A reading
taken two seconds after a write is two seconds after it permanently — so it was
dropped, and because `watchPosition` reports *changes*, a rider who moved and
then stopped got no further callback and the position they stopped at was never
written. Stopping is what arriving looks like. The rule now takes `now`, and the
newest reading is held and reconsidered every three seconds instead of being
discarded.

**The map was unreadable and every test passed.** `RiderMap` never imported
`leaflet/dist/leaflet.css`. The tiles loaded, Leaflet marked them loaded, my
browser check counted six of them and two markers and went green — and the tiles
were stacking down the page in document flow, because `.leaflet-tile { position:
absolute }` lives in that stylesheet. Counting DOM nodes is not looking at a
map. The e2e now samples a grid of twenty-five points across the map box and
requires every one of them to land inside a tile, and a unit test asserts the
stylesheet import in *every* component that draws a map, because the omission is
easy to repeat and invisible until somebody looks at a screen.

**`next/headers` in the client bundle, for the fourth time — and the first to
take a page down.** `RiderMap` → `orders/tracking.ts` → `fleet/partner.ts` →
`auth/session.ts` → `next/headers`, and both `/fleet` and the order page
returned 500. `ACTIVE_JOB_STATUSES` moved into a new pure `fleet/job-policy.ts`
which imports nothing but types, re-exported from `partner.ts` so no call site
changed. That is the fifth such module now, each with a guard test.

### Verified in three places

Forty-three unit tests: the trackable set against every lifecycle in the
registry, freshness including a fix dated slightly in the future, the share
throttle including the held-fix case above, distance wording, and greps for the
privacy boundary, the transport, the rider-side copy, the map's honesty and the
stylesheet.

Ten checks against the real database: a fresh fix returned, a stale one
withheld, another account given nothing, a forged order id given nothing,
nothing once DELIVERED or COMPLETED or CANCELLED_BY_CUSTOMER, a null-island fix
dropped, a rider who never shared, and an order with no rider.

Seventeen in a real browser at 390px, both sides at once: the tiles covering the
box, two pins, the freshness line, no arrival claim, the rider's pin moving and
the distance closing when the position changes, a stale fix blanking the pin and
replacing it with "No signal from Maria for a moment", no sharing while offline,
going online writing a first position, the rider being told they are sharing, **a
moved phone reporting again** — which is the assertion this whole phase exists
for — and no map at all on a delivered order.

1142 tests pass; typecheck and lint clean.

## Phase 32 — Payments

Customers can now pay before the food is cooked. Cash on delivery still works
and most orders will still use it, but riders carrying a shift's takings was the
largest operational risk in the business, and this is the thing that reduces it.

### The rail, and why it is a person rather than a webhook

The prepaid rail is a transfer the customer makes themselves: they send the
total in GCash (or Maya, or their bank), put the order number in the note, and
type the reference back into the app. Somebody with access to the receiving
account checks it at `/admin/payments` and confirms. Only then does the order
reach the shop.

I could not have shipped a provider integration honestly this session even if
it were the right call — both PayMongo documentation domains are blocked by
this environment's network policy, and I will not write a wire format from
memory and call it verified. But the better reason is sequencing: a provider
account needs DTI or SEC registration and BIR registration, which are still
open items on the launch checklist. This rail needs a phone number, charges no
per-transaction fee, and is how a great many small Philippine businesses
already take money.

What it costs is a person's attention, once per order. It does not scale past
the volume one person can check, and `src/lib/payments/rails/` is the seam for
a provider rail when it starts hurting — `begin()` already returns a
discriminated union so a hosted redirect is a second arm rather than a rewrite.

**No webhook verifier ships until something calls it.** I nearly built one:
signature verification is provider-agnostic and fully testable, and it would
have looked like progress. This codebase has now been bitten three times by
machinery that was designed, committed and never wired up — twice in the last
two phases — and adding a fourth piece would have been repeating the mistake
while writing about it.

### A second ledger, not a status column

`PaymentEvent` is the credits ledger's twin: append-only, sign forced by event
type, one write function, and `Order.paymentStatus` as a derived cache the way
`Wallet.balanceCentavos` is. Seven event types, split between claims that move
nothing and events that move money — because a customer saying they have paid
is not money arriving, and the gap between those two is where a payments bug
lives.

The two ledgers are separate tables with **no schema path between them**, which
is what makes "cash can never become credits" checkable rather than a
convention. `REFUND_DESTINATION` states it per instrument, and the database
repeats it: a credits refund is refused for an order that never spent credits,
and a transfer-paid order has no such row. Pay ₱500, cancel, keep ₱500 of
spendable balance would be a top-up, and the credits design promises there
isn't one.

### The third dead feature this codebase has been hiding

`PENDING_PAYMENT` has been in `OrderStatus` since the schema was written, with
the right edges in four of the five lifecycles, and nothing ever used it. After
`updateLocationAction` last phase and `setItemPriceAction` before that, I have
stopped being surprised. RIDE was the fifth lifecycle and did not have the edge
— a drift nobody would have noticed until Sakay launched without prepayment,
which is the vertical where prepaying matters most.

### Four bugs, three of them mine

**A claim looked like nothing had happened.** The expiry sweep cancels an
unpaid order after twenty minutes. A customer's claim derived as `PENDING`, so
the sweep cancelled orders where somebody had sent the money and was waiting on
*us* to check it. Cancelling an order because we were slow is not a timeout, it
is a bug with a clock attached. `CLAIMED` is now its own payment status — not
`AUTHORIZED`, because in payments that word means an issuer approved the funds
and anybody can type thirteen digits into a box. Found against the real
database; the unit tests happily asserted the wrong thing because I had written
them to match the code.

**A cancelled prepaid order kept the customer's money.** Three call sites each
refunded credits, and none noticed that a transfer-paid order has no credits to
refund — so the credits refund correctly returned zero, correctly did nothing,
and the ₱324 stayed with us. One `settleCancelledOrder` now handles both halves.

**The refusal reason never reached the screen it was for.** The console demands
a reason so the customer can act on it — "check the last four digits" is the
whole value — and it went to their notification inbox while the order screen,
the one with the field they have to correct, said "We could not match that
payment". True, generic, useless. Found in a browser.

**A guard that would have refused a legitimate refund.** My first version
checked the destination against the order's headline payment method, which
would have refused to return credits genuinely spent on a part-transfer order.
The rule is per portion, not per order; the invariant is enforced at both ends
instead.

### Two vacuous tests, worth recording

Two of my browser checks passed regardless of what the app did. One matched the
word "reason" against the form's own explanatory copy rather than a validation
failure. The other polled for a condition that was already true before the
click, so it returned instantly and reported a stale reading. Both now assert
the effect — the browser's own `validity`, and the payment status actually
changing.

### What is not built

**Settlement.** Prepaid money arrives with us, not with the shop, and nothing
here pays a store or a rider out. That needs a bank arrangement and the business
registration. Each payment records the order it was for, so what is owed is
computable — computing it is not paying it, and it is the next real piece of
work.

### Verified in three places

Seventy unit tests: the no-top-up rule per instrument and asserted in the SQL
guards, the prepaid hold and its timeout across every lifecycle in the
registry, event signs against the database CHECK constraint, the derived status
through short payments and refusals and partial refunds, reference parsing, and
what the rider is told to collect.

Twenty checks against the real database with the guards applied: the whole
prepaid path from claim to kitchen, a short payment not opening it, a double
tap not charging twice, the append-only trigger, the sign constraint, **a
credits refund of transfer money refused by the database**, credits still
refunding to credits, the refund queue clearing itself, and the sweep leaving a
claimed payment alone while letting an unclaimed one go.

Twenty-six in a real browser at 390px and 1280px, customer and console at once:
choosing the transfer, the account details and our reference on the order
screen, an unreadable reference refused kindly, a claim recorded as a claim,
the console queue with the wait and the reference to look for, a refusal that
cannot be submitted without a reason and does not cancel the order, the reason
reaching the customer where they retry, confirmation sending the order to the
shop, the audit row, **the rider told to collect nothing on a prepaid order and
₱399.00 on an unconfirmed one**, and a cancelled order's refund recorded with
no credits row written.

1222 tests pass; typecheck, lint and build clean.

## Phase 33 — Settlement

Payments answered "did the customer pay". This answers the question behind it:
the money is now somewhere, and it belongs to somebody else.

### The realisation that shaped it

Settlement direction depends on **who physically collected**. A ₱399 cash order
puts the whole total in the rider's hand — the shop's money and ours along with
their own ₱39 fee — so the rider ends up owing TARA ₱360. The same order paid
by transfer leaves it with us, so we owe the rider ₱39 and the shop ₱350. Same
ledger, opposite sign.

That is why this had to be a netting ledger rather than a list of earnings, and
it is what makes the cash problem tractable for the first time. The console now
totals "cash held by riders", and the rider's own screen says, in an amber band:
**you are holding ₱360 of TARA's cash — hand it in.** The launch checklist has
called cash handling "the operations problem most likely to bite in week one"
since Phase 26; nothing in the app knew the number until now.

### Every centavo belongs to exactly one party

`splitOrderValue` divides an order's gross three ways: the shop gets the food
less commission, the rider gets the fee and the whole tip, and the platform gets
**the remainder**. Defining the last share as what is left makes the split
exhaustive by construction — a fee added to the schema next year lands somewhere
rather than nowhere.

Computed on the GROSS, never on what the customer paid. A subscription waiver,
a promo and credits spent reduce the customer's total without reducing what the
shop cooked or the rider rode; TARA absorbs that, and settling on the total
would silently take it out of a partner's pay.

Commission is data on the store, in basis points, **zero by default** — a
non-zero default would have invented revenue and quietly changed what every
existing shop was owed. It touches the subtotal only, never the tip, and rounds
down so the fraction of a centavo stays with the shop.

### A test found a real hole

My first version asserted that the three shares sum to the gross and that the
shop's and rider's shares are non-negative. The platform's was not checked —
and a sum can balance while a part is negative. Pay a rider more than the order
is worth and the platform's share goes negative, absorbing the difference
without a word. **The remainder never complains, which is exactly why it needs
checking.** The exhaustive unit test over every combination of fees, tips and
rates was already asserting it; the function was not.

### The third ledger

`SettlementEntry`, with the same discipline as the credits and payment ledgers:
append-only trigger, sign forced by type, one write function, a reference
required wherever a person asserts something happened off-system.

One deliberate difference, written down so nobody "fixes" it: **the balance is
not cached.** `Wallet` caches because spending must check a balance atomically
on the hot path of every checkout. Nothing here is blocked that way, so a
summed query beats a column that can drift. The one thing that does check it —
a payout — reads the sum inside its own serializable transaction.

Accrual runs inside the completion transaction. An order that completed with no
accrual is a shop that cooked food nobody recorded owing it for, and the only
way to find those afterwards is to trawl every order against the ledger.

### Nothing in this app moves money

Every control records that a person moved it, with a name, a reference and a
reason — the same posture the customer refund control takes. A payout cannot
exceed the balance: paying past what is owed is an unrecorded loan the next
accrual swallows, and on a rider holding our cash it is handing money to
somebody already in debt to us. The partner screens say it out loud, because a
rider who expects the app to pay them will not chase a payout that never
arrives.

### Two vacuous checks, again

Two live-database checks passed for the wrong reason: my raw inserts testing the
one-party constraint had no `orderId`, so a *different* constraint refused them
first and the party rule was never reached. They now assert which constraint
fired, by name. That is the same class of mistake as the two vacuous browser
checks in the payments phase — worth recording twice, because a check that
cannot fail is worse than no check: it reports safety that was never tested.

And a third: the browser pass set a commission on whichever shop sorted first
alphabetically rather than on the one under test, then read zero from the right
one and called it a bug. The fixture is now reset at the start of the run rather
than only at the end, so it is re-runnable.

### What is still not built

- **No bank rail.** No provider, no scheduled payout run. Recording only, and
  that is the honest limit: the money has to be moved by a person with access to
  a business account, which needs the registration in the checklist.
- **No commission snapshot on the order**, so an order completed a week late
  accrues at today's rate. A migration for a column that is zero everywhere is
  not worth it yet.
- **Surge goes to the platform**, because that is what `partnerEarningsCentavos`
  already tells riders they earn and settlement must not disagree with the fleet
  screens. It arguably belongs to riders; that is a pay decision, and it changes
  in one function when somebody takes it.

### Verified in three places

Forty-three unit tests, led by an exhaustive sweep of the split across five
subtotals, three fees, three tips, two surges, two small-order fees and five
commission rates — 900 combinations, each asserting the shares sum to the gross
and none is negative.

Twenty checks against the real database: accrual on both sides of a prepaid and
a cash order, idempotency, the append-only trigger, the sign constraint, the
exactly-one-party constraint asserted by name, the commission cap, the payout
ceiling in both directions, a claim with no reference refused, the full cash
round trip netting to zero, and a cancelled order accruing nothing.

Twenty-three in a real browser across three roles: the console showing both
directions and the float, a rider told they are carrying TARA's cash with the
mark on their tab, a shop shown what it is owed and that the tip is not its to
be charged on, a payout past the balance refused in a sentence, a payout with no
reference refused, the shop paid and the cash handed in, both landing on zero
with every movement still on the record, and a commission rate refused at 99.99%
then accepted at 2.5% with an audit row.

1277 tests pass; typecheck, lint and build clean.

## Phase 34 — Surge belongs to the rider

Settlement made the old split visible: surge was falling to the platform. Not
by decision — `partnerEarningsCentavos` counted the fee and the tip, and the
platform takes whatever the split leaves over, so surge went there by omission.
This is the decision taken once it was visible.

Surge exists to get somebody to accept a job in bad weather or at 2am. Surge
that reaches the platform instead of the rider is a price increase with no
incentive attached: the customer pays more and nobody is any more willing to
ride.

**The change is one line**, which is what having a single definition of rider
pay buys you — the fleet screens, dispatch offers and settlement accrual all
followed, and the settlement split needed no edit at all because the platform
takes the remainder. The remainder design paying for itself.

### The trap the one-line change walked into

Every screen showing a rider their finished jobs was RECOMPUTING earnings from
that function. So the moment the rule changed, every job they had ever done
silently restated itself — a figure that was never accrued and never paid. A
rider would open last Tuesday and see money they did not get.

That is the settlement ledger's own failure mode arriving from the opposite
direction: an app promising one number and settling another. So for a settled
job the **ledger** is now the truth, because it holds what was accrued under
the rule in force at the time; the rule is consulted only for jobs still in
flight, where it is exactly right because it is what the rider is about to be
paid.

The general lesson is worth more than the feature: **a derived money figure
recomputed on read is a figure that rewrites itself whenever the formula
changes.** Store it when it is decided, or read it from where it was stored.

A near-miss in the same place, caught while fixing it: the query behind a
rider's today/week totals selected only the fee and the tip. Once surge became
the rider's it would have been missing from those totals while appearing on the
job list — two figures on one screen, disagreeing.

### A pay rise nobody can see is not a pay rise

The rider's job screen and each dispatch offer now break the figure down —
"₱39.00 fee + ₱25.00 surge + ₱20.00 tip" — but only when there is more than one
part, because "₱39.00 fee" under a heading that already says ₱39.00 is noise.
The parts are derived from the same fields the total adds up, so they always sum
to it: a breakdown that does not match the number above it is worse than no
breakdown.

### Nothing sets surge

`quoteOrderPrice` accepts `surgeCentavos` and no caller passes it. Every order
in the database has zero, so **this change is retroactively invisible and no
rider is owed a backfill** — which is the one genuinely convenient thing about
having found it late.

What is missing is the pricing decision, not the plumbing: when surge applies
and how much. That is a product and economics question — demand against
available riders, weather, time of day, a cap so a customer is never surprised
— and it wants a rule that can be explained to both sides of the market. I did
not invent one. `DeliveryFeeRule` is where it would live, and the rider's
screens are already ready for it.

### Verified in three places

Twelve new unit tests: the allocation, the surge going to the rider and coming
off the platform, a missing surge reading as zero, the breakdown summing to the
total and omitting absent parts, the split still balancing on a surged order
and on a surged order nobody delivered, and the history rules.

Nine checks against the real database: a surged order accruing fee + surge + tip
to the rider with the platform keeping only the service fee and the shop
untouched; **a job settled under the old rule still showing what it paid**
(₱59.00) where today's rule would say ₱84.00; and a rider's week total computed
ledger-first across a mixed set of settled and pre-ledger orders, differing from
the rule-only total by exactly the surge.

Four in a real browser: ₱84.00 on the job screen with the breakdown beneath it,
and a plain job showing the figure with no breakdown at all.

1289 tests pass; typecheck, lint and build clean.

## Phase 35 — Surge pricing

Phase 34 gave the surge to the rider and then admitted the honest gap: nothing
set it. `quoteOrderPrice` took a `surgeCentavos` no caller passed, every order
in the database held zero, and I declined to invent the rule because it is a
product and economics question rather than a plumbing one.

This is the rule.

### The requirement that decided everything

Surge is the only number in this app that goes UP on a customer who did nothing
except open it at a busy moment. So the whole feature is arranged around one
demand: **a customer who asks why it is ₱79 instead of ₱49 gets an answer, and
gets the same answer twice.**

Four choices follow.

**Steps, not a multiplier.** A continuous 1.3× moves the fee on every refresh —
₱43.17, then ₱44.02 — and a price that will not hold still reads as a price
being made up. A step is a flat peso amount with a name: "Busy, +₱20".

**Off unless somebody turned it on.** No `SurgeBand` rows means no mechanism at
all, the same posture as commission starting at zero. And there is deliberately
no way to configure a step that adds ₱0 — both the console and
`surge_band_step_sane` refuse it — so "off" is unambiguous rather than
something a ₱0 row could fake.

**Measured on a schedule, read by quotes.** The maintenance sweep counts the
market once a minute and writes a `SurgeSnapshot`; a quote reads the newest one
and counts nothing itself. `placeOrder` re-quotes through the same
`quoteCheckout` that rendered the screen, so the displayed price and the charged
price are the same code path. There is nothing for a client to tamper with, and
a complaint about a fee at 6pm is answered from the snapshot rows.

**Every uncertainty resolves to not charging.** No bands, no snapshot, a reading
older than five minutes, a snapshot from the future, a step capped to nothing —
all ₱0. The failure mode is "we missed a chance to pay riders more", never "we
billed somebody for a market condition we could not confirm".

### Monotonic by construction

Among the steps a ratio has met, selection takes the **largest amount**, not the
highest threshold. Identical on any ladder that climbs; different only when one
is mistyped — 1.5 → ₱30, 2.0 → ₱10 — and there highest-threshold-met would
charge a busier market *less*. A customer watching the queue grow would watch
the price fall, and no screen could explain that. `firstDescendingStep` exists
so the console can point at the mistake instead.

### Never more than was shown

A snapshot can roll over between rendering checkout and tapping the button. The
alternative to handling it is charging the higher figure, which is precisely
what this feature exists to prevent — so placement carries the surge the screen
displayed, refuses with `SurgeChangedError` if the fresh figure is higher, and
the screen re-quotes so the new total is on it before the second tap.

That accepted figure is client-supplied and treated as such: **compared, never
used as a price.** A tampered value can only cause a refusal — a lower number
buys an error, not a cheaper order. A surge that *fell* is charged lower without
comment.

### The charge and its reason travel together

`Order.surgeLabel` is copied from the band at placement, because a receipt has
to stay readable after the bands are edited and the snapshot is gone. Two CHECK
constraints spell the pairing on the order and on the snapshot: money with no
name means something wrote a surge without going through a quote, and a name
over ₱0 means a screen saying "Busy" above nothing.

### Zero riders is not zero surge

One rider with eight orders queued is at the ceiling. If that rider ending their
shift took the surge to zero, the price would fall at the exact moment the wait
got longest. So with no riders each waiting order counts as its own unit of
pressure — continuous with the one-rider case. An empty market is still zero,
which is the honest reading of 3am.

### A bug the real database found

`currentSurge` bounded its lookup with `createdAt >= now - window`. Fast, and
wrong: an aged-out snapshot did not match, so the rule saw `null` and answered
`NO_SNAPSHOT` — *"the market has not been measured yet"* — for a market measured
all day until the cron died. The one failure the console exists to reveal,
reported as its opposite, and it made the `STALE` branch dead code in the only
path reaching it. The bound bought nothing: the index makes "newest row for this
market" a single seek at any size. The console now shows charging, **stale** and
**no snapshot** as three different states.

Two fixture bugs are worth recording for the same reason they cost time before:
the live-database run built its waiting orders by copying a template's addresses
and so filed the pressure in whichever city the template was in, not the store's;
and the browser run navigated to a dish page by a guessed link, landed back on
the store with an empty cart, and reported it as a missing surge line. Both were
the check being wrong, not the code.

### The console

`/admin/surge` measures the market live for the screen and reads the snapshot for
the charge, side by side. When the live ratio has earned ₱40 and the charge says
₱0, exactly two things can be true — the market just moved, or the sweep has
stopped — and the second is invisible everywhere else precisely because every
uncertainty here resolves to charging nothing. Hence a "last measured" stat and
an alert when it is past the window. Cities with no ladder are listed too, wider
than what the cron measures, because those are the markets where a step gets
added. Adding, editing and switching a step each demand a reason; activation is
audited separately from amounts, because "was surge on in Manila at 6pm?" is the
question a complaint asks.

### Verified in three places

**71 unit tests** (26 more than the ratio rule alone): the ladder monotonic
across the whole range on a mistyped ladder as well as a good one, the ceiling
agreeing with the SQL guard, the boundary at exactly five minutes, a snapshot
from the future refused, every path producing a labelled ₱0 checked against the
constraint that forbids one, a free-delivery benefit **not** reaching the
rider's surge, and greps that the sweep measures after the timeout pass and that
the screen actually sends the figure it displayed. Three of those greps were
confirmed to fail by mutating the seams they guard.

**Ten SQL-guard checks** against the live database: two fallback steps at one
threshold refused while a city step at the same threshold is allowed, a ₱150
step, a step at zero orders per rider, a step adding nothing, a blank label, a
snapshot charging with no reason, a label over a zero, and a negative rider
count — each refusal naming the constraint that fired.

**Nineteen more against the live database**: the sweep counting two waiting
orders and one free rider, a rider on a job counting as unavailable, the quote
carrying the surge and its label, the total higher by exactly the surge,
placement refused above the displayed figure and accepted at it, the order guard
refusing money with no reason, a stale reading told apart from a market never
measured, and **the rider accrued the fee plus the whole surge** (₱64.00 =
₱39.00 + ₱25.00).

**Seventeen in a real browser**: "Sobrang busy ₱50.00" on its own line with the
sentence saying the extra goes to the rider; the band raised and re-measured
while the page sat open, the tap refused, no order written at the price the
customer never saw, and the screen re-quoted from ₱419.00 to ₱449.00 before the
second tap went through; the receipt naming the charge; and the console showing
the market, the charge, and the stopped-sweep alert.

1360 tests pass; typecheck, lint and build clean.

## Phase 36 — Surge notifications

Phase 35 set the price. Nobody was told about it — which meant surge was, for
one phase, exactly the thing I had written it must never be: a price rise with
no incentive attached. The customer pays more and no more riders come out.

### The problem is not sending, it is not sending

The market is measured every minute, and almost none of those minutes are news.
A feature that notified on every measurement sends sixty pushes an hour to
every rider in a city, and the result is not an informed fleet — it is an app
whose notifications everybody has switched off, including the ones that say an
order is waiting for them. So nearly all of this phase is filters:

- **Only a step UP.** Unchanged is not news. Falling is deliberately silent: a
  rider invited by "₱40 extra" who arrives to ₱20 was misled by a message that
  was true when it was sent, which is worse than never sending it. A unit test
  runs an hour of realistic readings — surge starts, holds, steps up, holds,
  fades — and asserts **two** messages, not sixty.
- **Only riders who are offline.** An online rider is already in the dispatch
  loop and their offers carry the surge inside the earnings figure.
- **A 45-minute cooldown**, read from the notification table rather than a
  column on the rider, because the record of what somebody was told is the
  right place to ask what somebody was told.
- **Nothing at 2am** — which needed a new idea.

### Perishable

Every other message in the system describes something that happened, so quiet
hours DEFER an informational push to 6am; those read no differently over
breakfast. "It is busy right now, come out" held overnight does not become
late, it becomes **false**. A rider who gets up for a surge that ended at
midnight has been lied to by the app.

So `KindPolicy` gained `perishable`, `deliverableAt` gained a **null** return
meaning never rather than later, and the delivery is recorded `EXPIRED` — kept
distinct from `SKIPPED` because "they muted this" and "we decided it had gone
stale" are different facts. The same flag makes the delivery pass drop a
perishable row that waited longer than five minutes, which is what stops a
sweep that was down for twenty minutes from coming back and telling two hundred
riders about a rush that is over.

The inbox copy is never dropped. What quiet hours remove is the interruption,
not the information.

`OPERATIONAL` would have pushed it through the night, and that is wrong rather
than bolder: nothing waits on this particular rider, so an invitation to work at
2am is not the app's decision to make for somebody who chose to be offline.

### One switch, and why it is not a channel

`wantsBusyAlerts` is the only per-kind preference in the app.
`NotificationPreference` is keyed by CHANNEL, so declining an invitation to work
through it would also mute "an order is waiting for you", and those are not the
same consent. The switch's copy says what it does **not** change, because "stop
telling me about surge" reads as "stop paying me surge" to somebody scanning it.

### The alert nobody can write

There is no "the sweep has stopped" notification and there cannot be a useful
one: the thing that would detect it is the thing that stopped. A check that can
never fire is worse than an acknowledged gap, and this codebase has produced
enough of those. The console banner covers it as far as a screen can, and the
rest belongs to whatever watches the cron from outside.

### Three bugs, each found one layer further out

**Units passed. The live database found that switching surge off kept charging
it.** Deactivating a city's only band removed the market from
`pairsToMeasure`, so no snapshot was written, so the newest one stayed at ₱50 —
and quotes read the newest snapshot. Customers paid a surge the operator had
just switched off for up to five minutes, while `/admin/surge` said surge was
off everywhere. A market whose newest reading is non-zero is now measured even
with no ladder: one zero row, then out of the list.

**Then it found that a ladder change rewrote history.** `sustainedRun` counted
readings at-or-above the ceiling, so switching the top step off dropped the
ceiling and made every older, higher reading count — the run stretched back
through a ladder that no longer existed and the alert announced 765 minutes of
short staffing. The comparison is exact now.

**Then the browser found that nobody was ever told anything at all.** The sweep
called the measure pass and the alert pass with two separate `new Date()` calls
milliseconds apart. `previousReadings` asks for the newest row strictly before
`now`, so the later instant included the row just written: the previous reading
was the current reading, no market ever looked changed, and not one alert was
sent. Every unit test passed. **The live-database check passed too — because
that harness helpfully passed one clock to both, and so verified a wiring that
did not exist.** It surfaced only as a sweep printing no alert line in a real
run. `recordSurgeSnapshots` now returns the instant it stamped and the alert
pass takes it, so the two agree by construction.

That is the sharpest version yet of the lesson this project keeps relearning: a
test harness more careful than production tests the harness.

### Verified in three places

**41 unit tests**: an hour of measurements yielding two messages, every
transition case, the perishable rule dropping rather than deferring, the inbox
copy surviving quiet hours, the run arithmetic measured from the clock rather
than by counting rows, a ladder change ending a run, and greps that the switch
exists, that no self-detecting stall alert does, and that the two passes share
one instant. Three seams were mutated to confirm the checks fail.

**Eighteen against the live database**: twenty sweeps of one busy market
producing ONE message; the online rider and the opted-out rider not told; a step
up inside the cooldown held; a new rush past the cooldown landing; switching the
last step off writing one zero and stopping the charge; a 2am alert written
EXPIRED while its inbox copy stays PENDING; a stale queued alert dropped with
zero send attempts; the offers board agreeing with the figure the alert quoted;
and a market at a lower step never reported however long it lasts.

**Thirteen in a real browser**: the sweep's own line reporting one rider
invited, the amber panel reading "Food · Sobrang busy ngayon +₱30.00" with the
sentence about the fee and the tip, the message in the inbox naming the city and
the amount, the switch starting on and its new value reaching the database, a
later step-up then reporting "1 market stepped up, 0 offline riders invited",
and the panel disappearing when the market calms rather than showing a zero.

1400 tests pass; typecheck, lint and build clean.

## Phase 37 — Referrals

Referrals are the only path in this app by which credits come into existence
**at the invitation of a user.** Every other grant is caused by an order
completing or by an administrator acting against their own name. So this phase
is mostly refusals, and the interesting part is which defences are real.

### What does not work

The obvious attack is self-referral: one person, an account per SIM card. A
`referrerId <> refereeId` check catches the naive version and nothing else — two
accounts held by one person are, to the database, two people. Phone numbers are
cheap here, no device identity is held, and address matching would refuse
mostly-honest cases, because households routinely share an address and a feature
that accuses a mother and her daughter of fraud is worse than one that pays them
both.

I did not build fraud detection, and the reason is written down rather than
implied: there is nothing honest to detect with.

### What does work

Three structural facts, none of them clever:

- **The reward is credits**, which cannot be topped up, transferred or cashed
  out. A farmer's payoff is discounted food, not money — the wallet constraint
  doing work it was not written for.
- **The inviter is paid only when the referee's first order COMPLETES**, above a
  minimum. Farming costs a real order that was paid for and delivered.
- **Caps**, per month and for life, per inviter. The only mechanism that works
  without knowing who anybody is: an enthusiast and a farmer look identical for
  the first three referrals.

### The one number the console shows

That leaves the amounts, which decide whether the whole thing is farmable and
are not mine to pick. So `farmerMargin` computes what a person referring
themselves nets per account, and `/admin/referrals` shows it — green when
self-referral costs money, a red alert when it pays, with the arithmetic spelled
out, and repeated in the save confirmation so it cannot be missed by somebody who
never scrolls back.

A warning rather than a refusal: a launch subsidy that loses money per account
can be deliberate; buying accounts by accident cannot. The welcome credits count
towards the farmer's outlay, which is why **a generous referee reward with a low
minimum is the dangerous combination**, not a generous inviter reward alone.

Off until somebody sets it, like commission at zero and surge with no bands. And
a live programme with a zero cap, or with both amounts at zero, is refused — it
would advertise a code that can never pay.

### Attribution is a fact, not a field

One `Referral` row per referee, ever, and the three columns saying who invited
whom are immutable — a trigger refuses to change them while still allowing the
reward columns to be filled in. An attribution that could be rewritten would let
a second inviter claim an account after its first order completed, which is the
whole game.

`NOT_A_NEW_CUSTOMER` is the refusal worth naming: an account that has already
ordered cannot be introduced, whatever link they clicked. Without it two existing
customers refer each other and both collect — self-referral with an extra step
and no SIM cards needed.

### A bug in my own helpfulness

`normaliseCode` originally folded confusables onto the alphabet — `0`→`O`→`Q`,
`S`→`5` — reasoning that somebody typing O for Q has misread rather than
mistyped. True, and still wrong: `Q` and `5` are themselves valid code
characters, so the fold could silently turn a typo into **a different real code**
and attribute somebody to a stranger who owns it. The alphabet excludes both
members of each confusable pair precisely so that stripping is safe; guessing on
top of it put the ambiguity back with a worse failure mode. A confusable now
leaves the code the wrong length, which is a dead end the person can see.

### The code has to survive the signup it triggers

A shared link is opened by somebody with no account, and what follows is a
login, an SMS round trip and an onboarding form — three navigations that lose
the query string. The middleware parks the code in an httpOnly cookie and
onboarding claims it. Captured on the login **redirect** too, since the most
likely shared link is a deep one that bounces before any page renders; the
**first** link wins, so a second cannot steal a pending attribution; and
claiming never blocks onboarding, because a stale code is not a reason somebody
cannot finish typing their name.

There is also a plain field for typing a code in, since most sharing is a code
read out or pasted into a group chat, which never touches the cookie.

### Verified in three places

**67 unit tests**: the alphabet excluding both halves of every confusable pair,
the fold bug asserted as a refusal, every attribution and reward refusal named,
the caps counting referrals PAID rather than attributed, the minimum tested
against the order's own worth, the Manila month boundary a cap resets on, and
that no path exists from a referral to a balance field. Four seams were mutated
to confirm the checks fail.

**Eleven SQL-guard checks** against the live database: two programmes, a
self-referral, a double attribution, a rewritten attribution, a payment with no
order, money with no timestamp, a refusal with no reason, a ₱600 reward, and a
live programme with a zero cap — each refusal naming the constraint that fired.
One of those checks passed for the wrong reason on the first run and was fixed:
it used the referee as its own second referrer, so `referral_not_self` fired
before the unique constraint under test was reached.

**Nineteen more against the live database**: attribution granting exactly one
`REFERRAL_BONUS` row, the inviter paid on completion and named against the order
that earned it, a retried completion paying once, a cancelled first order paying
nothing, an order below the minimum refused with its reason while the referee
keeps their own credits, the monthly cap binding on the third, and the balance
still equalling the sum of the ledger after all of it.

**Nineteen in a real browser**: the console showing referrals off, then warning
"at these amounts, referring yourself pays" with the ₱100 figure when set
farmably, then saying self-referral costs money at sensible ones; a code minted
on first opening the invite screen; and the whole shared-link journey — a
stranger opening `/orders?ref=CODE`, bouncing to login with the code parked,
signing in with a real SMS code, typing a name, and landing attributed with ₱50
in their ledger and the cookie cleared, while the inviter's screen shows them
waiting on a first order.

1471 tests pass; typecheck, lint and build clean.

## Phase 38 — Loyalty points

### The question I asked before building anything

This app already grants credits, and credit-back already exists as a Plus
benefit. A points programme could therefore be a second currency doing the
first one's job with extra steps: two balances for a customer to hold in their
head, two liabilities to reconcile, and the wallet's own discipline needing to
hold twice.

Two things made it worth building anyway.

**Credits measure what you can spend; points measure what you have ordered.** A
peso balance cannot say "you are two orders from Tapat", and a status band
cannot be paid out.

**And Plus still cannot be sold**, because a subscription needs a recurring
charge and a bank transfer somebody makes by hand is not one. So today a
customer who orders every week and is not paying earns nothing for it at all.
Points fill exactly that gap and need no payment rail.

### The decision that keeps it from being confusing

**Points are not spendable.** Points buy credits; credits buy food. There is
one balance a customer can spend and it is the one that was already there —
nothing loyalty-shaped appears in `place-order.ts` or `checkout.ts`, which a
test asserts rather than assumes.

### The boundary I held

A tier changes the earn rate and nothing else. The temptation is to make the top
tier waive delivery, and the reason not to is concrete: this app has three ways
to reduce a bill already, each interacting with the others inside
`applyBenefits`, and a fourth would put loyalty arithmetic in the checkout path
where a bug costs somebody the wrong price. A tier that earns faster compounds
the thing the programme is for and touches nothing near a bill.

Tiers come from points earned in a **rolling window** — not the balance, because
redeeming must not demote anybody, and not lifetime, because a tier nobody can
lose is not a reason to order again.

### Earning, and what it excludes

On the **subtotal** only. Never the delivery fee, surge or tip: those are the
rider's money, and rewarding a customer in proportion to what we paid somebody
else is both odd and gameable — a distant address would earn more than a near
one for the same food.

Rounded down. A customer a point short never notices; one given a point they had
not earned makes the balance disagree with the rule that produced it.

### Redemption is the sharpest risk in the app

A referral needs somebody else to sign up and order. A promo needs an
administrator. This needs one tap by the person who benefits — the only place a
**customer** causes credits to come into existence. So: one serializable
transaction, the balance read from the ledger inside it, a non-negative
constraint underneath, the two ledger rows required to name each other by CHECK
constraints, and credits granted only through the wallet's own write function.

A live-database check runs two concurrent redemptions against a balance of
exactly one block and asserts **one winner**.

Whole blocks only, because 37 points that can never be worth a centavo is dust
every loyalty programme accumulates and nobody enjoys — and the console shows
how many accounts are stranded below a block, since a large number there means
the block is too big and the programme is quietly not paying out.

### Expiry, and the netting nobody sees

The one thing credits deliberately never do, and the only mechanism bounding
what this can come to owe — a liability that grows fastest among customers who
have stopped ordering.

Redemptions are not attributed to particular earnings, so a customer who earned
300 in January and 300 in March then redeemed 500 holds 100 — but *which* 100?
It has to be the newest, or prompt redemption is punished by having the
remainder expire on January's clock. Spending consumes the oldest first.

### Three bugs

**The console's tier holder counts were one wrong number repeated.** A query per
tier with a duplicated object key made every query identical, so the column
showed the same figure down its whole length — which reads as data, not as a
bug. Now one `groupBy` bucketed through the same `tierFor` the customer's screen
uses, so the two cannot disagree.

**The earning code guessed at replays from a timestamp.** It compared the row's
`createdAt` against the clock to decide whether the idempotency key had matched,
which is wrong under clock skew and wrong in the direction that double-counts.
The ledger now reports it.

**Redeeming told the customer nothing.** The redeem control rendered only when a
redemption was available; the page showed a "you need 300 more points" line
otherwise. A successful tap dropped the balance below a block, the refresh
replaced the control with that line, and **the success message went with it** —
the points moved, the credits moved, and the screen said nothing at all, which
is indistinguishable from a tap that failed. Found in a browser. One component
now owns both states.

Two fixture mistakes are worth recording too, for the same reason as last
phase: a guard check that fired on `loyalty_entry_redeemed_names_its_credit`
rather than the sign constraint it named, and an expiry check that reported a
defect which was the netting working correctly — the account's earlier
redemptions had already consumed every aged point. Both were the check being
wrong, and both are now split so they test what they claim.

### Verified in three places

**73 unit tests**: earning on the food only and rounded down, the sign derived
from the type so an added redemption is unrepresentable, whole-block redemption
leaving no fraction of a centavo at any rate or block size, tier promotion at
exactly the threshold, the rolling window, oldest-first netting in one place,
and that nothing loyalty-shaped reaches the checkout. Six seams were mutated to
confirm the checks fail.

**Sixteen SQL-guard checks** against the live database: an update, a delete, a
delete with the escape hatch, a negative earning, a positive redemption, points
with no order, a redemption with no credits row, an EARNED row claiming one, an
adjustment with no administrator, an expiry on a redemption, a negative balance,
two programmes, a live programme that can never be redeemed, a hundred points
per peso, and a tier that earns slower than base.

**Twenty-three more against the live database**: a ₱600 order earning 600 points
and not 689, a retried completion earning once, a tier promotion changing the
next order's earning, redemption moving both ledgers by matching amounts with
the rows linked, **two concurrent taps at one block producing exactly one
winner**, expiry taking the oldest first in both directions, and the derived
balance equalling the ledger sum after all of it.

**Twenty-five in a real browser**: the screen saying points are off, a block
that is not a whole number of pesos refused with a sentence and nothing saved,
the giveback stated as 1.00%, the never-expires warning, a ₱1,200 order earning
1,200 points, the balance shown in points *and* pesos, one tap converting
1,000 into ₱10.00 with the confirmation surviving, the credits screen showing
"1000 points redeemed" in its own history, and switching the programme off
leaving the balance untouched.

1544 tests pass; typecheck, lint and build clean.

## Phase 39 — Promo codes

### What makes this different from the other two code features

A referral code belongs to one person and pays credits. A loyalty balance
belongs to one person and converts to credits. **A promo code is public.** It
goes on a tarpaulin, into a Facebook group, and round a group chat, and a code
meant for a hundred people is used by ten thousand within the hour.

So none of the design is about secrecy — a code somebody has to remember and
say out loud is guessable by construction. All of it is about **bounds**: how
many orders it may touch, how much it may cost in total, how much it may take
off one order, and who it applies to. Every one of those is a column, and every
one is checked in a pure module and again in the database.

### Three kinds, one number

`PERCENTAGE`, `FIXED_AMOUNT` and `FREE_DELIVERY` all resolve to a single
centavos figure. `Order.promoDiscountCentavos` and the arithmetic in
`applyBenefits` have existed since the first schema and handle exactly one
number, so nothing about the checkout needs a third case. It also means a
free-delivery code shows the customer a *named discount line* rather than a
delivery fee that mysteriously reads zero.

Until now that column was set on every order and always to 0 — another of the
plumbed-but-never-wired fields this project keeps turning up. This phase is the
first thing that writes it.

### Two classes of refusal, and why the messages differ

A refusal about **this order** — too small, wrong city, not your first — is
stated precisely, because the customer can act on it. "Your order is below the
minimum for that code" is useful.

A refusal about **the code itself** — unknown, expired, exhausted, switched off
— is answered uniformly, as "That code is not available". Not to be unhelpful:
distinguishing them turns the checkout field into an **oracle**. Try a hundred
guesses and the different messages tell you which of them are real codes that
have merely run out. There is nothing a customer can do differently with the
distinction anyway.

### Resolving is free; consuming is not

A quote runs on every price-bearing change at checkout. If resolving consumed a
use, a customer who typed a code and then changed their address would have
burned it — exactly the mistake `commitBenefitUsage` exists to avoid for a
subscription's monthly allowance.

So `promo/resolve.ts` only reads, and `promo/consume.ts` runs **inside
placement's serializable transaction**, re-resolving rather than trusting the
quote. A client that could name its own discount would be a client that could
name its own price. Usage is *counted* from `PromoRedemption` every time, never
read from a cached counter: a cached count is a second truth, and the moment it
drifts a code either stops working early or runs past its budget with nobody
able to say which.

### Three defects worth recording

**A non-stacking code made a subscriber pay MORE for typing it.** The obvious
reading of `stacksWithSubscription: false` is "drop the plan's benefits, keep
the code" — and the schema comment said so in the first draft. Under that rule
a Plus subscriber with free delivery types a ₱20 code, loses a ₱49 waiver, and
pays **₱29 more than if they had typed nothing at all**. Nobody would ever have
explained that to them, because nothing errors: the screen shows a discount
line and a bigger total. `bestOutcome` now prices both bills and keeps the
cheaper one, counting credit-back at face value; when the plan wins the code is
left *unspent*, so their one use and the campaign's budget both survive. A tie
goes to the plan for the same reason. That "valid code, no discount" state is
the fourth thing the checkout field can say, and `promoDisplay` names it so the
screen never shows an accepted code and a silent nothing.

**A popular code serialised checkout for everybody.** Placement is
`Serializable`, and until now it only ever contended *per customer* — their own
credits ledger. Counting a redemption cap across everybody changes that:
four concurrent placements against one code produced **three `P2034` failures
and one order**, while the campaign was nowhere near its cap of two. Each
refused customer read "that did not go through". The contention is not a
mistake to optimise away — it is what makes the cap hold to the centavo, and
counting outside the transaction would go over budget silently instead. So
placement now retries a serialization conflict up to four times with jittered
backoff, re-quoting each attempt. The same four placements now produce two
discounted orders, two full-price ones, and no failures. No unit test can see
this and a browser click never will; it took four placements at once against a
real database.

**A code that ran out between the render and the tap billed full price in
silence.** Placement re-quotes, saw the code exhausted, priced the order at
zero discount, and placed it. The customer read ₱50 off, tapped once, and paid
₱50 more — precisely what `acceptedSurgeCentavos` exists to prevent, arriving
from the other side of the total. There is now an
`acceptedPromoDiscountCentavos` **floor**, the exact mirror of the surge
ceiling and safe in the same way: a client-supplied number never used as a
price, only compared against what placement independently resolved, so a
tampered value can only cause a refusal. A caller with no screen (a script, a
test) omits it and places at full price, which is right — nothing was shown to
anybody.

### The number the console makes impossible to miss

The referrals screen shows what a self-referrer nets. The equivalent here is
two figures:

**What a campaign can still cost.** Not its redemption count — the money still
on the table, bounded by whichever of the budget and the remaining redemptions
is tighter. A code with neither is reported as **Unbounded** rather than as a
large number, and creating one is *refused*: the dates bound how long a
campaign runs, not how much it costs. Put a big number in if that is what you
mean, and it goes in the audit row next to your reason.

**Whether a code makes food free.** A fixed amount at or above the minimum
order means somebody eats for nothing while we pay the shop and the rider in
full. `resolvePromo` already stops the total going below zero, which is why
this is not a correctness bug and is easy to miss: the order goes through, the
arithmetic is right, and the money is gone. A percentage can only do it at
100%, so the usual shape is a minimum somebody forgot to raise. This one is
*warned about* rather than refused — a deliberate acquisition subsidy is a real
choice — and the warning stays on the row, not just on the confirmation.

### Two smaller decisions

**`onDelete: Restrict` on a redemption's code.** The first draft cascaded,
which would let deleting one row erase every record of what a campaign cost
while leaving `promoDiscountCentavos` on each order: a discount with no reason
and a marketing spend with no total. A used code cannot be deleted at all now —
switch it off. That also means the receipt can name the code from the
redemption without a cached label column, the way `surgeLabel` does for surge.

**The promo discount is TARA's cost, not the shop's.** `splitOrderValue`
already subtracted discounts from the platform's net rather than the store's
payout, so a campaign does not quietly bill the restaurants for our marketing.
Asserted rather than assumed, because it is one sign away from being wrong.

### Verified in three places

**81 unit tests**: a percentage off the food and not the rider's fee, floored;
free delivery resolving to whatever the fee is; the amount bounded by the
code's ceiling, the hard ceiling, the remaining budget and the order's own
worth; the four code-level refusals producing one indistinguishable sentence;
each order-level refusal naming its own cause with scope answered before
amount; the resolve/consume split asserted against the source; the
non-stacking comparison including the case where dropping the plan would cost
₱29; and the giveaway detector at 99% versus 100%. Five seams were mutated to
confirm the checks fail — including one that proved `capSurge`-style: removing
the budget clamp, and making `consumePromoCode` record the resolved figure
rather than the applied one.

**Twenty-eight checks against the live database**: six SQL guards each firing
for its own named constraint, five quotes writing no redemption, the cap
holding at exactly two of four *concurrent* placements with no serialization
failure reaching a customer, the budget spent to the centavo, a code that ran
out refusing rather than charging full price, a redemption that cannot be
edited, a used code that cannot be deleted, and the shop paid the same with or
without the code.

**Twenty-eight in a real browser**: an uncapped campaign refused in words with
nothing created, a percentage with no ceiling refused, the free-food warning
stated at creation *and* kept on the row, a lowercase code tidied and applied,
the discount arriving as its own named line, the total falling by exactly ₱50,
a wrong-city code naming the city rather than saying "invalid", an unknown code
answered exactly like an exhausted one, applying and removing codes consuming
nothing, the receipt still naming the code afterwards, and switching a campaign
off leaving its redemptions — and so its cost — on the record.

Two of the browser checks were wrong before they were right, both in the same
way as the ones recorded last phase: one matched `₱450.00` against the whole
page and passed on the `₱3,450.00` in a platform-wide total, and one asserted
`placed + rejected === 4`, which is true of any four settled promises. A check
that cannot fail is worse than no check. A brittle assertion in the surge suite
went the other way — it counted three `normaliseReason` calls in the rest of
the file and broke the day promo codes were appended after the surge actions,
failing for a reason that had nothing to do with either. It now checks each
action's own body.

1631 tests pass; typecheck, lint and build clean.

## Phase 40 — Gift cards

### The half of "gift cards" that this app can have, and the half it cannot

The request runs straight into the credits constraints, so it is worth
separating two different products that share a name.

**A card a customer buys** is a top-up and a transfer in one feature: their
cash becomes a balance, and then that balance ends up with somebody else. Both
are named in the `DELIBERATELY ABSENT — do not add these` block at the foot of
`wallet/ledger.ts`, with a test asserting the functions do not exist, and they
are the whole reason this product says *credits* rather than *wallet*. Selling
stored value is also the version that needs a licence rather than a schema.
There is no payment rail for it either — the only prepaid path is a manual
transfer somebody confirms by hand — so "customers buy gift cards" would be a
human process with a database behind it.

**A card TARA issues** is a grant with a bearer token. We decide the money and
record the liability; whoever holds the string collects credits that still
cannot be topped up, transferred or cashed out. That is what got built, and it
is the useful half: support goodwill for somebody who has not signed in yet, a
printed card for a launch event, a partner giveaway. Until now the only way to
give credits to a person was `recordAdjustment`, which needs their account.

`sellGiftCard()` is now named in that same do-not-add block, because "let
customers buy gift cards" is the shape the request actually arrives in.

### A bearer instrument inverts every promo-code defence

A promo code is **public**: it goes on a tarpaulin, its defence is the caps,
and secrecy is pointless because a code people say aloud is guessable by
construction. A gift card is the opposite on every axis:

| | Promo code | Gift card |
| --- | --- | --- |
| Defence | Caps on how much it can cost | Entropy, and a hash at rest |
| Code | Chosen by marketing, memorable | 16 chars of CSPRNG, ~78 bits |
| Stored | In plaintext — it is public | SHA-256 only; shown once, ever |
| Refusals | All answered identically | Each says which |

That last row is the interesting one. The promo field answers "unknown",
"expired" and "exhausted" the same way because distinguishing them turns it
into an **oracle** for finding real codes. Here there is no oracle to protect —
you cannot find a 78-bit code by guessing — and the person typing it is holding
a physical card. They need to know whether somebody at home already used it,
whether it lapsed, or whether they misread a letter. So each refusal is
specific, and the reasoning for the difference is written next to both.

### Why SHA-256 and not the OTP's keyed HMAC

The OTP is six digits — a million possibilities — so an unkeyed hash in a
leaked database is a rainbow table away from plaintext, and the key is what
stands between them. A gift card has no dictionary to attack.

More importantly, an HMAC would make `AUTH_SECRET` load-bearing for money.
Rotating that secret is a routine security action, and it would silently void
every card in circulation: a drawer of printed cards that stop working, and
money owed to people who cannot prove it. Same reasoning as
`hashSessionToken`, which is the same shape of value.

### Three things that make double redemption impossible

1. **A compare-and-set**, not a read-then-write: `UPDATE … WHERE "redeemedAt"
   IS NULL`, with the affected row count checked. Atomic at any isolation
   level, so it holds even for a future caller who forgets to use a
   transaction.
2. **The idempotency key** `gift-card:<id>` on the grant, which is unique in
   the database — an independent second barrier, so two transactions that
   somehow both got past the compare-and-set collide there instead.
3. **The database refusing to rewrite an outcome.** Once `redeemedAt` is set,
   a trigger refuses any change to it or to its ledger reference. So does
   `voidedAt`, because un-voiding a card would put a cancelled instrument back
   into circulation. `codeHash` and `amountCentavos` are immutable outright: a
   card whose value can be edited after printing is not a gift card, it is a
   suggestion.

The ledger row is written *first*, inside the same transaction, because
`gift_card_redemption_is_complete` requires `redeemedAt` and
`walletTransactionId` to be set together and a Postgres CHECK cannot be
deferred. If the compare-and-set then loses, the credits roll back with it.
Six people redeeming one code at once produce one credit and five
"already added to an account".

### The defect the live-database run caught

`normaliseGiftCode` first stripped **every character outside the alphabet**,
which sounds like a superset of stripping formatting and is a different,
dangerous function — because English prose is made of alphabet characters:

```
"Code: PB7A-ENJ3-37R2-E9MZ"           ->  CDEPB7AENJ337R2E
"Your gift card: PB7A-ENJ3-37R2-E9MZ" ->  YURGFTCARDPB7AEN
```

Both are well-formed sixteen-character codes that are **not the code the
person is holding** — and with enough cards issued, one of them eventually is
somebody else's. That is the referral bug in a new dress: its first version
folded confusable characters onto each other, so a typo could resolve to a
different real code and attribute somebody to a stranger. Here it would redeem
a stranger's money.

It now strips only formatting — the hyphens we printed, the spaces they typed
instead, a trailing newline, an em dash a word processor autocorrected — and
refuses anything else. It also no longer truncates to sixteen characters,
because cutting a longer string down is the same guess by another route.
"That does not look like a code" feels worse than finding sixteen letters in a
sentence and is far better.

### Two smaller decisions worth recording

**No rate limiter, stated rather than hidden.** The defence against guessing is
the ~78 bits, not a throttle: at a million attempts a second, expecting one hit
takes longer than the age of the universe. A malformed code is refused with no
database work at all, and a well-formed wrong one costs a single index seek on
a unique hash. A bespoke throttle table here would protect the server from load
rather than the cards from theft, and would buy a false sense of security. When
this app gets general rate limiting, this endpoint should use it.

**No refusal for a frozen balance.** The first draft of the refusal union had
one, and it would have been a branch that can never be taken — the ledger
blocks freezes against debits only, on the stated grounds that a refund into a
frozen balance must still land. It is also the right behaviour: if a card could
be refused, an account-takeover victim's cardholder would burn an attempt for
nothing, whereas a card that lands in a held balance is recovered along with
the account. A check that cannot fail was removed rather than shipped.

### The number the console makes impossible to miss

**Outstanding**: the face value of every card printed and not yet redeemed.
Every other way this app gives credits away needs the recipient to do something
first — a promo code needs an order at checkout, a referral needs a signup and
a delivery, an adjustment needs an account to name. A gift card needs nothing
but the string, so its face value is money sitting on paper we no longer
control, and unlike a promo campaign there is no aggregate switch: cards are
cancelled one at a time, and only while unredeemed.

The total comes from a query rather than from the page of rows on screen, which
is capped at 200 — a liability computed from a truncated list would quietly
understate itself the day somebody issues the 201st card.

The expiry field defaults to never and carries the law next to it: **RA 10962,
the Gift Check Act**, says gift checks sold in the Philippines may not expire.
A card given away for nothing is arguably not one that was sold, but that is a
question for a lawyer and not for a form, so the default is the safe direction.

### Also in this phase

The serialization retry that order placement gained last phase now lives in
`db/serializable.ts` and is used by both callers. That also means it is tested
for **behaviour** — it retries a P2034, never retries a decision, and gives up
after four attempts — rather than by grepping `place-order.ts` for a constant,
which is what the promo tests were reduced to doing and which broke the moment
the code moved.

### Verified in three places

**62 unit tests**: the frozen alphabet asserted character for character, both
halves of every confusable pair excluded, the keyspace arithmetic, 200 codes
generated without a repeat, the hash stable across six ways a human types the
same code and independent of `AUTH_SECRET`, prose refused rather than mined,
a longer string not truncated into a plausible code, the four states with
REDEEMED beating a passed expiry, each refusal getting its own distinct
sentence, and the retry helper's three behaviours. Six seams were mutated to
confirm the checks fail — including the exact normalisation defect above.

**Sixteen SQL-guard checks** against the live database, each firing for its own
named constraint: a redemption half-written in either direction, a void with no
reason, a zero and an over-ceiling face value, a blank reason, a code that was
never hashed, an expiry before the issue, the face value and the code hash
edited after printing, a redemption rewritten, a void undone, and redeemed and
void in both orders — plus the escape hatch still allowing a lawful purge.

**Twenty-five more against the live database**: every text column in the table
scanned for the plaintext code, a code round-tripping through lowercase and
spaces, **six concurrent redemptions producing exactly one credit**, the
derived balance equalling the ledger sum afterwards, expiry tested at its edge
in both directions, and the outstanding figure matching between the pure rule
and the query the console runs.

**Thirty-four in a real browser**: the console refusing an over-ceiling card,
the code appearing once with "COPY IT NOW", the code absent from the list
screen and from the audit log, a customer typing it in lowercase with spaces,
the confirmation surviving the refresh that moved the balance, the history
naming the reference rather than the code, a second attempt refused with the
reason, the outstanding total clearing, a redeemed card offering no cancel
button at all, and a cancelled card refusing by name.

One piece of polish came out of reading the screenshots: the credits history
rendered "Gift card / Gift card GC-5686JY", because both screens that show a
description also show the transaction type. The description is now the bare
reference.

1699 tests pass; typecheck, lint and build clean.

---

## Phase 41 — Selling TARA Plus

### The thing that had been plumbed and never wired

Plus was built in Phase 9: a plan, structured benefits, month-to-date usage,
and a pricing engine that honours all of it. It had never sold a single
subscription, and `/plus` said so — *"Sign-up is not open yet… we have no way
to collect a monthly fee."* That sentence was true and correct, and it had been
true for thirty phases.

The blocker was never the schema. Credits cannot pay for a plan — they are
rewards, spendable on orders only, enforced in the ledger, in SQL and in tests
— and cash on delivery cannot bill ₱99 a month. The old seam,
`resolveSubscriptionCharger()`, existed to refuse loudly rather than fake a
charge, and that was the right instinct: a stub that records a charge nobody
made is the failure mode of an SMS "sender" that prints to a console.

What was missing was not a gateway. It was noticing that a **transfer somebody
confirms by hand** is a payment rail — the app has had one for orders since
Phase 32, using the same GCash account — and that the honest cost of using it
for subscriptions is one person, per subscriber, per month.

### Invoices first, rails second

The old seam took `charge({ userId, amountCentavos, description })`. Wiring any
provider to that signature would have hit two holes immediately: a retried
webhook or a re-run cron would charge the same month twice, and nothing tied a
charge to the period it paid for, so a customer asking "what was this ₱99 for"
had no answer and a reconciliation could not tell one month's ₱99 from
another's.

So `SubscriptionInvoice` came first: a named month, the price **copied** at
issue and immutable afterwards, unique on `(subscriptionId, periodStart)`, with
its five states derived from timestamps rather than stored. Then the rail was
reshaped around it — `request()` for the arm that asks a customer to pay,
`collect({ invoice, mandate, idempotencyKey })` for the arm that charges a
stored instrument, and `PaymentMandate` named even with no implementation,
because a revocable expiring token is the thing that makes billing *recurring*
and its absence was what made the old seam unable to describe its own job.

Both arms settle the same invoice. Nothing downstream knows which one collected.

### Bill before the boundary, not on it

The decision that removed the hardest problem. A bill goes out seven days
BEFORE the period it pays for.

Bill on the boundary and you must decide what happens while the payment is in
flight, and every answer is bad: stop the benefits instantly and somebody whose
transfer is an hour behind loses their free delivery; keep them on through a
"grace period" and you are giving away the product on an unpaid month, which
this codebase is careful never to do. Billing ahead means the customer pays
while still inside the month they already paid for. There is no window to have
an opinion about.

What survives of the grace is a different and much smaller promise:
`RECOVERY_DAYS` (5) is how long a lapsed subscription can still be **revived**
by paying — not how long it keeps working.

That also exposed a comment that had been wrong for thirty phases. The old
PAST_DUE grace claimed it existed "so a card that fails on a Friday has the
weekend to be fixed before benefits stop". It never did: a PAST_DUE row has a
`renewsAt` in the past, so the pricing engine refused it on both counts. The
path had never run, because PAID enrolment was refused for want of a gateway.

### Signing up and paying are two different acts

`subscribeAction` does not make anybody a subscriber. It creates a
PENDING_PAYMENT enrolment and raises the first bill, and PENDING_PAYMENT
confers **nothing** — `BENEFIT_CONFERRING_STATUSES` is `[ACTIVE]` while
`LIVE_SUBSCRIPTION_STATUSES` has three entries, and the gap between those two
lists is the whole content of the paid rail. A unit test asserts the gap is
never empty, because collapsing them would either give away unpaid months or
hide an unpaid signup from the billing sweep.

So the screen says "Waiting for payment" rather than "Active", and the benefit
list says none of it is on yet. The alternative is somebody arriving at
checkout expecting free delivery and finding out from the total.

### The sentence the screen has to say

> **This is a transfer you make each month, not a card on file.** We cannot
> charge you and we do not hold anything to charge.

Every subscription anybody has ever held works the other way round: authorise
once, forget. A customer who assumes that here will lose their benefits on a
month they believed was covered, and they will be right to be annoyed, because
nothing told them otherwise. Saying it plainly costs some sign-ups. It costs
fewer than a lapse nobody saw coming.

### The console number that decides when to stop using this rail

`/admin/subscriptions` leads with **what is billed against what has actually
arrived**. Every subscription dashboard ever built shows the first number; on a
rail where the customer must remember and a person must confirm, the first
number is a ceiling and the gap between the two is the collection rate. MRR
alone would report a healthy subscription business while nobody paid, and it
would keep doing so for months, because a lapse looks exactly like a customer
who has not got round to it yet.

The third number is `Confirmations this month`: how many times somebody has to
look at a statement and click. It scales with subscribers and nothing else.
Twenty is a coffee's worth of attention; four hundred is a job, and at that
point a provider's per-transaction fee is cheaper than the person. A signal
nobody can see is not a signal.

### Four things found by building the screens

**A cancelled plan left its bill behind.** `cancelSubscription()` set the status
and nothing else, so the customer kept being asked for a month they no longer
had — and confirming a late transfer would have flipped the row back to ACTIVE.
A CANCELLED row is not in `LIVE_SUBSCRIPTION_STATUSES`, so the sweep never
revisits it: cancelling now voids any unpaid bill in the same transaction.

**The first payment bought a month and two days.** `nextRenewsAt` extends from
the later of the current renewal date and the payment, which is right for a
renewal and wrong for a first payment, where "current renewal date" is the
48-hour payment *deadline* and not a boundary anybody bought. Somebody who paid
within the hour got a month plus two days; somebody who paid at the deadline got
a month. Worse, it contradicted the row: settlement sets `startedAt` to the
moment the money arrived. Found by the live-database script asserting "a month
from the payment" and getting a month and two days.

**A settled bill could have no reference.** The all-or-nothing settlement guard
paired `settledAt` with `settledVia` and said nothing about
`settledReference` — so the database accepted a confirmed month with nothing to
point at, which cannot be reconciled against a statement. Reconciliation is the
only evidence this rail leaves. The guard now demands it, and `settleInvoice()`
refuses a blank one with a sentence rather than a constraint violation.

**The console spoke to the operator in the customer's voice.** The status pill
read *"We are checking your transfer"* to the person whose job was to do the
checking. There are now two wordings per state, both compile-enforced over the
same union, and a test that refuses "your" or "we" in the console half.

### Verified in four places

**Fourteen new unit tests** (1736 total): the three live statuses and the one
that confers, with an assertion that the gap between them is never empty; the
first payment running from the payment and not the deadline, and paying early
buying no extra days; the renewal rule unchanged by that flag; both state
wordings covering the same five states, the console half never addressing the
customer, and "Paid" staying "Paid" in both; and the Manila date label rolling
to the next day at 17:00 UTC. Two seams were mutated to confirm the new checks
fail — the console wording and the timezone.

**Twenty-one SQL-guard checks** against the live database, each naming its own
constraint. The harness needed a third iteration of the same discipline: a
unique-index violation arrives as `Key ("userId")=(…) already exists` with no
index name attached, so the statement is now wrapped in a plpgsql block that
reads `CONSTRAINT_NAME` out of `GET STACKED DIAGNOSTICS`. Every guard is
exercised with a control row that differs in exactly one field and must insert
— without that half, a guard exercise proves only that *something* refused
*something*. The block also always raises, so a bad row is never committed.

**Thirty-two more against the live database**: a full enrol → bill → pay →
renew cycle, three sweeps inside one lead window raising exactly one renewal,
four concurrent confirmations settling once and moving the term by one month
rather than four, an unpaid first period expiring with its bill voided and a
late transfer unable to resurrect it, the plan price rising without changing
what somebody already owes, and the pricing engine itself — not a constant —
refusing benefits to PENDING_PAYMENT and PAST_DUE while granting them to
ACTIVE.

**Forty-five in a real browser**: subscribing, then reading what is owed, where
to send it and by when; the reference submitted and the panel changing to
"checking"; the console showing both references separately, MRR at ₱0.00 while
the enrolment is unpaid and ₱99.00 after; a refusal reaching the customer in the
refuser's own words without cancelling the bill; a corrected reference; the
confirmation switching the benefits on and the counter moving to 1/1; and
cancelling taking the unpaid renewal bill with it while leaving the paid one
paid.

One check was rewritten for reporting a bare `true` — after a confirmation the
row leaves the queue, so there is no second Confirm button to double-tap, and
saying "ok, nothing to tap" is a check that cannot fail. It now asserts the
queue is empty, which is the reason there is nothing to tap.

1736 tests pass; typecheck, lint and build clean.

---

## Phase 42 — Rider invites: referrals paid in money

### What "referral payouts" could mean, and which one this is

Two readings, and one of them is already built. The customer programme from
Phase 37 pays both sides in credits and has done since; a customer referral
cannot be "paid out" at all, because credits becoming cash is exactly the
cash-out the wallet design refuses.

The other reading is the one with work in it: **paying a rider real money for
bringing another rider.** Nothing in the app did that, and credits could not —
a rider does not order lunch from us, so a supply referral paid in credits is
somebody paid in a currency they cannot spend. That looks like a reward and is
not one.

### The rail already existed

The settlement ledger has moved money to partners since Phase 33: one write
function, a signed amount forced by type, a payout that cannot exceed the
balance, and a person's name against every claim that money left a bank
account. A rider referral needed nothing new from it except a REASON for money
to be owed.

So `REFERRAL_BONUS` is a new `SettlementEntryType` and that is the whole
mechanism. The bonus increases what TARA owes the rider; it leaves in the
payout somebody records on a Friday, through the same form and the same
ceiling as the fees they earn riding. **No second payment path, and no new way
to move money.**

Which is also why every sentence about it says *owed* rather than *paid*.
Telling a rider "₱500 paid" when nothing has left a bank account is a lie with
a number on it, and `PARTNER_REFERRAL_SETTLED` exists as its own notification
kind because the customer version says "credits" — a lie about the currency to
somebody who never orders food.

### One code, two programmes

Both resolve `User.referralCode`. A person has one code to share, and what it
earns depends on what the invitee does: order, and it is credits; apply to
ride, and it is money. A customer's code used by a rider applicant is refused
with `NOT_A_RIDER_CODE` — a real thing, a different feature, and there is no
settlement account to accrue to.

`PartnerReferral` is nonetheless a separate TABLE rather than a flag, because
`Referral.refereeId` is unique per user: somebody first invited to order by a
friend and later invited to ride by a rider is the ordinary case, and one table
could not hold both.

### The defence is the work, so the console shows a different number

The customer screen's headline figure is what a person nets by referring
themselves. There is no equivalent here. To collect a rider bonus from
yourself you would have to register a second rider account, pass verification
again — a person looks at documents, per service — and then complete the
qualifying deliveries, each of which already paid that account its fee. At the
end of it you have delivered food and been paid for delivering food. That is
not a farm; it is a second job with a hiring bonus, and the bonus is what it
was for.

So `/admin/referrals` says so out loud and shows **what a rider costs per
qualifying delivery** instead — the number that can be quietly wrong for
months, next to what a delivery earns the business. The caps remain, bounding
the liability per referrer.

### The caps refuse the inviter, not the rider who did the work

A new rider told "₱250 after twenty deliveries", who then delivers twenty
times, is paid — even if their inviter's monthly cap is spent, even if their
inviter has been suspended. A promise broken by somebody else's cap is one the
person who kept their end can do nothing about, cannot see, and cannot
explain. `rewardForPartnerReferral` decides the two sides separately, and a
REWARDED row can carry a `blockedReason` for the half that was refused.

### Five defects, four of them in code that already shipped

**A bonus race failed a rider's delivery.** Two of a rider's deliveries
completing at the same moment both read the referral as ATTRIBUTED and both
settled it. The immutability trigger refused the second write, correctly — and
the exception came out of the referral code, out of the completion
transaction, and failed the whole ORDER. A race about a bonus must never cost
somebody their delivery. The settle is now a compare-and-set on the status;
the loser matches no row and returns quietly, and the trigger is a backstop
again rather than the thing breaking completions. Found by the live-database
script.

**An erasure request would have failed, and had done since Phase 37.** Both
referral tables point at the order that paid them with `onDelete: SetNull`, and
both have a CHECK requiring a REWARDED row to name that order. Those two facts
contradict each other exactly where it matters: deleting a purged customer's
orders nulls the column, and the CHECK forbids it. `db:purge-user` therefore
failed with a constraint violation for anybody who had ever been referred and
whose first order paid their referrer — the successful case of the feature.
Both purge tools now delete the referral rows first, which is also the right
answer on the merits: a referral row is personal data about two people, so
erasing one of them takes the link with it, and what the money did survives in
the two ledgers.

**Two form fields had no `name`.** The rider application's plate field, and the
invite-code field added in this phase. They worked for a human — controlled
React state posted through a server action — and were invisible to autofill,
to accessibility tooling and to a browser test looking for them.

**A stray relation, again.** `Referral.fleetPartnerId` and
`LoyaltyEntry.fleetPartnerId`, both auto-generated by `prisma format` from
back-relations somebody added to `FleetPartner`, both written by nothing and
read by nothing. Dropped, with a note. The first version of this phase's
schema would have made a third.

**A browser script that could not fail.** `try/finally` with no `catch` and a
`process.exit` in the finally swallows every exception: the run stops wherever
it threw, prints "all checks passed" for the checks it reached, and exits 0.
Four of eight phases were being skipped silently. That shape was copied from
an earlier e2e script, where every phase happened to run.

I also moved `FleetPartner.completedOrderCount` into the completion
transaction. It was incremented one line and one transaction later, so a
process dying in between left a delivery the count never saw — and I had
briefly, wrongly, told myself nothing maintained it at all, before reading the
call site properly.

### Verified in four places

**Thirty-five new unit tests** (1778 total): every attribution refusal, the
unknown-code versus customer-code distinction, the threshold at its boundary
in both directions, both caps refusing the inviter while the new rider is
still paid, blocked and suspended doing the same, the per-delivery cost
rounding up, no divide-by-zero on a programme with no threshold, the ceiling
agreeing with the SQL guard, and the notification saying "owed" and never
"credits" — asserted against the exported values rather than by regexing
source, which is where the first two attempts broke. Three seams were mutated
to confirm the checks fail.

**Eighteen SQL-guard checks** against the live database, each naming its own
constraint through `GET STACKED DIAGNOSTICS`, every one paired with a control
row that differs in exactly one field. Including the two the guards must NOT
demand of a bonus — an actor and an order — because demanding either would
fail every bonus, and the new guard that refuses a bonus which names one.

**Twenty-five more against the live database**: attribution refusing a
self-code, a customer's code and a second code against real rows; the bonus
paid on the second delivery and not the first, counted from real completions;
the ledger line positive, actor-less and order-less; the balance rising and
then paying out to zero through the ordinary payout; two simultaneous
completions of the qualifying delivery both landing and paying once; the cap
refusing the inviter while the new rider is paid; and the console's accrued
total matching the ledger rather than the referral rows.

**Twenty-seven in a real browser**: the rider screen and the application form
with the programme off, the console refusing a live programme that pays on
signup, switching it on and reporting the cost per delivery, the rider reading
her code with "money, not credits" on it, a bad code not costing an applicant
their form, a real code attributing however it is typed, the count coming down
by name, the bonus arriving as owed rather than paid, the Money tab separating
invite bonuses from what was earned riding, the new rider told about her own
welcome bonus, and the console listing who brought whom for what.

1778 tests pass; typecheck, lint and build clean.
