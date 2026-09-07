# Architecture

Deliveryapp is a multi-service delivery app for the Philippine market. It runs
five verticals — **Food**, **Mart**, **Parcel**, **Errands**, and **Rides** — as
one product rather than five apps sharing
a login.

Only Food is live. The other four exist in the database as coming-soon records
so the home screen can show them, which measures demand before any of them costs
engineering time.

> **Status note.** This document was written alongside the initial commit. The
> brief it implements described itself as superseding "Phase 4 onward" of an
> existing plan and asked for the changes to be folded into the schema "before
> Phase 2 runs". No prior plan, schema, or docs existed in this repository —
> it had zero commits — so rather than amend a Phase 4, the decisions below are
> the foundation, and they are in the *initial* migration rather than a
> follow-up. See [PROGRESS.md](./PROGRESS.md) for how the phases are numbered
> now.

## Stack

| Concern | Choice |
| --- | --- |
| Database | PostgreSQL |
| Schema & access | Prisma (`prisma/schema.prisma` is the source of truth) |
| App | Next.js App Router, React server components, TypeScript |
| Styling | Tailwind |
| Tests | Vitest (`src/tests/`), database-free |
| Auth | Phone + one-time code over SMS; opaque server-side sessions |
| Jobs | `npm run jobs:orders` — order timeouts plus auth housekeeping, for cron |
| Money | Integer **centavos**, never floats |

The web app and the schema live in one repository because every screen here is a
thin read over the domain layer in `src/lib`. If a React Native client arrives
later, `src/lib` is the part that moves with it — nothing in it imports React
except the request-level `cache()` in the registry.

---

## 1. Service registry — a vertical is data, not a branch

Each vertical is a row in `Service` (`prisma/schema.prisma`), keyed by
`ServiceKey`:

| Column | Purpose |
| --- | --- |
| `key` | `FOOD` \| `MART` \| `PARCEL` \| `PABILI` \| `RIDE` |
| `displayName`, `tagline`, `icon`, `description` | Presentation |
| `intentGroup` | `GO` \| `EAT` \| `GET` \| `PAY` — home-screen grouping |
| `isActive` | Tappable and orderable now |
| `isComingSoon` | Rendered dimmed with a "Coming soon" label, not tappable |
| `sortOrder` | Order within its group |
| `fulfilmentType` | `MERCHANT_TO_DOOR` \| `SHOPPER_TO_DOOR` \| `POINT_TO_POINT` \| `PASSENGER` |
| `requiresMerchant` | Orders must reference a `Store` |
| `requiresRider` | Orders must be assigned a `FleetPartner` |
| `availableCityIds` | Where the service is live |
| `accentToken` | Resolves to a colour pair at render time |

Seeded state: five rows, `FOOD` active in Manila, Quezon City and Makati; the
other four `isComingSoon` with no cities.

### The rule

> Nowhere in the codebase should there be a hardcoded list of services, or an
> `if (serviceType === 'FOOD')` branch in shared logic. Read from the registry.

This is enforced three ways, not just documented:

1. **`src/lib/services/registry.ts`** is the only reader. Everything else —
   home screen, search, help, dispatch, pricing — goes through it.
2. **`src/tests/no-service-branches.test.ts`** greps the whole tree for
   `=== 'FOOD'`-shaped comparisons and for files naming three or more service
   keys, and fails the build on either.
3. **ESLint** (`no-restricted-syntax` in `.eslintrc.json`) rejects a comparison
   against a service-key literal at edit time, before the tests run.

Where behaviour genuinely differs per vertical, it goes in a **config map keyed
by every `ServiceKey`** — so a sixth vertical is a TypeScript compile error in
the map, not a surprise in production. There are exactly two such maps
(`ORDER_LIFECYCLES`, `ORDER_DETAILS_SPECS`), and both are exempted by name in
the test above. `prisma/seed.ts` is the one other exemption: the seed *is* the
data.

Intent-group labels live in `src/lib/services/intent-groups.ts`. That file names
the groups and contains **no service keys** — membership comes from
`Service.intentGroup`, so regrouping the home screen is a data edit. The labels
name what somebody is trying to do rather than the internal taxonomy: *Food &
grocery*, *Send & buy*, *Rides*, *Pay*. They were Filipino (*Pagkain at
Grocery*, *Padala at Pabili*) until the product decided the interface should be
English — and that change touched `intent-groups.ts` and five `displayName`
rows in the seed, nothing else. Which is the point of keeping names in data.

---

## 2. Unified order model — one table for every vertical

`Order` is the base record for all five verticals.

**Shared columns**, present for every service: `id`, `orderNumber`,
`serviceType` (FK to `Service.key`), `customerId`, `status`, the fee breakdown
in centavos, `paymentMethod`, `paymentStatus`, `assignedRiderId`, timestamps,
`cancellationReason` and `cancelledBy`.

Fulfilment addresses are two `OrderAddress` rows per order — one `PICKUP`, one
`DROPOFF`, unique on `(orderId, role)`. Each is a **full snapshot** taken at
placement, deliberately denormalised: an order must stay readable years later
even if the source address is edited or deleted. Every vertical has both — food
picks up at a store, a parcel at the sender, a ride collects a passenger.

The fee breakdown keeps `subscriptionDiscountCentavos` separate from
`promoDiscountCentavos` so we can measure what the subscription tier actually
costs us, and `walletCreditAppliedCentavos` separate again so credits spending
reconciles against the ledger.

### The `details` container

Vertical-specific fields live in `Order.details` (JSON), validated per service
key by `parseOrderDetails()` in `src/lib/orders/details.ts`.

| Service | Shape | Status |
| --- | --- | --- |
| `FOOD` | `storeId`, embedded item snapshots, `merchantPreparationMinutes` | **Implemented** (Zod schema) |
| `MART` | `storeId`, item snapshots, `substitutionPreference` | Planned |
| `PARCEL` | `packageDescription`, `declaredValueCentavos`, `sizeCategory`, `recipientName`, `recipientPhone` | Planned |
| `PABILI` | `shoppingListText`, `estimatedBudgetCentavos`, `budgetCeilingCentavos`, `actualReceiptCentavos` | Planned |
| `RIDE` | `passengerCount`, `vehicleClass`, `routePolyline` | Planned |

Only `FOOD` is implemented. The other four are written down as TypeScript
interfaces so the container's design is reviewable today, and
`parseOrderDetails` throws `ServiceDetailsNotImplementedError` for them — a
loud failure rather than silent acceptance of an undesigned payload.

Food item snapshots record `unitPriceCentavos` and `lineTotalCentavos` at order
time. A merchant raising a price must not rewrite last month's receipt.

`summariseDetails()` produces a one-line summary for the order history and the
active-order strip **without** branching on the vertical, which is why a parcel
in progress will render in those lists the day PARCEL launches.

### Placement

`placeOrder()` in `src/lib/orders/place-order.ts` creates an order. One rule
governs it:

> **Prices are re-read from the database, never taken from the client.**

A request says "two of menu item X"; it does not get to say what X costs.
Everything a client sends is an identifier, a quantity, or a note.
`quoteCheckout()` resolves the cart against the live catalogue, prices it, and
`placeOrder()` calls that same function again to get the number it charges — so
the total displayed at checkout is the total charged by construction rather
than by careful maintenance. The rejections are tested: an unknown item, an
item belonging to a different store, quantity zero or 99999, and an address
belonging to someone else.

Placement is ONE `Serializable` transaction covering:

1. `Order` row plus both `OrderAddress` snapshots,
2. `submitOrder()` — the state machine decides where a FOOD order goes next,
   so placement names no status,
3. `commitBenefitUsage()` — subscription allowances consumed,
4. `spendOnOrder()` — credits debited through the ledger,
5. `bumpAddressUsage()`.

Serializable because step 4 touches the ledger, and the ledger's correctness
depends on nobody reading a stale balance. The failure mode this buys off is
credits taken with no order, or an order whose benefit usage was never
recorded. The ledger write is keyed `order-payment:<id>`, so a retried
placement cannot double-charge.

Order numbers (`DA-20260906-K3M9Q`) come from `src/lib/reference-numbers.ts`:
a date plus five random characters from an alphabet with no I, L, O, U, 0 or 1.
Deliberately **not** `count() + 1` — two orders placed in the same millisecond
would read the same count and the unique constraint would then fail one of them
at random, losing an order for cosmetic tidiness. The same generator now backs
support ticket numbers, which had that flaw.

### Delivery pricing

Rates live in `DeliveryFeeRule`, keyed by `(serviceType, cityId)`. A row with a
null `cityId` is the service's fallback; a city-specific row always wins.
`src/lib/pricing/delivery-fee.ts` contains **no numbers of its own** — tuning a
fee is a database edit, not a deploy, which matters for a rate ops will want to
change weekly.

Each rule carries a base fee, an included distance, a per-kilometre rate
charged **pro rata** (a 2.1km trip must not cost what a 3km trip costs), a
floor and ceiling, a small-order threshold, a flat service fee, and an
everybody-gets-it free-delivery threshold — distinct from the subscription
`FREE_DELIVERY` benefit, which is per-subscriber.

A city with no rule for a service cannot be quoted at all: `quoteDeliveryFee()`
throws rather than silently applying a Manila rate in Cebu.

Postgres treats NULLs as distinct, so `@@unique([serviceType, cityId])` would
not stop two fallback rows for one service — and two fallbacks make which rate
applies a coin flip. A partial unique index in
`prisma/sql/delivery_fee_rules.sql` closes that; Prisma's schema language
cannot express one.

### Timeouts

Each `ServiceLifecycle` declares `timeouts`: states an order must not occupy
forever, how long it may, and where it goes. FOOD gives a merchant 8 minutes to
answer and dispatch 20 minutes to find a partner; PABILI adds a 10-minute
budget-approval gate, because a partner cannot stand in a shop indefinitely
waiting for a reply.

`expireStaleOrders()` reads the flattened `ALL_STATUS_TIMEOUTS` and does not
know that FOOD waits on a merchant or that PABILI waits on a customer — those
are entries in the map. It moves each order in its own transaction, so one
failure does not block the sweep, and refunds any credits the order consumed.
An order the merchant accepted just in time fails the transition guard and is
skipped, which is the guard working.

Tests assert that every timeout is a **legal transition** for its vertical and
passes `assertTransition` as SYSTEM — otherwise the failure would surface at 3am
in a cron job rather than in CI.

### Completion and refunds

`completeOrder()` moves a delivered order to `COMPLETED` and grants any
`CREDIT_BACK_PERCENT` its benefits accrued, through the ledger, keyed
`credit-back:<id>`. Credit-back is not a discount: the customer paid full price
at checkout and the credits arrive here.

`refundOrderCredits()` returns credits spent on an order that will never be
delivered. It reads the actual `ORDER_PAYMENT` rows rather than trusting
`Order.walletCreditAppliedCentavos`, because the ledger is the truth about what
was taken, and it nets off any refund already issued — so running it twice
refunds once. Credits go back to **credits**, never to cash: there is no rail
out, by design.

### Status handling

One `OrderStatus` enum holds a **superset** of every state any vertical can
reach. Which states a vertical may enter, and in what order, is defined per
service in `ORDER_LIFECYCLES` (`src/lib/orders/transitions.ts`) — *not* by the
ordering of the enum.

The lifecycles genuinely differ:

- **FOOD** — the existing chain: `PENDING_MERCHANT_ACCEPTANCE` →
  `MERCHANT_ACCEPTED` → `PREPARING` → dispatch → transit → `DELIVERED` →
  `COMPLETED`. Dispatch runs alongside the kitchen, so `PREPARING` reaches both
  `READY_FOR_PICKUP` and `AWAITING_RIDER_ASSIGNMENT`.
- **PARCEL** — **skips merchant acceptance entirely.** A placed parcel order
  goes straight to `AWAITING_RIDER_ASSIGNMENT`; there is nobody to accept it but
  us. No merchant status appears anywhere in its map, and a test asserts that.
- **MART** — has a store but no merchant acceptance: a shopper picks the items
  (`SHOPPING_IN_PROGRESS`).
- **PABILI** — a shopping leg plus an `AWAITING_BUDGET_APPROVAL` gate that only
  the *customer* can release.
- **RIDE** — a passenger boards (`PASSENGER_ONBOARD`) and the trip ends at
  `DROPPED_OFF`, never "delivered".

`src/lib/orders/state-machine.ts` reads that map and **contains no service-key
literal**. It also:

- validates the transition, the acting role (`permittedActors`), and that
  cancellations carry a reason;
- stamps timestamps from the declarative `STATUS_TIMESTAMP_FIELDS` map, once
  only, so a re-dispatch cannot rewrite `placedAt`;
- guards concurrency with `where: { id, status: <previous> }`, so two riders
  tapping "picked up" cannot both win;
- writes an `OrderStatusEvent` for every change — the audit trail the tracking
  screen renders as a timeline.

`submitOrder()` moves a new order to its vertical's `submittedStatus`. Checkout
calls that rather than naming a status, which is how checkout stays free of
per-vertical knowledge: food lands in `PENDING_MERCHANT_ACCEPTANCE`, a parcel in
`AWAITING_RIDER_ASSIGNMENT`, and checkout spells out neither.

**`requiresMerchant` vs. merchant acceptance.** These are different questions
and conflating them is how the `if FOOD` branches come back. `requiresMerchant`
means "an order must reference a store" — true for FOOD and MART. Whether the
lifecycle contains an *acceptance step* is a lifecycle concern, answered only by
the transition map. MART is `requiresMerchant: true` with no acceptance step.

---

## 3. Unified identity and address book

**One `User` per person**, regardless of how many services they use.

Roles are an **array** (`User.roles: UserRole[]`), not a single field. One person
can be a customer and a fleet partner at the same time — the seeded Maria Santos
is exactly that, on one record. Nothing downstream may assume a session belongs
to a customer.

**One address book**, shared across every vertical. An address saved while
ordering food is immediately available as a Parcel pickup. Beyond the usual
fields, `Address` carries:

- `usageCount` and `lastUsedAt` — maintained by `bumpAddressUsage()` once per
  order placement, so the picker orders by real behaviour rather than creation
  date;
- `isPickupCapable` — some saved places make sense as origins, not just
  destinations. A parcel pickup or a ride start reads this, which is why the
  flag lives on the address rather than being asked again in a future parcel
  flow.

---

### Authentication

Phone number plus a one-time code. No passwords — a password is a liability for
a market where the phone *is* the identity, and `User.phone` already was the
login identity in the original model.

**Signup and login are the same request.** Nothing in the flow reveals whether
a number already has an account: requesting a code answers identically either
way, and the `User` row is created at the moment a code is verified. That row
starts with `fullName: null` — which is why the column is nullable. A
phone-first signup knows the number before it knows the name, and putting a
placeholder there would make every reader guess whether the value was real.
`onboardedAt` gates the app on `/welcome` until a name is given, and checkout
requires an onboarded account, because an order needs somebody to hand food to.

**Codes** (`src/lib/auth/otp.ts`, rules in `otp-policy.ts`):

| Control | Value | Why |
| --- | --- | --- |
| Expiry | 5 minutes | A leaked code is stale before it is useful |
| Attempt ceiling | 5 wrong guesses | Five tries against a million possibilities |
| Resend cooldown | 45 seconds | A double-tapped button should not cost two SMS |
| Per phone | 3 per 15 min | Nobody gets bombarded with codes they did not ask for |
| Per source address | 12 per hour | One script cannot burn the SMS budget across many numbers |

The code is stored as **HMAC-SHA256 keyed with `AUTH_SECRET`**, never in
plaintext. A six-digit code has only a million possibilities, so a plain hash in
a leaked database is a rainbow table away from recovery; keying it means the
database alone is not enough. Comparison is constant-time. A wrong guess
increments the attempt counter even against an already-dead code, so poking an
expired one is not a free try. Issuing a new code consumes any outstanding one
in the same transaction — two live codes would be two chances to guess.

Every refusal reports **when to come back**, because a bare "try later" is a
dead end for someone who genuinely did not receive the first code. The two
messages an attacker would find useful — no code outstanding, and wrong code —
are deliberately identical, so the form cannot be used as an oracle.

**Sessions** (`src/lib/auth/session.ts`): an opaque 256-bit token in an
httpOnly, SameSite=Lax cookie; the database stores only its SHA-256 hash.
Server-side rows rather than a JWT for one reason that outweighs the
convenience: a session must be **revocable**. A signed token asserting "valid
for 30 days" cannot be taken back when a phone is stolen. The window slides on
use, sign-out revokes rather than deletes (so a stolen token cannot be
resurrected by re-inserting a row), and `/profile` lists live sessions with
"sign out everywhere else" — a list nobody can act on would be decoration.

Plain SHA-256 for the session token, not a slow KDF: the token is already 256
bits of CSPRNG output, so there is no dictionary to attack and no reason to tax
every request. What matters is that the database holds the hash.

**Route protection** is two layers. `src/middleware.ts` checks only whether a
cookie is *present* — middleware runs on the edge runtime where Prisma is
unavailable, so it cannot tell a valid session from a forged one. It exists to
bounce obviously signed-out traffic without a database round trip. The real
check is `getCurrentUser()` / `requireCurrentUser()`, which validate the token
hash on every page and action; a hand-written cookie gets past the middleware
and then resolves to nobody. Nothing in the middleware is load-bearing for
security, which is verified: a forged cookie reaches `/orders` and sees no data.

**SMS delivery** is an interface (`src/lib/auth/sms/`), because the provider is
the part most likely to be swapped — Philippine gateways differ in price,
sender-name registration and reliability. Development prints codes to the server
console; production **refuses to start a login** with no gateway configured,
because a console "sender" in production is the worst failure mode available:
every login reports success and no code arrives. The seeded adapter is Semaphore
(semaphore.co), the common local choice — written from its documented request
shape and **not verified against the live API**, since this codebase has no
account. Send one real message before trusting it.

**Progressive enhancement.** The login and onboarding forms post to server
actions through `useActionState`, so they work *before* hydration. This is not
theoretical for a market of low-end Android phones on patchy mobile data: a
`useState`-driven form loses whatever was typed before the JavaScript arrived
and leaves the submit button disabled while the person stares at their own
number in the field. Reading the client address is wrapped in a try/catch for
the same reason — `headers()` is unavailable on that path, and a throttling
input must never fail a sign-in. Both cost a real bug before they were fixed.

Login codes and dead sessions are pruned by `npm run jobs:orders`: a table of
hashed codes and address fingerprints has no value once the codes are dead.

## 4. Unified fleet

`RiderProfile` is **`FleetPartner`**. The rename is the point: the same person
will eventually deliver food, carry parcels, and possibly drive passengers, and
a name that says "rider" invites food-shaped assumptions.

Added:

- **`enabledServices: ServiceKey[]`** — which verticals this partner is approved
  for. Dispatch builds its candidate list from this array.
- **`vehicleType`**, plus `vehiclePlate`, `vehicleModel` and an `equipment`
  array.
- **Per-service verification** in `FleetPartnerServiceVerification`, unique on
  `(fleetPartnerId, serviceType)`, with its own status, submitted documents,
  decision, and expiry.

A partner approved for food delivery is **not** automatically approved to carry
passengers, and the model says so out loud rather than leaving it to policy. The
seeded partner is `APPROVED` for FOOD and `PENDING` for RIDE; a verified
end-to-end check confirms they appear as a FOOD candidate and not as a RIDE one.

`enabledServices` is a denormalised read model — dispatch hits it on every
candidate query — and `syncEnabledServices()` is the only writer. It recomputes
from `APPROVED`, unexpired verifications, so an approval in one service can
never leak into another.

`findDispatchCandidates()` reads `enabledServices` and `Service.requiresRider`.
**Everything else about the ranking logic stays as it is**: proximity dominates
(60 points), then rating (25), then acceptance rate (15).

`RIDER_ASSIGNED` permits `FLEET_PARTNER` as well as `SYSTEM`, because a partner
*accepting* an offer is the normal path — that is what
`FleetPartner.acceptanceRate` measures. The lifecycle originally allowed only
SYSTEM, which contradicted that field; a test now asserts both actors are
permitted wherever the state is reachable.

---

## Fleet partner app

The last piece of the loop. An order can now go from a customer's cart to
COMPLETED without anybody touching the database by hand.

### Offers are records, not a push

`DispatchOffer` exists for two reasons. It makes
`FleetPartner.acceptanceRate` mean something — without a row saying "this was
offered and went unanswered", that column is decorative. And it makes the race
safe: several partners hold a PENDING offer for the same order, the first to
accept wins on the state machine's optimistic guard, and the rest are marked
SUPERSEDED.

**SUPERSEDED deliberately does not count against anyone.** Being beaten to a job
by a closer partner is not a decision the partner made, and counting it would
punish people for working in a busy area. An EXPIRED offer *does* count —
ignoring your phone while online is a choice. A partner with no decisions yet
gets `null` from `computeAcceptanceRate`, and `1` for ranking: a brand-new
partner is not a 0% partner, and burying them at the bottom of every candidate
list would make the app useless on their first shift.

**The number the partner sees is computed, not the stored one.** Because the
ranking column always holds a value — `1` by default — reading it for display
put "94%" beside an empty offer history on the offers board. Both partner-facing
screens now call `computeAcceptanceRate()` on the offer records, where "no
history yet" is expressible: the board shows an em dash and the profile says
*No offers yet*. `getPartnerEarnings()` no longer returns the field at all, so
there is one source of truth for display and one for ranking, and they cannot
drift.

| Control | Value | Why |
| --- | --- | --- |
| Offer window | 60s | Long enough to answer at a traffic light |
| Fan-out | 3 partners | A sequential cascade means a customer waits five minutes while five people ignore their phone |
| Re-fan-out | after 20s | So a cron every minute does not stack batches |

One offer per partner per order, enforced by a unique key: re-offering the same
job to the same person is how an acceptance rate gets quietly destroyed.

### There is no worker

Dispatch runs on the same cron entry as the order sweep
(`npm run jobs:orders`), in a deliberate order: lapsed offers close first so the
fan-out sees accurate live counts, then dispatch runs, then the timeout sweep —
so an order that just found a partner is not cancelled a second later for having
no partner. Dispatch latency is therefore bounded by cron frequency, which the
twenty-minute `AWAITING_RIDER_ASSIGNMENT` timeout absorbs. A real queue is the
upgrade path, and this is documented rather than hidden.

### Nothing is food-shaped

The offers board shows only services the partner is approved for, because
`findDispatchCandidates` filters on `enabledServices` — verified: the seeded
partner is a FOOD candidate and is *not* a RIDE candidate, despite having
applied for RIDE. The active-job screen's buttons come from the lifecycle map,
so a ride would show "Nakasakay na" and end at `DROPPED_OFF` without that screen
knowing passengers exist.

### Approval is not self-service

Applying creates the `FleetPartner` record and a PENDING
`FleetPartnerServiceVerification` per service; `enabledServices` stays **empty**
until somebody approves. That is the per-service model doing its job: approval
to carry food is not approval to carry a passenger. There is no admin console
yet, so `npm run fleet:approve -- <phone> FOOD` is the honest stand-in — a
deliberate act by a person, not a button the applicant can press.

Going online requires a position, because dispatch ranks on distance and a
partner with no location can never be a candidate. Appearing "online" while
unreachable would mean sitting there receiving nothing and concluding the app is
broken.

### Earnings

The delivery fee plus the whole tip. The fee is the order's **full quoted fee
even when a subscription waived it for the customer** — that waiver is our
marketing cost, not a pay cut for the person doing the ride, which works because
Phase 5 kept the fee at full value and recorded the waiver as a discount.
Counted on COMPLETED orders only: a cancelled job pays nothing, and showing it
as earned is a promise broken at payout. Platform commission is not modelled
yet; when it is, it comes off our side, not out of the tip.

### Giving a job back

`abandonJobAction` returns an order to the pool rather than cancelling it: the
food is still sitting on a counter and another partner can still collect it.
Only where the lifecycle allows the move back to `AWAITING_RIDER_ASSIGNMENT`;
otherwise it becomes a rider cancellation, with a reason.

### Completion closes the loop

Delivering runs two transitions: the partner marks DELIVERED, then the SYSTEM
completes the order — which is what grants the customer any credit-back their
subscription accrued and counts the job as paid. Same two-actor pattern as the
merchant's mark-ready.

## Merchant back office

Until something could accept an order, every order placed was cancelled by the
timeout sweep eight minutes later. This is the screen that unblocks the product,
which is why it came before the fleet app rather than after it.

### Who may touch which store

`StoreMember` grants store access — a join table, not an owner column on
`Store`, because the real shape is many-to-many in both directions: a karinderya
owner works the queue alongside two staff, and a small chain owner holds several
stores. An owner column would force a second source of truth the first time
either happened, and `Store.ownerUserId` was removed for exactly that reason.

Three roles, ranked so "at least this" is one comparison:

| Role | May do |
| --- | --- |
| `STAFF` | Work the queue; open and close the store; take items off the menu |
| `MANAGER` | Also prices and prep time |
| `OWNER` | Everything |

`STAFF` can close the store deliberately: someone has to be able to stop orders
when the rice runs out at 8pm and the owner is not there.

`User.roles` carrying `MERCHANT_OWNER` says what kind of person someone is. This
table answers the question every merchant action actually asks — may THIS person
touch THIS store — and it is the only thing that does.

**Authorisation reads the order's own store**, never a store id sent alongside
it: `requireOrderStoreAccess(orderId)` loads the order, pulls `storeId` out of
its details container, and checks membership against that. Otherwise a merchant
could accept a neighbour's order by editing a form field. Verified: a second
owner's queue does not contain the first's orders, `/merchant/<other-store>`
returns not-found, and menu writes are scoped `where: { id, storeId }` so an
item id from elsewhere matches nothing.

Access failures read identically whether the store is missing or simply not
theirs, so the screen cannot be used to probe for other stores' ids.

### The queue

Three stages, in the order a kitchen works: what needs a decision, what is
cooking, what is waiting to be collected. The stages are presentation; **the
buttons on each card are the lifecycle map's decision** —
`allowedTransitions(...)` filtered by `isActorPermitted(..., MERCHANT)`. A card
for an order a partner is already carrying offers nothing but a cancellation,
because that is what the map says, not because this screen knows about food.

A test asserts every merchant-actionable status appears in some stage: a status
a merchant can act on but that no stage shows would make an order invisible to
the kitchen holding the food.

Cards carry what a kitchen reads: elapsed wait rather than a timestamp, item
notes, the cutlery flag, and the dropoff barangay for deciding what to cook
first. Orders waiting more than three minutes for a decision get a ring.

### The actions

- **Accept** / **start preparing** — plain transitions.
- **Reject** — requires a reason (the state machine enforces it for every
  cancellation) which reaches the customer verbatim, and refunds any credits
  they spent in the same transaction. "Wala nang adobo" beats a silent
  cancellation they have to phone about.
- **Mark ready** — two transitions, because they belong to different actors: the
  merchant says the food is ready, and the SYSTEM starts looking for a rider.
  Doing both here means an order cannot sit at `READY_FOR_PICKUP` with nobody
  searching. A merchant cannot perform that second step themselves: finding a
  partner is ours, and a test pins that `AWAITING_RIDER_ASSIGNMENT` permits
  `SYSTEM` and not `MERCHANT`.
- **+10 minutes** — writes an `OrderStatusEvent` as well as moving `etaAt`, so a
  delay is visible in the customer's timeline and in support rather than being a
  quietly moved number.

Price editing is safe to expose because every order snapshots what it charged:
raising a price today cannot rewrite last month's receipt. Verified against the
database.

Its own layout, with its own tabs — the customer's bottom navigation would offer
Credits and Orders to somebody running a kitchen. That nav is now hidden on the
merchant area and on the auth screens, where it was offering signed-in
destinations to someone who was not signed in.

The queue polls itself every 20 seconds: someone else may accept an order from
another device, and a stale queue is how two people cook the same thing.

## 5. Credits — rewards only, and a ledger

`Wallet` (one per user, `balanceCentavos`, `currency` PHP) and
`WalletTransaction` (append-only: `walletId`, `type`, `amountCentavos`,
`balanceAfterCentavos`, `relatedOrderId`, `description`, `createdAt`).

Transaction types: `PROMO_CREDIT`, `REFUND`, `REFERRAL_BONUS`, `ORDER_PAYMENT`,
`ADJUSTMENT`. Note what is *absent* — there is no `TOP_UP`, no `TRANSFER_IN`/
`TRANSFER_OUT`, no `WITHDRAWAL`. The absence is the product constraint,
expressed in the type system.

### Hard constraints

1. **No top-up.** There is no path for a customer to add their own cash to a
   balance.
2. **No transfers between users.**
3. **No withdrawal or cash-out.**
4. **Balance can only be spent on orders within the app.**

These are enforced, not merely stated:

| Constraint | Enforcement |
| --- | --- |
| No top-up | No transaction type and no function grants credit on a customer's authority. `grantCredit()` is called by promo campaigns, referral payouts and support — never by a customer paying in. |
| No transfers | No function accepts two wallet or user identifiers. A transfer needs two parties and there is no signature for one. |
| No cash-out | No withdrawal function exists. `refundToCredits()` returns credits *to credits*, never to cash or a card. |
| Spend on orders only | `ORDER_PAYMENT` and `REFUND` require a `relatedOrderId` in application code **and** in a database `CHECK`. |

`src/tests/wallet-ledger.test.ts` asserts the module exports nothing matching
`topUp`, `transfer`, `withdraw`, `cashOut`, `setBalance` and friends, and that
the enum contains exactly the five permitted types. Adding one of those is a
failing test, not a quiet regression. `src/lib/wallet/ledger.ts` ends with a
comment block naming the four functions that must never be added, and why.

> If a requirement seems to need one of these, that is a product conversation,
> not a patch. Adding a cash-in rail turns this into a stored-value instrument
> with the regulatory weight that implies.

### The ledger is the truth

Every balance change goes through **one** backend function,
`recordWalletTransaction()`. It writes a `WalletTransaction`, then
**recalculates the balance from the sum of the ledger** and writes that derived
value to `Wallet.balanceCentavos`. Nothing else in the codebase writes that
column.

- The prior balance is read from `sumLedger()`, never from the cached column, so
  a drifted cache cannot authorise an overspend.
- The balance is written as an absolute value, never as an `increment` — an
  increment would make the column the truth.
- Runs at `Serializable` isolation, so two concurrent grants cannot both read a
  stale sum.
- **Signs are forced by type** (`signedAmountFor()` in
  `src/lib/wallet/rules.ts`): callers pass a magnitude and a type and never a
  sign, so a payment cannot be booked as a credit by passing the wrong number.
  `ADJUSTMENT` is the single signed type, and requires an `adminUserId`.
- `idempotencyKey` makes grants replay-safe: a retried campaign cannot
  double-credit.
- `reconcileWalletBalance()` replays the ledger, reports drift, and repairs the
  cache. Safe to run on a schedule.

`prisma/sql/wallet_append_only.sql` makes the same rules true at the database
level, so a console session or a future service in another language cannot
bypass them: triggers rejecting `UPDATE` and `DELETE` on `WalletTransaction`,
and `CHECK` constraints for the sign-per-type rule, the order-link requirement,
the admin requirement on adjustments, and a non-negative balance. Apply with
`npm run prisma:guards` after migrating. All six guards are verified against a
live database.

### Wording

Surface this as **"Credits"** or **"Rewards"**. Never "wallet", "e-wallet",
"e-money", or anything implying a cash-out. The bottom navigation says Credits;
`WALLET_CONSTRAINTS.uiLabel` carries the string, and a test pins it. The
`/credits` screen states the four constraints in plain Filipino, because a
customer should never discover them at the moment they are counting on the
opposite.

---

## 6. Subscription tier

`SubscriptionPlan` (name, `monthlyPriceCentavos`, benefits, `isActive`) and
`UserSubscription` (userId, planId, status, `startedAt`, `renewsAt`,
`cancelledAt`).

Benefits are **structured records the pricing engine reads**, in
`SubscriptionBenefit` — a child table rather than free text, so nothing has to
parse marketing copy:

| Type | Columns used |
| --- | --- |
| `FREE_DELIVERY` | `minimumOrderCentavos`, `monthlyUsageCap` |
| `DISCOUNT_PERCENT` | `percentBasisPoints`, `serviceKeys`, `maxDiscountCentavos` |
| `CREDIT_BACK_PERCENT` | `percentBasisPoints`, `monthlyCeilingCentavos` |

Percentages are **basis points** (1250 = 12.5%), so the first 7.5% campaign does
not need a migration. `displayLabel` is the only column the pricing engine
ignores.

Scoping is data: an **empty `serviceKeys` means every active service**,
otherwise the benefit applies only to the listed keys. That is how a discount
gets scoped to a vertical without a branch — the seeded 5% discount is
`[FOOD]`, and extending it to MART on launch day is a row edit.

`SubscriptionBenefitUsage`, unique on
`(userSubscriptionId, benefitId, periodStart)`, tracks consumption within a
calendar month, so `monthlyUsageCap` and `monthlyCeilingCentavos` are
enforceable rather than aspirational.

### Pricing

`quoteOrderPrice()` (`src/lib/pricing/checkout.ts`) checks the registry, loads
any active subscription, and hands the arithmetic to the pure `applyBenefits()`
in `src/lib/pricing/benefits.ts`. The split is what lets the benefit rules be
tested exhaustively without a database — 22 tests cover the caps, ceilings,
scoping and rounding.

Order of operations, deliberate:

1. Fees as quoted.
2. `FREE_DELIVERY` — waives the delivery fee above the minimum order, within the
   monthly cap. **The fee is not zeroed**; it stays on the order at full value
   and the waiver is recorded as a discount line, so the receipt reads
   "Delivery fee ₱49 / Plus benefits −₱49". Zeroing the fee *and* recording a
   discount would subtract it twice.
3. `DISCOUNT_PERCENT` — off the subtotal, service-scoped, within its ceiling.
4. Promo/voucher discount, then the total. Combined discounts are capped at the
   gross, and when they overshoot the *subscription* share is trimmed first so
   the customer's own voucher is never the thing that gets clipped.
5. `CREDIT_BACK_PERCENT` — accrued against what the customer actually pays,
   within the monthly ceiling. **Not a discount**: they pay full price now and
   the credits arrive on completion, via the ledger.
6. Credits applied, capped at the balance and at what is owed.

Quoting **writes nothing**. `commitBenefitUsage()` records consumption once the
order row exists, because quoting happens on every keystroke in checkout and a
quote must never burn someone's monthly free deliveries.

An **inactive plan grants nothing**, even to someone already subscribed —
`getActiveSubscription()` filters on `plan: { isActive: true }`. That is what
makes the seeded plan safe to leave in place.

**Seeded plan:** *Deliveryapp Plus*, ₱99/month, `isActive: false`. Free delivery
over ₱299 (8×/month), 5% off Food (₱100 cap), 2% credits back (₱200/month
cap). It stays off until there is a decision to launch it.

### Enrollment, and why it cannot be paid for yet

`isActive` is the **entire launch mechanism**, and now gates in three places:
the pricing engine, the plan screen, and `enrollInPlan()`. `npm run plan:activate
-- <slug>` flips it; nothing else turns the tier on.

**A paid subscription cannot be created.** This is not an omission, it is the
credits constraint holding. The app has two money rails — cash a rider collects
against a specific order, and credits, which are rewards we grant and which are
*spendable on orders only*, enforced in the ledger, in SQL triggers, and in
tests. Neither can bill ₱99 a month. `resolveSubscriptionCharger()` in
`src/lib/subscriptions/payment.ts` therefore has no implementations and throws;
`enrollInPlan({ origin: PAID })` refuses at the door, and the plan screen says
why rather than offering a button that would fail. The alternative — a stub that
records a charge nobody made — is the same failure mode as an SMS "sender" that
prints to a console in production.

So `UserSubscription.origin` is required, with no default:

| Origin | Means | Available today |
| --- | --- | --- |
| `PAID` | Charged to a payment method | No — needs a gateway |
| `COMPED` | Given deliberately to a named person | Yes |
| `PROMOTIONAL` | Given by a campaign | Yes |

A grant is **attributable**: `grantedByUserId` and `grantNote` are required for
both grant origins, enforced by a CHECK constraint, and the granting script
requires `--by <admin phone>` where that account holds ADMIN or SUPPORT_AGENT. A
comp is revenue we chose not to collect, and a comp list nobody can attribute is
how that choice stops being a choice. The seed now creates an ops admin
(`0917 000 9999`) because without an account holding one of those roles, neither
a grant nor a ledger ADJUSTMENT is possible at all.

**One live subscription per person**, where ACTIVE and PAST_DUE both count as
live. Checked in `enrollInPlan()` for the error message and enforced by a partial
unique index in `prisma/sql/subscriptions.sql`, because a double-clicked button
beats any check-then-write.

### Renewal

`sweepDueSubscriptions()` runs from the same cron as the order timeouts. It is
**record-keeping, not enforcement**: the pricing engine already requires
`renewsAt > now`, so a lapsed subscription stops conferring benefits the instant
it lapses whether or not the cron has run. A cron that has not run for an hour
must not hand out an hour of unpaid benefits.

`decideRenewal()` is pure, and the two origins differ:

- **A grant does not renew itself.** It expires at its term, and `endedAt` is set
  to `renewsAt` — when the term ended, not when the cron noticed. Re-granting is
  a deliberate act, the same way approving a fleet partner for a second service
  is.
- **A paid subscription** whose charge fails goes PAST_DUE and stays live for
  `PAST_DUE_GRACE_DAYS` (3), so a card that fails on a Friday has the weekend to
  be fixed. That path is unreachable today; it is written and tested anyway, so
  the day a provider lands it is already right.

### Cancelling

Immediate, not at period end: every subscription that exists today is a grant, so
there is nothing paid-for to run down. When a gateway lands, a paid cancellation
should keep its benefits until `renewsAt`, which means setting `endedAt` to
`renewsAt` in `cancelSubscription()` and relaxing the `endedAt: null` filter in
`getActiveSubscription()`. Both are named in the code so the change is one search
away.

### The plan screen

`/plus` is assembled from the benefit rows: `displayLabel` for the marketing
line, and `benefitTerms()` for the mechanics under it, read off the same columns
`applyBenefits()` compares against. The screen cannot promise a benefit checkout
will not honour. A subscriber also sees month-to-date consumption, read from the
`SubscriptionBenefitUsage` rows the engine writes — not a second tally that could
disagree with the first.

**A known trade-off:** pulling a plan stops benefits for existing subscribers
immediately, because `getActiveSubscription()` requires an active plan. That is
right while every subscription is a grant, and wrong the moment somebody has
paid for the month — revisit it with the gateway. `/plus` marks the state
(*"Naka-pause ang plan"*) rather than showing a plan that quietly does nothing.

---

## 7. Home screen

`src/app/page.tsx`, built around **service selection** rather than dropping
straight into a restaurant list.

1. **Location** — current delivery address with a tap-to-change control, reading
   the shared address book (`LocationHeader`).
2. **Global search** — one box across every active service (`GlobalSearch` →
   `/search` → `globalSearch()`). It searches only active services live in the
   current city; which services have a searchable catalogue comes from
   `requiresMerchant`, so MART becomes searchable the moment it is activated.
   Returning a result we cannot fulfil is worse than returning none.
3. **Service tiles grouped by intent**, from the registry (`ServiceTileGrid`).
   Active services are links. Coming-soon services render dimmed with a "Coming
   soon" label and are **not tappable** — not a disabled link but *no link*, so
   keyboard and screen-reader users are not offered a dead target either. Empty
   groups are omitted, so the *Bayad* section simply does not render yet.
4. **Active-order strip** — anything in progress in *any* vertical, with status
   and a tap-through to tracking. Built from `ALL_IN_PROGRESS_STATUSES`, derived
   from the lifecycle map, so a new vertical's states are covered as soon as its
   lifecycle is registered.
5. **Promotions** — scoped by service key, and filtered so a promo whose only
   services are unlaunched never advertises itself.
6. **Recent stores / reorder shortcuts** — from the customer's own history,
   falling back to well-rated local stores for a first-time visitor.

**Bottom navigation: Home, Orders, Credits, Profile.**

`/orders` is **every order across every service in one chronological list**.
That unified history is a large part of what makes this feel like one product
rather than several, and it is one query with no per-service branches only
because there is one `Order` table. A vertical launched next year appears there
automatically.

### Cart and checkout

The cart lives in the browser (`localStorage`, via `CartProvider`), not as a
DRAFT `Order` row — a quantity stepper should not write to Postgres on every
tap. The lifecycle's `DRAFT` state exists for the single placement transaction
rather than for the minutes someone spends browsing. A food cart holds one
store; adding from another replaces it and says so, because silently discarding
a basket is worse than an extra tap.

The cart bar shows an item **count, not a total**. A total there would have to
be computed client-side from cached prices and would then disagree with the
server at the worst possible moment. It is hidden on `/checkout` and `/orders`,
where it is redundant or in the way.

`CheckoutForm` never computes money either: every amount comes from
`quoteCheckoutAction`, re-requested whenever a price-bearing input changes. That
costs a round trip per change and buys the guarantee above. Notes and the
cutlery flag are excluded from the re-quote trigger — they do not affect price.

Every server action resolves the customer from the session rather than its
arguments: a client cannot name whose order it is placing, whose credits it is
spending, or whose order it is cancelling. Domain errors written to be read
(`"This store delivers within Manila"`) pass through to the customer; anything
unnamed is logged and replaced, because an internal message is not a customer's
problem.

Credits are the only non-cash rail, so paying **with** credits is all or
nothing: a shortfall is refused with an explanation rather than a partial
charge. With cash on delivery, credits may partially offset the bill.

### Tracking

`/orders/[orderId]` polls itself while the order is live (`OrderLiveRefresh`),
pauses while the tab is hidden, and stops on its own at a terminal state so it
is not burning requests on a finished order. A websocket is the right answer
eventually.

Whether the customer may cancel is the **transition map's** decision, checked
server-side: a food order can be cancelled while the store is deciding or
cooking, but not once a partner is carrying it. The button only renders when
the map says so.

Per-service styling is resolved from `Service.accentToken` through a static map
keyed by *token*, not by service key (`src/lib/services/presentation.ts`) —
Tailwind cannot build a class name from a runtime string, but a new vertical can
reuse an existing token and change nothing here.

---

## 8. Unified support

One `SupportTicket` model covering all services, with a `serviceType` field and
an optional `relatedOrderId`, plus `SupportTicketMessage` for the thread.

A ticket raised against an order **inherits that order's vertical** — the
customer should not have to tell us something we already know.

`serviceType` is **nullable**, a deliberate deviation from a literal reading of
the brief: an account-level problem ("I can't log in", "credits question")
belongs to no single vertical, and forcing one would make the data lie. Null
means account/general.

One help section (`/help`), with per-service FAQ categories driven by the
registry: a category carrying a `serviceType` renders under that service's name
and picks up its "Coming soon" marker, and a category for a service that does
not exist is dropped rather than shown as an empty section.

---

## Notifications — an outbox, not a fire-and-forget

The gap this closes: every screen polled while it was open, so a store or a
partner who closed the tab learned nothing. SMS is the only channel that reaches
a closed tab today, and it costs money per message — which is why almost every
decision in this section is about *restraint*.

### The shape

`Notification` is one thing that happened, addressed to one person: a row per
recipient, because "who has read this" is a property of a person. Both forms of
the copy — the screen version and the short form for a text — are rendered at
enqueue time and stored, so an edited template cannot rewrite a message already
queued, and support can see exactly what somebody was told.

`NotificationDelivery` is one attempt through one channel. Separate, because
delivery fails per channel: an SMS gateway timing out must not lose the inbox
copy, and a retry needs somewhere to count attempts.

### Enqueueing is part of the transaction that caused it

`transitionOrder()` writes the status, the status event and the notifications in
one transaction. Notifying after the commit would drop the message whenever the
process died in between, and those are precisely the moments somebody is
waiting.

That imposes a constraint worth knowing about: **inside a caller's transaction,
a failed statement aborts the whole transaction at the database level**, and
catching the error in TypeScript does not put it back. So `enqueueNotification()`
inserts with `skipDuplicates` — `ON CONFLICT DO NOTHING` — rather than catching a
unique violation on `dedupeKey`. A duplicate is the ordinary case (a retried
transition, a cron that ran twice, two tabs advancing the same order), and it must
not cost a delivered order. A test asserts the file contains no `P2002` handling.

### Which statuses notify

`ORDER_STATUS_NOTIFICATIONS` is keyed by **every** `OrderStatus`, so a new status
in the superset cannot be added without deciding whether it earns a message.
Most do not, and each `null` says why in a word or two: `PREPARING` adds nothing
to a customer who already knows the order was accepted; `AWAITING_RIDER_ASSIGNMENT`
would invite a question nobody can answer.

Audiences are a map from audience to kind, not a list, because the same event is
not the same news to everybody:

| Status | Customer hears | Store hears |
| --- | --- | --- |
| `PENDING_MERCHANT_ACCEPTANCE` | — | `ORDER_SUBMITTED` |
| `CANCELLED_BY_CUSTOMER` | — (they did it) | `ORDER_CANCELLED` |
| `CANCELLED_BY_SYSTEM` | `ORDER_CANCELLED` | `ORDER_LOST_TO_TIMEOUT` |

No service branch appears anywhere in this layer. The vertical's display name
arrives from the registry in the template context, which is why the same
`ORDER_DELIVERED` copy reads correctly for Food and for Parcel.

### Restraint is the policy

`KIND_POLICY` gives every kind an urgency and a channel list, and
`CHANNEL_DEFAULTS` decides what a person who has never touched a setting gets:

- **`IN_APP` is always on** and is not representable as a preference. The inbox
  is the record of what we told somebody; switching it off would mean losing
  history rather than being left alone. A CHECK constraint refuses the row.
- **SMS defaults on for OPERATIONAL and off for INFORMATIONAL.** That split is
  the entire reason `urgency` exists. A store that misses an order loses money
  and a dispatch offer expires in 60 seconds; a customer does not need to pay
  for a text saying the kitchen has started. Four kinds carry SMS by default:
  `ORDER_SUBMITTED`, `DISPATCH_OFFER`, `ORDER_ARRIVED`, `ORDER_CANCELLED`.
- **An opted-out channel becomes a SKIPPED row**, not a missing one, so the
  record still shows what we chose not to send.

**Quiet hours** are 22:00–06:00 Manila (a fixed offset; the Philippines has no
daylight saving). An informational text is *deferred* to 06:00 rather than
dropped — a customer whose order was cancelled overnight still needs to know —
and lands exactly on the hour so a night of deferrals does not fan out across
one minute. Operational messages ignore quiet hours entirely.

### Delivery

`deliverPending()` runs from `npm run jobs:orders`, last in the pass, so
everything the same run enqueued goes out in it. Three attempts with 1/5/25
minute backoff, then a FAILED row with the gateway's own words in it — a CHECK
constraint requires the reason, because a silent failure is a bug report nobody
can file.

A channel with **no adapter configured** leaves its deliveries PENDING rather
than failing them: the moment a gateway is configured the backlog goes out, and
marking them failed would throw messages away for a reason that has nothing to
do with the messages. The cron says so out loud when it happens.

How fast a store hears about an order is bounded by how often the cron runs.
That is the same limitation dispatch has, for the same reason: no worker.

### Push is the next adapter, not the next rewrite

`NotificationChannelAdapter` is one interface with two implementations. Web push
lands as a third — a subscription table, VAPID keys from the environment, the
same `deliver()` signature — and nothing above that layer changes. That is the
test of whether this design was worth building: the channel that reaches a
closed tab *for free* should be a file, not a phase.

---

## Verification

Database-free, in CI (`npm run verify`) — **62 tests**:

| File | Covers |
| --- | --- |
| `no-service-branches.test.ts` | The registry rule, across the whole tree; config-map exhaustiveness |
| `order-transitions.test.ts` | Per-service lifecycles, reachability, no dead ends, actor permissions |
| `wallet-ledger.test.ts` | The four hard constraints, sign derivation, ledger replay, SQL-guard agreement |
| `pricing-benefits.test.ts` | Benefit caps, ceilings, scoping, basis-point rounding, discount floors |
| `delivery-fee.test.ts` | Pro-rata distance, floors and ceilings, both thresholds, haversine |
| `phone.test.ts` | E.164 normalisation of every way a Filipino writes their number |
| `otp-policy.test.ts` | Expiry, attempt ceiling, all three throttles, non-leaking messages |
| `auth-crypto.test.ts` | Code and token generation, keyed hashing, constant-time compare |
| `sms-sender.test.ts` | Sender selection, the production refusal, the Semaphore request shape |
| `merchant-queue.test.ts` | Role ranking, store-id extraction, queue coverage of every merchant-actionable status |
| `fleet-offers.test.ts` | Acceptance-rate maths, offer windows, earnings, active-job coverage, per-vertical partner steps |

Verified separately against a live PostgreSQL 16 with the SQL guards applied:

- **42 end-to-end checks** on the foundation: registry gating by city, the FOOD
  lifecycle and its rejections, dispatch including a partner for FOOD and
  excluding the same partner from RIDE, ledger idempotency and overspend
  rejection, ledger replay reproducing every `balanceAfterCentavos`, all four
  database guards rejecting raw writes, subscription benefits firing only once
  the plan is active, and support tickets inheriting the order's vertical.
- **53 end-to-end checks** on checkout: rate resolution and refusal, six
  hostile-input rejections, single-transaction placement with both address
  snapshots, credits applied and capped, cancellation refunding exactly what
  was spent and being idempotent, the merchant timeout firing only after its
  window with a customer-readable reason, credit-back granted on completion, and
  an eleven-step lifecycle audit trail that is contiguous end to end.

- **33 end-to-end checks** on authentication: the plaintext code never reaching
  the database, only the newest code working, single use, lockout after five
  wrong guesses (including the *right* code being refused afterwards), expiry,
  an undelivered code being consumed rather than left usable, a landline
  rejected before any SMS, a code requested as `+63` verifying as `09xx`,
  session lookup by hash, and pruning.

- **34 end-to-end checks** on the merchant flow: memberships and role ranking,
  an order reaching the right stage with the right buttons, a second store not
  seeing it, accept → prepare → ready handing off to dispatch, rejection
  refunding exactly what was spent and surfacing its reason, a cancellation
  still requiring a reason, an accepted order surviving the timeout sweep while
  an unaccepted one of the same age is cancelled, menu writes scoped to the
  store, and a price change not rewriting an existing order.

- **36 end-to-end checks** on dispatch and the fleet: per-service approval
  gating candidacy, offers fanning out without duplicating, two partners racing
  one order with the loser SUPERSEDED and their rate untouched, the job screen
  offering only the next step, delivery completing the order, an ignored offer
  expiring and denting the rate, dispatch reporting nobody in range, and a job
  handed back landing in the pool rather than cancelled.

And driven through a real browser four times over: cart → checkout → placement
→ tracking → cancellation; signed-out redirect → bad number → wrong code → real
code → `/welcome` → onboarding gate → session → httpOnly cookie → sign-out →
forged cookie rejected → sign back in; and a customer placing an order while a
merchant accepts it, cooks it, adds ten minutes, marks it ready, then rejects a
second one with a reason the customer reads — plus a two-store owner getting a
picker, and both a rival merchant and a customer getting not-found on somebody
else's store; and the whole loop with three separate sessions — a customer
places an order with a tip, the merchant cooks and readies it, the cron
dispatches, the partner accepts and works it to delivery, the customer's
timeline reaches twelve events at COMPLETED, and a new applicant is blocked from
going online until `npm run fleet:approve` is run.

`npm run build` and `npm run lint` are clean; every route returns 200.
