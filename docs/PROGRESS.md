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
| 8 | Fleet partner app | ⬜ Next |
| 9 | Subscription launch decision | ⬜ Gated on data |
| 10 | Second vertical | ⬜ Gated on demand |

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
  a data edit. Group names are Filipino-market: *Pagkain at Grocery*, *Padala at
  Pabili*, *Sakay*, *Bayad*.
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

- `prisma/schema.prisma`: 27 models, 17 enums.
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

## Phase 8 — Fleet partner app ⬜ Next

Orders now reach `AWAITING_RIDER_ASSIGNMENT` and wait there for twenty minutes
before the sweep cancels them. Nothing can accept a dispatch offer yet, so this
is the new binding constraint.

- Onboarding that submits per-service verification documents, feeding
  `FleetPartnerServiceVerification` and `syncEnabledServices()`.
- Offer and accept, using `findDispatchCandidates()`. `RIDER_ASSIGNED` already
  permits `FLEET_PARTNER`, which is what `acceptanceRate` measures.
- Status updates through the state machine as `OrderActor.FLEET_PARTNER`:
  at-pickup, picked up, in transit, delivered.
- Location updates feeding the candidate query's bounding box.
- Earnings, from the order fee breakdown.

A partner may hold approvals for several verticals and should see the union of
what they are approved for — never a food-shaped UI with the others bolted on.

## Phase 9 — Subscription launch decision ⬜ Gated

The plan is seeded and inactive. Before flipping `isActive`, decide from data:

- Would free delivery over ₱299 (8×/month) pay for itself at current fees?
- Is the 2% credit-back ceiling of ₱200/month the right exposure?
- Does ₱99/month clear the average monthly delivery-fee spend of the customers
  most likely to subscribe?

Flipping `isActive` is the entire launch mechanism — the pricing engine picks it
up with no deploy. Which also means it should not be flipped casually.

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

---

## Known gaps

- **No fleet UI — the binding constraint now.** A merchant can cook an order,
  but nothing can accept the dispatch offer, so it waits at
  `AWAITING_RIDER_ASSIGNMENT` until the sweep cancels it. Phase 8.
- **No merchant notifications.** The queue polls every 20 seconds while open;
  a merchant who closes the tab learns nothing about a new order.
- **Store membership is seeded, not managed.** There is no UI to invite staff or
  change a role — `StoreMember` rows are written by the seed or by hand.
- **The Semaphore SMS adapter is unverified against the live API.** Written from
  its documented request shape and exercised only against a stub; this codebase
  has no gateway account. Send one real message before trusting it.
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
