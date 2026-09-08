# Architecture

TARA is a multi-service delivery app for the Philippine market. It runs
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
to carry food is not approval to carry a passenger.

Decided in the console, at `/admin/fleet` — see below. `npm run fleet:approve`
still works and is kept for the one case the console cannot serve: a fresh
deployment where nobody has console access yet.

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

### Live tracking, and the half that was missing

A customer watching an order in transit gets a map with two pins: their address
and the rider. It exists because of one uncomfortable discovery — the rider's
side of it had never been built.

`updateLocationAction` had been in the codebase since dispatch, and **nothing
called it**. A position was written once, when a partner went online, and then
aged for the rest of the shift. Dispatch was ranking candidates on where they
had been when they clocked in, and a map — had there been one — would have shown
a motorcycle parked wherever the rider had breakfast. `LocationShare` is the
missing half: a `watchPosition` subscription that runs while, and only while,
the partner is online.

**`watchPosition`, not a timer around `getCurrentPosition`.** The browser is
already holding a fix for its own purposes; asking it to wake the radio afresh
every fifteen seconds is how an app becomes the reason a rider's battery dies
mid-shift. What is throttled is the **writing**: fifteen seconds *and*
twenty-five metres, so a phone at a red light is silent.

**A throttled fix is held, not dropped.** `watchPosition` reports *changes*, so
a rider who moves and then stops gets one callback. If that callback lands
inside the throttle window and is discarded, the position they stopped at is
never written — and stopping is what arriving looks like, which makes it the
worst fix in the world to lose. The newest reading is kept in a ref and
reconsidered every three seconds. Hence `shouldShareFix(previous, next, now)`
measures the interval against the **clock**, not against the gap between the two
readings: asked the second way, a fix taken two seconds after a write stays two
seconds after it forever and can never be sent, however long it sits in hand.

**The rider can see that it is running.** A background location share nobody
mentions is the kind of thing that ends up in a news story, so the fleet header
carries a sentence naming the interval and the distance, and says when location
is blocked and what that costs them.

Four gates decide whether the customer sees a pin, and `riderPositionForCustomer`
returns `null` — never an error, never a partial answer — at each of them:

1. **The order is theirs.** `order.customerId !== userId` is the first check
   after the row loads.
2. **Somebody is carrying it.** `TRACKABLE_STATUSES` *is* `ACTIVE_JOB_STATUSES`
   rather than a second list beside it; a tracking window that drifts out of
   step with the lifecycle is a pin on a delivered order.
3. **The fix is recent.** Ninety seconds. Older than that and the map says so in
   a sentence instead of showing a pin that has stopped being true.
4. **The coordinates are plausible.** A bad fix reports a position that is wrong
   rather than absent — the null-island reading at (0, 0) is the classic — so the
   Philippines bounds are applied before anything is returned.

The order page's query asks for the rider's **name** and never the position
columns; the coordinates reach the browser only through the polled action, which
returns four numbers and nothing else. The rider's phone number, their other
jobs and their history are not on the customer's screen and are not in the
payload that builds it.

**Distance, never an ETA.** The panel says "3.8 km away" and the caption says it
is a straight line. Minutes across a city with one bridge is the number that
makes somebody stand at a gate, and we do not have a routing engine — so we do
not make the claim. The component is grep-tested against ever making it.

The map is Leaflet with `MAP_TILE_URL` behind it. Two operational notes learned
the hard way: `/admin/health` now warns that a customer-facing map on
OpenStreetMap's own tiles is outside their usage policy and wants a self-hosted
or paid provider; and the tile layer is trusted only as far as its own counters
— Leaflet's `load` event fires when a batch settles whether the tiles arrived or
failed, so `tileload`/`tileerror` are counted and an eight-second timeout falls
back to the sentence.

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

### The menu is the shop's own document

Until late on, **nothing in the application could create a menu item**. The
screen could reprice a dish and mark one out of stock; the dishes themselves
came from `prisma/seed.ts`, so a real shop's menu meant somebody with database
access writing INSERTs. The console even refused to make a store visible until
it had a menu, advising the owner to "add items first" — advice its owner could
not act on. That made the launch step "replace the demo stores with real ones"
impossible without SQL, which is the same shape as the earlier discovery that
no store could be created at all outside the seed.

A manager or the owner now adds, edits, recategorises, reorders and removes
dishes at `/merchant/<store>/menu`. `merchant/menu-policy.ts` is pure and holds
every rule; `merchant/menu.ts` does the reads and writes; `menu-actions.ts` is
the authorisation boundary.

**The role split is the interesting decision.** Marking the pork out of stock
stays at STAFF, because the rice runs out at 8pm and whoever is on the counter
has to be able to say so. Everything else needs MANAGER: adding, renaming,
repricing and deleting change what the business sells, not what is left today.
The screen hides what a viewer may not use and every action re-checks the role,
because a hidden button is not an authorisation check.

**Ordering: one list, sections as runs.** `sortOrder` is a position in the
store's whole menu, dense from zero, and a category is a contiguous run inside
it; the sections appear in the order their first item does. Every mutation ends
by resequencing the list inside the same transaction, so the invariant is true
after each edit rather than maintained by each caller remembering to.

The two alternatives were both worse. Sorting sections alphabetically — which
is what both menu screens did before — puts "Add-ons" above "Rice meals" on
every carinderia menu in the country, and no shop wants their extra rice listed
first. A `MenuCategory` table with its own rank is the textbook answer, but it
turns a rename into a migration of live rows and leaves two places that can
disagree about what a section is called. The cost of the run model is that a
reorder rewrites the store's positions rather than one row; a menu is tens of
items edited by hand, so that is a rounding error.

Consequences worth naming:

- **A dish moves within its own section only.** "Down" from the bottom of a run
  would silently recategorise it, which is not what anybody looking at a
  grouped list means by it — so it is a reported no-op instead.
- **A section name is snapped to the spelling already on the menu.** Typing
  "add-ons" under a menu that says "Add-ons" joins that section rather than
  starting a second one beside it, which could otherwise only be undone row by
  row.
- **The same dish name is refused inside one section and allowed across two.**
  "Extra Rice" as an add-on and as a rice meal are two sellable things; twice in
  one run is a double-tap the kitchen printout could not tell apart.
- **Renaming onto an existing section merges the two**, unless the merge would
  leave two identically named dishes in one run, which is refused by name.
- **Deleting is a real delete.** Nothing holds a foreign key to `MenuItem` and
  every order snapshots the name and price it charged, so removing yesterday's
  dish cannot rewrite yesterday's receipt. The screen still asks first, and the
  request carries the name the merchant was looking at — a phone left open in a
  kitchen is a stale view, and the destructive control on it is this one.
- **A price is read from what a person typed** — `120`, `120.50`, `₱1,250` —
  via centavo-integer arithmetic rather than `Number(x) * 100`, which turns
  19.99 into 1998.9999999999998. A third decimal place is refused rather than
  rounded: silently charging ₱12.35 for `12.345` is how a support thread
  starts.

The customer's store page groups with the same function and orders by the same
column, so what a shop arranges is what a customer sees.

### Photographs of dishes, and where the bytes go

`MenuItem.imageUrl` existed from the first schema and nothing ever wrote to it.
That is the honest reason it is gone: a URL column is a promise that something
somewhere is hosting the file, and nothing was. The gap was never the form
field — it was that there was nowhere to put a photograph.

**The bytes live in Postgres**, in a `MenuItemImage` row, and that is the same
trade as choosing not to send error reports to Sentry: it works on the first
deploy, with no bucket to create, no credentials to rotate and nothing handed
to a third party. What is given up is a CDN edge, which for tens of images
served with a year-long immutable cache is not yet a cost. What IS a cost is
that the database backup gets bigger, so `/admin/health` shows the count and
the megabytes next to the backup size — "why did the dump grow" should be
answerable before it is a surprise.

The seam is one route handler wide. Everything above it knows a photo by its id
and asks for it at `/menu-images/<id>`; only `lib/media/menu-images.ts` and
that route know where the bytes are, so object storage later is an adapter
rather than a migration.

**Nothing the browser said about the file is believed.** `lib/media/image-bytes.ts`
reads the type from the magic bytes and the dimensions from the header — a
PNG's IHDR at a fixed offset, a JPEG's start-of-frame after walking past the
EXIF and ICC segments a phone puts in front of it. A declared `image/jpeg` on
an executable is a sentence anybody can write; the `contentType` stored is one
this application decided, and the route serves that with `nosniff` so the
browser cannot decide otherwise either. SVG is refused: it is a document that
can carry script, and served from our own origin it would be a stored
cross-site script.

**Resized in the browser before it is sent**, to 800px on the long edge. Two
reasons, and the second is the real one:

- A camera photo is three to six megabytes and a server action's body limit is
  one, so the upload would fail before any of our code ran.
- 800px is twice the width of the phone screens this is for, and it lands
  around 15–90 KB. Storing the original and letting an image optimizer produce
  sizes would cost a shop's customers about 150 KB per dish on a connection
  they pay for by the megabyte — to render a photograph that is 72 pixels wide
  on the menu.

That resize is a convenience, not a check: the limits are enforced on the bytes
that arrive, because anything running in a browser is something its owner can
change.

**A replacement is a new row with a new id**, deliberately. The obvious version
— upsert, keep the id — would leave every browser holding the OLD photograph
under a URL marked immutable for a year. Deleting and re-creating means the URL
changes, which is what makes that cache header safe; the old URL 404s, and a
test in a real browser checks exactly that.

**Plain `<img>`, not `next/image`.** The file was already sized for its use and
is served immutable, so the optimizer would re-encode it into a cache directory
this container does not have, by fetching our own route from our own server
while it is answering a request — and it would make the storefront's
photographs depend on `sharp`, which is present here as a transitive
dependency of Next rather than one this project declares.

**Nothing is rendered where there is no photo.** Most menus start with none, and
a column of grey placeholders makes a text-only menu look broken rather than
plain.

### Add-ons: a menu-side model, and prices the browser cannot argue with

`FoodItemSnapshot.options` — a chosen option's name and what it added, written
onto the order — has been in the schema since the first version, and placement
has always stored it. What did not exist was any way for a shop to say what the
choices ARE, so the field could only ever be empty. Notes here said "modelled
but no UI"; that was wrong, and it needed a table before it needed a screen.

**The grammar is two numbers.** A `MenuItemOptionGroup` is a question with
`minChoices`/`maxChoices`, and a `MenuItemOption` is an answer with a price
delta. Two settings cover every real menu: **(1,1)** is "pick a size" — which
cannot be skipped, so an order never reaches a kitchen without saying which one
— and **(0,n)** is "any add-ons you like". (2,3) is legal because "choose two
sides" is a real thing; what is refused is a group nobody can satisfy, which is
the one mistake here a customer would meet as a dead end.

**A delta is zero or positive.** "Without rice, ten pesos less" is a different
dish at a different price, and the honest way to sell it is a second menu item,
which a shop can now create in three taps. Keeping the money one-directional
means a line total can never be argued down by a choice and there is no floor
to defend. The form says exactly that when somebody types a negative number —
and the parser catches the minus sign itself, because the generic number
parser would otherwise answer "write it like 15 or 0" to a shop that wrote
precisely that with a minus in front.

**Where the price is decided.** `resolveChoices(groups, ids)` takes ids and
returns priced choices, never the other way round. The store page runs it to
show a running total; `quoteCheckout` runs it again against rows read through
the menu item — so an option id belonging to another dish, or another shop, is
simply not in the result and is refused rather than priced. Four refusals, each
with its own message because each has a different fix: not on this dish (a
stale page), run out (choose something else), too few (answer the question),
too many (pick one). Choices come back in the order the shop arranged them, so
two customers who picked the same things get identical snapshots and a kitchen
printout reads the same way every time.

**The cart line is the dish plus its choices.** `cartLineId(menuItemId, ids)`
is sorted, so the same choices made in a different order are the same line —
and Large is never merged into Regular by a stepper. The id is **branded** at
the type level (`CartLineId`), because both it and a dish id are strings:
`setQuantity(menuItemId, 2)`, which is what every one of these controls did
before dishes had choices, compiles perfectly and moves the wrong line. The
brand turned that into a compile error, and it caught the mistake in this very
change.

A cart still carries no prices — not for the dish and not for the choices. It
carries ids, and that is the whole reason a customer editing their own
localStorage changes what they see and not what they pay.

**A dish that asks nothing is untouched.** One-tap Add and a stepper, exactly
as before: that is most of a carinderia menu, and it should not get slower
because some other dish has sizes.

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

## Payments — a second ledger, and the rule it exists to protect

Every order used to be cash on delivery. It still can be, and most will be —
but riders carrying a shift's takings is the largest operational risk in the
business, and the way to reduce it is to let customers pay before the food is
cooked.

### The rail that needs no provider account

The prepaid rail is a **transfer the customer makes themselves**: they send the
total in GCash, Maya or their bank, put the order number in the note, and type
the reference back into TARA. Somebody with access to the receiving account
checks it at `/admin/payments` and confirms. Only then does the order reach the
shop.

That is slower than a webhook and it is chosen deliberately:

- **A provider account needs the paperwork.** PayMongo or Xendit onboarding
  wants DTI or SEC registration and BIR registration, which are still open
  items on the launch checklist. This rail needs a phone number.
- **No per-transaction fee**, against a margin that is one delivery fee.
- **It is how a great many small Philippine businesses already take money**, so
  it needs no explaining to either side.

What it costs is a person's attention, once per order, and it does not scale
past the volume one person can check. `src/lib/payments/rails/` is the seam for
a provider rail when it starts hurting; `begin()` returns a discriminated union
so a hosted redirect is a second arm rather than a rewrite. The `HostedRedirect`
arm is declared and unused on purpose — it documents what a provider rail must
supply. **No webhook verifier ships until something calls it**: this codebase
has now been bitten three times by machinery that was designed, committed and
never wired up.

### `PaymentEvent`: the credits ledger's twin

Money gets a history, not a status column. `Order.paymentStatus` is a **derived
cache** of an append-only `PaymentEvent` table, computed by
`derivePaymentStatus()`, exactly as `Wallet.balanceCentavos` is a cache of the
credits ledger. Same guards, for the same reasons: an append-only trigger, a
CHECK constraint forcing the sign from the event type, a mandatory reason on the
two events a customer reads, and one function — `recordPaymentEvent` — that
every write goes through.

Seven event types, and the split that matters is between **claims and money**:

| Moves nothing | Moves money |
| --- | --- |
| `CHARGE_REQUESTED`, `CHARGE_SUBMITTED`, `CHARGE_REFUSED`, `CHARGE_EXPIRED` | `CHARGE_CONFIRMED`, `CASH_COLLECTED` (in), `REFUND_ISSUED` (out) |

A customer saying they have paid is not money arriving, and the gap between
those two is where a payments bug lives. `signedPaymentAmount` refuses to
attach an amount to a claim at all.

`derivePaymentStatus` reads **money first, intent second** — so a refusal
followed by a good payment is PAID, and a customer refused once who sends a
corrected reference is back in the queue rather than stuck at FAILED.

### The two ledgers are separate tables, and that is the point

Credits are an internal balance we grant and only orders can spend. Payments are
real money arriving from outside. There is **no schema path** from a confirmed
charge to a credits row, which is what makes "cash can never become credits"
checkable rather than a convention.

`REFUND_DESTINATION` states it per instrument: credits refund to credits, and
everything else refunds to the instrument it arrived on. The temptation is real
and convenient — a cancelled transfer is much easier to settle as credits, and
a customer might even prefer it — and it is still a path from cash to spendable
balance. Pay ₱500, cancel, keep ₱500 of credits: that is a top-up, and the
whole credits design promises there isn't one.

Enforced at both ends, because application code is one deployment away from
being bypassed:

- `recordRefundToSource` refuses an order whose instrument is credits.
- The database refuses a credits `REFUND` row for an order that never spent
  credits — and a transfer-paid order has no `ORDER_PAYMENT` row, so it has
  nothing to return.

The rule is per **portion**, not per order, because an order can use two
instruments: credits covering part of a total and a transfer covering the rest.
There is deliberately no single method-level guard — it would have read the
order's headline method and refused to return credits genuinely spent on a
part-transfer order.

### A prepaid order is not an order until it is paid

`PENDING_PAYMENT` had been in `OrderStatus` since the schema was written, with
the right edges in four of the five lifecycles, and **nothing ever used it** —
the third such find in this codebase. It is now what checkout parks a prepaid
order in, and RIDE has the edge the other four already had. (Prepaying matters
*most* for a ride, where the alternative is arguing with a passenger at a kerb.)

The wait is twenty minutes, declared once and spread into every lifecycle so
four cannot drift from the fifth. It is longer than the eight minutes a shop
gets to accept, because the customer's leg involves leaving the app.

**The timeout only fires while nothing has been claimed.** `StatusTimeout`
gained a `whilePaymentStatus` field for this: a customer who sent the money and
gave us a reference has done their part, and cancelling their order because we
were slow to check it is not a timeout, it is a bug with a clock attached.
Which is why `CLAIMED` is its own payment status rather than PENDING — and not
`AUTHORIZED` either, since in payments that word means an issuer approved the
funds and anybody can type thirteen digits into a box.

A short payment is `AUTHORIZED`: money arrived, less than the total, so the
order keeps waiting and the customer is told what is missing. Calling ₱300 on a
₱324 order PAID leaves a shop out of pocket.

### What the rider is told

`cashToCollectCentavos` answers one question, and it is the most consequential
line of UI in the feature: **is there money to collect at this door.** It is
not "is the method cash":

- A confirmed prepaid order shows **"Already paid — do not ask for money"**, or
  a rider asks somebody to pay twice.
- A prepaid order that was never confirmed **still collects in cash**, or a
  rider hands over food for nothing. A customer's word is not money in the
  account, and the rider cannot be the one who finds out.

It is a band of colour above the addresses, with the amount, because a rider
reads that screen at a kerb with a helmet on.

### When an order dies

`settleCancelledOrder` handles both halves of the money, and exists because the
previous arrangement had three call sites each refunding credits and none
noticing that a transfer-paid order has no credits to refund. The credits refund
correctly returned zero, correctly did nothing, and the ₱324 simply stayed with
us on every cancelled prepaid order.

The cash half deliberately does **not** write a `REFUND_ISSUED` row, because
that row means "money has been sent" and nothing here can send it. It tells the
customer it is coming — `PAYMENT_REFUND_DUE`, separate from `PAYMENT_REFUNDED`,
because "we owe you" and "it has been sent" are different promises — and leaves
the order in the console's refund queue until a person has made the transfer and
recorded it. That queue is computed from the ledger rather than from a flag, so
it clears itself and there is no boolean to forget to set.

### What is NOT built

**Settlement.** Money paid in advance arrives with us, not with the shop, and
nothing here pays a store or a rider out. That needs a bank arrangement and the
business registration, and it is the next real piece of work behind this one.
Each payment records which order it was for, so what is owed is computable —
but computing it is not paying it.

## Settlement — the third ledger, and who is holding whose money

Payments answered "did the customer pay". Settlement answers the question
behind it: **the money is now somewhere, and it belongs to somebody else.**

### Every centavo belongs to exactly one party

`splitOrderValue` divides an order's GROSS value three ways:

| Share | What it is |
| --- | --- |
| Store | the food subtotal, less commission |
| Rider | the delivery fee and the whole tip — from `partnerEarningsCentavos`, the same function the fleet screens show a partner |
| Platform | **the remainder** |

The platform getting the remainder rather than its own formula is the whole
trick: it makes the split exhaustive by construction, so a fee added to the
schema next year cannot belong to nobody. On top of that the function asserts
its own result — the three shares must sum to the gross, and **none may be
negative**. That last clause was added because a sum can balance while a part
is negative: pay a rider more than the order is worth and the platform silently
absorbs the difference. The remainder never complains, which is exactly why it
has to be checked.

**The gross, not `totalCentavos`.** A subscription waiver, a promo and credits
spent all reduce what the customer pays without reducing what the shop cooked
or what the rider rode. TARA absorbs the difference, and settling on the total
would take that absorption out of a partner's pay. `platformNetCentavos` is
allowed to go negative, because a heavily promoted order really is a loss and a
clamped number is a loss nobody can see.

**Commission is data, and zero by default.** Per store, in basis points,
settable from the console with a reason and an audit row. Zero because a
non-zero default would have invented revenue the moment settlement was switched
on and quietly changed what every existing shop was owed. It applies to the
subtotal only — never the tip, which is the rider's entirely, and never the
delivery fee. Rounded DOWN, so a fraction of a centavo stays with the shop:
over thousands of orders that costs TARA a few pesos and can never be described
as shaving money off a partner.

### The direction depends on who physically collected

This is the part that makes settlement a ledger rather than a list of earnings.

A ₱399 cash order: the rider takes the **whole total** at the door — the shop's
money and ours along with their own ₱39 fee. So:

```
earnings   +₱39
collected  −₱399
           ------
balance    −₱360    the rider owes TARA
```

The same order paid by transfer leaves TARA holding it, so TARA owes the rider
₱39 and the shop ₱350. Same ledger, opposite sign. `COLLECTED_BY` is keyed by
every payment method, so a new instrument is a compile error rather than a
default that puts somebody's money in the wrong pocket. Credits count as
PLATFORM: nothing was collected from anybody, and the shop and rider are still
owed real money — which is what a credit costs, recognised at redemption.

A balance is **what TARA owes the partner**: positive we owe, negative they are
holding ours. Most riders will sit negative most of the time, and that number —
totalled as "cash held by riders" in the console — is the float the launch
checklist called the operational problem most likely to bite in week one.
Nothing in the app knew it before this.

### `SettlementEntry`: append-only, like the other two

The third ledger and the same discipline: append-only trigger, sign forced by
type, one write function (`recordSettlementEntry`), a reason or reference
required wherever a human decided something. Five entry types —
`ORDER_EARNINGS`, `CASH_COLLECTED`, `PAYOUT_SENT`, `CASH_REMITTED`,
`ADJUSTMENT` — and the last one exists because the real world produces cases no
rule anticipated: a rider who paid a shop directly to keep an order moving, a
damaged order somebody absorbed. The alternative to an audited adjustment is
either a ledger somebody edits (the database refuses) or a balance nobody can
reconcile.

**The balance is NOT cached**, unlike a credits balance, and the difference is
worth stating because somebody will want to "make it consistent". `Wallet`
caches because spending must check a balance atomically on the hot path of
every checkout. Nothing here is blocked that way, so a summed query beats a
column that can drift from the rows that define it. One thing does check it — a
payout — and it reads the sum inside its own serializable transaction.

Accrual happens **inside the completion transaction**, keyed idempotently to
the order and the party. An order that completed with no accrual is a shop that
cooked food nobody recorded owing it for, and the only way to find those later
is to trawl every order against the ledger. A cancelled order accrues nothing:
nobody delivered anything.

### Nothing in this app moves money

Every control records that a **person** moved it: a payout, a cash handover, a
correction, each with a name, a reference and a reason. That is the same posture
the customer refund control takes, and for the same reason — a button that
looked like it paid somebody would be the most dangerous thing in the console.
The rider's and shop's own screens say so too, because a partner who expects
the app to pay them will not chase a payout that never arrives.

A payout **cannot exceed the balance**. Paying past what is owed is an
unrecorded loan the next accrual silently swallows, and on a rider who is
holding our cash it would be handing money to somebody already in debt to us.

### What settlement does NOT do

- **No bank rail.** No provider, no scheduled payout run, no API. Recording
  only.
- **No commission snapshot on the order.** The rate is read from the store at
  accrual, so an order completed a week late accrues at today's rate rather
  than the rate on the day it was placed. A snapshot column would fix it and is
  not worth a migration while every rate is zero.

## Surge belongs to the rider

Surge used to fall to the platform. Not by decision — `partnerEarningsCentavos`
counted the fee and the tip, and the settlement split gives the platform
whatever is left over, so surge went there by omission. Settlement is what made
that visible, and this is the decision taken once it was.

**Surge exists to get somebody to accept a job in bad weather or at 2am.**
Surge that reaches the platform instead of the rider is a price increase with
no incentive attached: the customer pays more and nobody is any more willing to
ride. Paying it to the rider is the only version that does what the fee is
named for.

The change is one line in `partnerEarningsCentavos`, which is the point of
having a single definition — the fleet screens, dispatch offers and settlement
accrual all followed from it, and **the split needed no edit at all** because
the platform takes the remainder. That is the remainder design paying for
itself.

### The trap it walked into

Every screen showing a rider their finished jobs was RECOMPUTING earnings from
that function. So the moment the rule changed, every job the rider had ever
done silently restated itself — a figure that was never accrued and never paid.

That is the settlement ledger's own failure mode arriving from the opposite
direction: an app promising one number and settling another.

The fix, in `settlement/earnings.ts`: **for a settled job the ledger is the
truth**, because it holds what was accrued under the rule in force at the time.
The rule is consulted only for jobs that have not settled yet — where quoting
it is exactly right, since it is what the rider is about to be paid. A fallback
covers orders completed before the ledger existed, and is safe only because no
order carries surge, so the old rule and the new one agree on every one of
them.

The general lesson, worth more than this feature: **a derived money figure that
is recomputed on read is a figure that rewrites itself whenever the formula
changes.** Store it when it is decided, or read it from where it was stored.

A near-miss in the same place: the query behind a rider's today/week totals
selected only the fee and the tip. Once surge became the rider's it would have
been missing from those totals while appearing on the job list — two figures on
one screen, disagreeing.

### What sets surge

The rule this section once said was missing. Nothing about the paragraph above
changed: surge still goes entirely to the rider, and the split still needed no
edit. What follows is the decision about **when** and **how much**.

## Surge pricing — a fee that has to be explainable

Surge is the only number in this app that goes UP on a customer who did nothing
except open the app at a busy moment. That makes it the number most likely to
be experienced not as pricing but as the app inventing a figure, and every
decision below follows from one requirement: a customer who asks *"why is it
₱79 instead of ₱49?"* gets an answer, and gets the same answer twice.

### Steps, not a multiplier

A continuous 1.3× moves the fee on every page refresh. A customer sees ₱43.17,
then ₱44.02, and concludes the price is being made up — which, from where they
are standing, is indistinguishable from what is happening. A **step** is a flat
peso amount with a name — "Busy, +₱20" — that holds still while the market
wobbles underneath it.

Steps live in `SurgeBand`: a service, an optional city, a threshold in orders
per available rider, an amount, and a label the customer reads. The keying is
`DeliveryFeeRule`'s, one layer up: a city's steps win **entirely** over the
national fallback, never merged, because half of one ladder and half of another
is a ladder nobody designed and a price no operator could predict from either
screen they configured.

### Off unless somebody turned it on

**No `SurgeBand` rows means no surge.** Not a default multiplier of 1.0 — no
mechanism at all. Surge is a policy decision about a particular market, and the
code has no business having an opinion by default. Same posture as commission
starting at zero.

There is also deliberately no way to configure a step that adds ₱0: the console
refuses it and so does `surge_band_step_sane`. That is what makes "off"
unambiguous — surge is off where no step exists or every step is switched off,
and never because a step quietly adds nothing.

### Measured on a schedule, not per quote

Counting the dispatch queue inside a quote means the checkout screen and the
placement a few seconds later can disagree, and the customer is shown one price
and charged another. So the maintenance sweep measures the market once a minute
and writes a `SurgeSnapshot`; **quotes read the newest snapshot and never
count anything themselves.**

Three things fall out of that, and all three are the point:

- The number on the screen and the number charged are the same number, because
  `placeOrder` re-quotes through the same `quoteCheckout` that rendered it.
- There is no client input to tamper with — the price comes from a row the
  customer cannot reach.
- Every charge stays explainable from its stored inputs. A complaint about a
  fee at 6pm is answered from the snapshot rows, not from what the market
  happens to look like when somebody gets round to reading the ticket.

The ratio is orders in `AWAITING_RIDER_ASSIGNMENT` divided by riders who are
online, approved for the service, not suspended and not already carrying a job.
Two of those groupings are choices worth naming. An order's city is its
**pickup** city — a rider is drawn to a job by where it starts, and the fee rule
surge is added to is already keyed on the store's city. A rider's city is their
**home** city, which is a compromise: live coordinates say where they are this
minute, but a rider between jobs may be anywhere and a rider with no fix would
vanish from the count entirely — and a count that omits available riders
overstates the pressure and overcharges the customer.

Zero riders is deliberately **not** treated as "no market, no surge". One rider
with eight orders queued is at the ceiling; if that rider ending their shift
took the surge to zero, the price would fall at the exact moment the wait got
longest. So with no riders each waiting order counts as its own unit of
pressure, which is continuous with the one-rider case. An empty market — no
orders, no riders — is still zero, which is the honest reading of 3am.

### Every uncertainty resolves to not charging

No bands, no snapshot, a snapshot past the five-minute window, a snapshot from
the future, a step capped to nothing: all of them are ₱0. The failure mode of
this feature is "we missed a chance to pay riders more", never "we billed
somebody for a market condition we could not confirm".

Five minutes is four missed sweeps. Past that the reading describes a market
that has moved, and a surge nobody can still observe is indistinguishable from
an invented one.

### Monotonic by construction

Among the steps whose threshold a ratio has met, `selectBand` takes the
**largest amount**, not the highest threshold. Those are the same answer for
any ladder that climbs, which is every ladder anybody means to write. They
differ only when one is mistyped — 1.5 → ₱30, 2.0 → ₱10 — and there the
difference matters: highest-threshold-met would charge a busier market *less*,
so a customer watching the queue grow would watch the price fall, and no screen
could explain it.

The cost is that a mistyped high step cannot be undercut by adding a lower one;
it has to be corrected. `firstDescendingStep` exists so the console can point
at the mistake, on the market table and again when the step is saved.

### Never more than was shown

A snapshot can roll over between rendering checkout and tapping the button. The
alternative to handling that is charging the higher figure, which is the one
thing this whole arrangement exists to prevent. So `CheckoutInput` carries
`acceptedSurgeCentavos` — the surge the screen displayed — and placement
refuses with `SurgeChangedError` if the fresh figure exceeds it. The screen
re-quotes on that refusal, so the customer is looking at the new total before
they try again.

It is a client-supplied number and is treated as one: **never used as a price,
only compared against the figure placement independently looked up.** The only
thing a tampered value can do is cause a refusal — sending a lower figure than
the real one buys an error, not a cheaper order. A surge that *fell* is charged
at the lower amount without comment.

### The charge and its reason travel together

`Order.surgeLabel` is copied from the band at placement rather than looked up
later, because a receipt has to stay readable after the bands are edited and
after the snapshot it was priced from is gone. "Surge ₱20" with no reason is
exactly the unexplained fee the labels exist to prevent, and the only moment
the reason is certainly available is the moment the charge is made.

Two CHECK constraints enforce the pairing — `order_surge_has_a_reason` and
`surge_snapshot_surge_has_a_reason`, both spelling `(surge = 0) = (label IS
NULL)`. Money with no name means something wrote a surge without going through
the quote; a name over ₱0 means a screen saying "Busy" above nothing.

### Capped in SQL

One step may add at most ₱100 (`SURGE_CEILING_CENTAVOS`, mirrored by
`surge_band_step_sane` and asserted equal by a test). Deliberately below the
₱250 fee ceiling the seed ships: a surge larger than the whole fare is not a
busy Friday, it is a decimal point in the wrong place — someone typing `1000`
meaning ₱10. The constraint cannot know which, so it refuses the row and
somebody reads the error. `capSurge` clamps again in the arithmetic, so a step
saved before the ceiling was lowered cannot escape it.

### One bug this found

`currentSurge` originally bounded its query with `createdAt >= now - window` —
fast, and wrong. An aged-out snapshot simply did not match, so the rule saw
`null` and answered `NO_SNAPSHOT`: *"the market has not been measured yet"* for
a market that had been measured all day until the cron died. The one failure the
console exists to reveal, reported as its opposite — and it made the `STALE`
branch dead code in the only path that reaches it.

The bound bought nothing anyway. `@@index([serviceType, cityId, createdAt(sort:
Desc)])` makes "newest row for this market" a single index seek at any table
size. Found against the real database; the console now shows Manila charging,
Quezon City **stale** and Makati **no snapshot** as three different states,
which is the distinction an operator needs.

### Telling people about it

Surge that nobody is told about is a price rise with no incentive attached: the
customer pays more and no more riders come out, which is the failure the fee is
named against. So the notifications are not decoration on this feature — they
are the half that makes it do its job.

Two messages, to two audiences, shaped by opposite concerns.

**To riders, the danger is noise.** The market is measured every minute, and
almost none of those minutes are news. A feature that notified on every
measurement would send sixty pushes an hour to every rider in a city, and the
result is not an informed fleet but an app whose notifications everybody has
switched off — including the ones saying an order is waiting. Four filters turn
a continuous measurement into the small number of moments a person wants:

- **Only a step UP.** Surge appearing or climbing is news. Unchanged is not.
  Falling is not, and is deliberately silent: a rider invited by "₱40 extra"
  who arrives to ₱20 was misled by a message that was true when sent, which is
  worse than never sending it.
- **Only riders who are OFFLINE.** An online rider is already in the dispatch
  loop and their offers carry the surge inside the earnings figure; a second
  message says nothing their own screen does not. The supply surge is meant to
  reach is the rider who has closed the app.
- **A 45-minute cooldown per market per rider**, checked against the
  notification table itself rather than a `lastAlertedAt` column — the record of
  what somebody was told is the right place to ask what somebody was told, and a
  column would be a second truth that can disagree with the inbox.
- **Never in quiet hours**, which needed a new idea; see below.

**To administrators, the danger is silence.** A market pinned at its top step
for forty minutes has been offered everything the ladder has and is still
short. From the pricing screen that looks like surge working. `SURGE_SUSTAINED`
says it in as many words — that this is understaffing rather than a spike, and
a higher step will not fix it — so nobody spends the evening adding one. Once
per market per four hours, so a bad night is one message rather than nine.

### Perishable: the one kind that is dropped rather than deferred

Every other notification in the system describes something that HAPPENED — an
order was cancelled, a payment cleared, a rating arrived — and quiet hours
therefore DEFER an informational push to 6am, because those read no differently
over breakfast.

"It is busy right now, come out" is not like that. Held overnight it does not
become late, it becomes **false**: a rider who gets up for a surge that ended at
midnight has been lied to by the app, and will read the next one as noise. So
`KindPolicy` gained `perishable`, `deliverableAt` gained the ability to return
**null** meaning never, and the delivery row is written `EXPIRED` — a status
distinct from `SKIPPED`, because "they muted this" and "we decided it had gone
stale" are different facts and only one of them means somebody chose not to
hear it.

The same flag covers the other way a message goes stale: the delivery pass
drops a perishable row that has waited longer than `PERISHABLE_MAX_AGE_SECONDS`
(the same five minutes the snapshot itself is trusted for). That is what stops a
sweep which was down for twenty minutes from coming back and telling two
hundred riders about a rush that is over.

What quiet hours remove is the interruption, not the information: `IN_APP` is
always-on, so the message is still in the inbox for a rider who opens the app
at 2am of their own accord.

Marking it `OPERATIONAL` would have pushed it through the night, and that is the
wrong outcome rather than a bolder one. Nothing waits on this particular rider —
the orders go to whoever is online and the surge is paid to them — so an
invitation to work at 2am is not the app's decision to make for somebody who
chose to be offline.

### One switch, and why it is not a channel

`FleetPartner.wantsBusyAlerts` is the only per-KIND preference in the app.
`NotificationPreference` is keyed by channel, so declining an invitation to work
through it would also mute "an order is waiting for you" — those are not the
same consent. A general per-kind table would have exactly one row worth setting,
because this is the only kind that asks somebody to do something.

On by default: a rider who has not thought about it is better served knowing
tonight pays more, and one tap turns it off. The switch's copy says what it does
NOT change, because "stop telling me about surge" reads as "stop paying me
surge" to somebody scanning it, and a rider who believes that will never touch
it. The busy panel stays on their offers board either way.

### The alert nobody can write

There is no "the sweep has stopped measuring" notification, and there cannot be
a useful one: **the thing that would detect it is the thing that stopped.** An
alert written from inside the sweep to announce that the sweep is not running is
a check that can never fire. That failure is covered where it can be — the
banner on `/admin/surge`, which is honest about being visible only to somebody
who opens it — and properly belongs to whatever watches the cron from outside.

### Three bugs the verification found

**Switching the last step off kept charging.** Deactivating a city's only band
removed the pair from `pairsToMeasure`, so no further snapshot was written, so
the newest snapshot stayed at ₱50 with its label — and `currentSurge` reads the
newest snapshot, which was still inside the freshness window. Customers went on
paying a surge an operator had just switched off, for up to five minutes, while
`/admin/surge` said "no steps anywhere, surge adds nothing to any order". The
screen and the till disagreeing is the exact failure this feature is arranged
against. A market whose newest reading is non-zero is now measured even with no
ladder, which writes one zero row and then drops out of the list.

**A ladder change rewrote history.** `sustainedRun` counted readings at-or-above
the ceiling, so switching the TOP step off — dropping the ceiling from ₱50 to
₱20 — made every older ₱50 reading count as being at the new ceiling. The run
stretched back through a ladder that no longer existed and the alert announced a
city had been short of riders for 765 minutes. Comparison is exact now: a
reading taken under a different ladder is not evidence about this one.

**The two passes used two clocks, and nobody was ever told anything.** The sweep
called `recordSurgeSnapshots()` and `sendSurgeAlerts()` with separate `new
Date()` calls, milliseconds apart. `previousReadings` asks for the newest row
with `createdAt < now`, so the alert pass's slightly later instant included the
row the sweep had just written: the previous reading WAS the current reading,
no market ever looked changed, and not a single alert was sent. Every unit test
passed. The live-database check passed too — because that harness helpfully
passed one clock to both, and so tested a wiring that did not exist. It was
found in a browser, watching a sweep print no alert line. `recordSurgeSnapshots`
now returns the instant it stamped and the alert pass takes it, so the two agree
by construction.

The lesson is the one this codebase keeps relearning in new clothes: a test
harness that is more careful than production tests the harness.

### The console

`/admin/surge` answers two questions that look like one. *How busy is it?* is
measured live on load, because a screen may move — nobody is billed from it.
*What is a customer being charged?* comes from the newest snapshot, the
identical read a quote does.

Showing them side by side is the point. When the live ratio has earned ₱40 and
the charge column says ₱0, exactly two things can be true: the market moved in
the last few seconds, or the sweep has stopped and surge has quietly switched
itself off. The second is invisible from anywhere else in the app, precisely
because every uncertainty here resolves to charging nothing — the right default,
and a silent one. Hence the "last measured" stat and an alert when it is older
than the window.

The console lists cities with **no** ladder as well, which is wider than what
the cron measures: the sweep skips pairs with no bands, since a snapshot for one
would be a zero written every minute, but an operator deciding *where* to add a
step needs to see exactly those markets. Adding, editing and switching a step
each demand a reason and write their own `AdminAction`, and activation is
audited separately from amounts because *"was surge on in Manila at 6pm?"* is
the question a complaint actually asks and it should be answerable without
reading a diff.

## Loyalty points — a fourth ledger, and why it is not a second currency

### The question worth asking first

This app already grants credits, and a credit-back benefit already exists. So a
points programme could easily be a second currency doing the first one's job
with extra steps — two balances for a customer to reason about, two liabilities
to reconcile, and the wallet's "one write function, the ledger is the truth"
discipline needing to hold twice.

Two things make it not that.

**Credits measure what you can spend; points measure what you have ordered.** A
peso balance cannot express "you are two orders from Tapat", and a status band
cannot be paid out. That distinction is what the second ledger earns.

**And credit-back is a Plus benefit.** Plus is priced but still cannot be sold,
because a subscription needs a recurring charge and a bank transfer somebody
makes by hand is not one. So today a customer who orders every week and is not
paying earns nothing at all for it. Points fill exactly that gap, with no
payment rail.

### Points are not spendable

The decision that keeps this from confusing anybody: **points buy credits, and
credits buy food.** There is exactly one balance a customer can spend, and it is
the one that was already there. Points are a thing you convert, not a second
wallet to reason about at the checkout — and nothing loyalty-shaped appears in
`place-order.ts` or `checkout.ts` at all, which a test asserts.

### What a tier changes, and what it must not

A tier changes the earn rate. Nothing else.

The temptation is to make Tapat waive delivery. This app already has three ways
to reduce a bill — the fee rule's own free-delivery threshold, Plus benefits,
and promo discounts — and each interacts with the others inside
`applyBenefits`. A fourth would have to interact with all three, and would put
loyalty arithmetic in the checkout path where a bug costs somebody the wrong
price. A tier that earns faster compounds the thing the programme is for and
touches nothing near a bill.

Tiers are calculated from points **earned in a rolling window**, not from the
balance and not from lifetime totals. Not the balance, because redeeming must
not demote somebody — spending points is the behaviour the programme rewards,
and punishing it teaches people to hoard and then teaches them the programme is
a trick. Not lifetime, because a tier nobody can lose is not a reason to order
again.

### Earning: the food only

Points accrue on the **subtotal** — never the delivery fee, surge or tip, which
are the rider's money. Rewarding a customer in proportion to what we paid
somebody else is both odd and gameable: a distant address would earn more than a
near one for the same food. It is also what a customer means when they say what
they spent.

Rounded **down**. A customer a point short never notices; one given a point they
had not earned makes the balance disagree with the rule that produced it, and
rounding up across a million orders is a cost nobody chose.

Earning happens on completion, inside the same transaction as the settlement
accrual and the referral reward, keyed `loyalty-earn:<order id>` so a retried
completion earns once. The tier is read at that moment and never again — the
lesson `settlement/earnings.ts` learned about rider pay: a derived figure
recomputed on read is one that rewrites itself whenever the formula changes.

### Redemption: the only place a customer causes credits to exist

A referral needs somebody else to sign up and order. A promo needs an
administrator to type a reason. A refund needs an order that went wrong. This
needs one tap by the person who benefits, which makes it the sharpest version of
that risk in the app.

So it is written to be exact:

- **One transaction at SERIALIZABLE**, with the points balance read from the
  ledger inside it. Two taps racing at a balance of 500 must not both succeed —
  and a live-database check runs exactly that race and asserts one winner.
- **`loyalty_account_balance_non_negative`** underneath, as the backstop that
  does not depend on the application being right.
- **The two rows name each other.** `loyalty_entry_redeemed_names_its_credit`
  requires the link, and `loyalty_entry_only_redemption_has_credit` stops
  anything else claiming one — an EARNED row pointing at a credits transaction
  would mean points had been paid out twice.
- **Credits through `recordWalletTransaction`**, the wallet's own write
  function. Not a second path, not a balance field.
- A serialization failure re-reads rather than guessing: answering "not enough
  points" to somebody who still has some would be a lie.

**Whole blocks only.** Without them a customer with 1,437 points at 100 points
to the peso redeems ₱14.37 and holds 37 points that will never be worth a
centavo — dust, which every loyalty programme accumulates and nobody enjoys. A
part-block is refused explicitly rather than silently floored: somebody asking
for 700 of a 500-point block should be told, not quietly given 500 and left
wondering.

The console shows how many accounts hold a **stranded** balance below one block,
because a large total there means the block size is too high and the programme
is quietly not paying out — which customers notice long before a dashboard does.

### Expiry: the one thing credits do not do

Credits, by design, never expire. Points do, and that is the only mechanism
bounding what this programme can come to owe — a liability that grows fastest
among the customers who have stopped ordering, which is the worst possible shape
for it.

The hard part is that redemptions are not attributed to particular earnings. A
customer who earned 300 in January and 300 in March, then redeemed 500, holds
100 — but *which* 100? It has to be the newest, because the alternative punishes
prompt redemption: their remainder would expire on January's clock. So spending
consumes the **oldest** earnings first, and only what is left below the cut-off
expires. `livePortions` walks that netting, in one place — an earlier version
had the loop written out twice, once for "what has expired" and once for "what
expires next", which is two chances to net differently and no way to notice.

The customer is warned **before** it happens. A balance that quietly shrank is
indistinguishable from a bug; one that was flagged can be spent.

### The number the console exists for

`liabilityCentavos`: what the outstanding points would cost if everybody
redeemed tomorrow. Points are an obligation denominated in the operator's money,
and that figure is two rates away from the point count — earning is points per
peso spent, redemption is points per peso back — so it is easy to get wrong by a
factor of ten and invisible until somebody adds up the ledger. The screen also
states the **effective giveback** as a percentage, for the same reason, and warns
when no expiry is configured that the figure can only go up.

### Two bugs worth recording

**The tier holder counts were the same wrong number, repeated.** The console
counted holders with a query per tier, and a spread that duplicated the
`entries` key made every query identical — so the column showed one figure down
its whole length, which reads as data rather than as a bug. It is now one
`groupBy` over the window's earnings, bucketed through the same `tierFor` the
customer's own screen uses, so the two cannot disagree about who is what.

**Redeeming told the customer nothing.** The redeem control rendered only when a
redemption was available, with the page showing a "you need 300 more points"
line otherwise. So a successful tap dropped the balance below one block, the
refresh replaced the control with that line, and **the success message went with
it** — points moved, credits moved, and the screen said nothing, which is
indistinguishable from a tap that failed. Found in a browser. One component now
owns both states, so its confirmation survives the thing it is confirming.

## Referrals — the only credits a user can cause

Every other credit in this app is granted because an order completed or because
an administrator acted against their own name. A referral is the one path by
which credits come into existence **at the invitation of a user** — which makes
it the one place where a stranger with a drawer of SIM cards can make money
appear, and why nearly all of it is refusals.

### What actually stops abuse, and what only looks like it does

The obvious attack is self-referral: one person, an account per SIM. A
`referrerId <> refereeId` check catches the naive version and nothing else. Two
accounts held by one person are, to the database, two people, and there is no
honest way to tell them apart here: phone numbers are cheap, no device identity
is held, and address matching would refuse mostly-honest cases, because
households in the Philippines routinely share an address and a feature that
accuses a mother and her daughter of fraud is worse than one that pays them
both.

So the defence is not detection. It is three structural facts:

1. **The reward is credits**, and credits cannot be topped up, transferred or
   cashed out — they only reduce a future bill. A farmer's payoff is discounted
   food, not money. This is the wallet constraint doing work it was not written
   for.
2. **The inviter is paid only when the referee's first order COMPLETES**, above
   a minimum order value. Farming costs a real order that was really paid for
   and really delivered.
3. **Caps**, per month and for life, per inviter. This is what turns an
   open-ended liability into a budget, and it is the only mechanism that works
   without needing to know who anybody is — an enthusiast and a farmer look
   identical for the first three referrals.

### The number the console shows, and why

Which leaves one thing that decides whether the whole feature is farmable, and
it is not the code's to pick: the amounts. So `farmerMargin` computes what a
person referring themselves nets per account at a given pair of amounts, and
`/admin/referrals` puts it on the screen — in green when self-referral costs
money, in a red alert when it pays, with the arithmetic spelled out. The
save action repeats it in its own confirmation, so the warning cannot be missed
by somebody who never scrolls back.

It is a warning rather than a refusal. A launch subsidy that loses money per
account can be a deliberate choice; buying accounts by accident cannot.

The referee credits count towards the outlay, because they do — that is what
they are for. Which is why **a generous referee reward with a low minimum is the
dangerous combination**, not a generous inviter reward alone.

### Off until somebody sets it

No `ReferralProgramme` row means referrals are off, and the invite screen says
so plainly rather than showing a code that earns nothing. Same posture as
commission at zero and surge with no bands. There is also deliberately no way
to save a live programme with a zero cap or with both amounts at zero — those
would advertise a code that can never pay.

### Attribution is a fact, not a field

One `Referral` row per referee, ever, and the three columns that say who invited
whom are immutable — enforced by the `referral_no_reattribution` trigger, which
still allows the reward columns to be filled in because that is the only
legitimate edit the row ever needs.

That is not tidiness. An attribution that could be rewritten would let a second
inviter claim an account after its first order completed, which is the whole
game. The database also refuses a payment with no qualifying order behind it, a
refusal with no reason, an amount with no timestamp, and more than one
programme row.

`NOT_A_NEW_CUSTOMER` is the refusal worth naming: an account that has already
ordered cannot be introduced, whatever link they clicked. Without it two
existing customers could refer each other and both collect — self-referral with
an extra step and no SIM cards needed.

### The code has to survive the signup it triggers

A shared link is opened by somebody with no account. What follows is a login, an
SMS round trip and an onboarding form — three navigations that all lose the
query string. So the middleware parks the code in an httpOnly cookie, and
onboarding claims it.

Three details matter. The code is captured **on the login redirect as well as on
public pages**, because the most likely shape of a shared link is a deep one
("look at this shop") which bounces before any page renders. The **first link
wins**: otherwise anybody could overwrite a pending attribution by sending a
second one, which is whoever-messaged-last rather than whoever-invited-them. And
claiming **never blocks onboarding** — a stale code, a programme switched off
since, somebody's own code: none of them is a reason a person cannot finish
typing their name.

The cookie is cleared even when attribution is refused. A code that cannot be
used will not become usable, and leaving it means every future signup on that
browser retries a dead code.

Codes are minted lazily, the first time somebody opens the invite screen. Most
accounts never will, and a column of unused codes only makes collisions likelier.

### The alphabet, and one bug worth recording

`CODE_ALPHABET` excludes O, 0, I, 1, L and S — a code is read off one phone
screen and typed into another, usually by somebody who did not choose it, and
"was that an O or a zero" is a support ticket rather than a signup.

Excluding **both** members of each confusable pair is what lets `normaliseCode`
strip rather than guess. The first version of that function was helpful instead:
it folded `0`→`O`→`Q` and `S`→`5`, reasoning that somebody typing O for Q has
misread rather than mistyped. True, and still wrong — `Q` and `5` are themselves
valid code characters, so the fold could silently turn a typo into **a different
real code** and attribute somebody to a stranger who happens to own it. The
alphabet exists to remove that ambiguity; guessing on top of it puts the
ambiguity back with a worse failure mode. A confusable now leaves the code the
wrong length, which is a dead end the person can see and escape.

### Both sides, through the one ledger function

The referee's credits land at attribution, so they can be put towards the first
order — that is the entire incentive. The inviter's land on completion of that
order, in the same transaction as the settlement accrual, keyed
`referral-referrer:<id>` so a retried completion pays once.

The minimum is tested against the order's own worth, not against what the
customer paid. Otherwise a referee could spend their welcome credits to drop a
₱250 order below a ₱200 minimum and cost their inviter the reward — a customer's
discount is not evidence about an order's size.

A referral that will not pay is settled `NOT_REWARDED` with its reason rather
than left pending forever, and the inviter is told either way. Somebody who
shared a code and watched a friend order deserves to know why nothing arrived;
an unexplained absence is how a referral programme becomes a support queue. The
reasons are also grouped on the console screen, because a minimum nobody clears
or a cap everybody hits shows up there first.

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

**Seeded plan:** *TARA Plus*, ₱99/month, `isActive: false`. Free delivery
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

### Two paths to a person, and they are not alternatives

For a long time the tables above existed and nothing read or wrote them: a
customer could not raise a ticket, and an operator had nowhere to see one. The
gap that mattered more, though, is the one a ticket system cannot close by
itself.

**A ticket needs an account. The person who most urgently needs support is the
one who cannot get into theirs** — the SIM is gone, the code never arrives, the
number now belongs to somebody else. For them an in-app form is a locked door
with a note on it.

So there are two paths:

| Who | Path | Needs |
| --- | --- | --- |
| Signed in | A ticket: a thread with a record on both sides, and a notification when somebody replies | Nothing; it works out of the box |
| Signed out | A phone number, an email address, a Facebook page | One of `SUPPORT_PHONE` / `SUPPORT_EMAIL` / `SUPPORT_FACEBOOK` |

`lib/support/contact.ts` reads those variables and **invents nothing**. A
hardcoded number nobody answers is worse than no number, because somebody will
ring it during the one hour they needed help. The phone number is validated
through the same normaliser the login uses — a mistyped one renders as a `tel:`
link that silently dials nothing, and nobody testing the happy path would
notice. Facebook is accepted over https only, and it is there on purpose: in
the Philippines a Page inbox is how most people expect to reach a business, it
costs nothing to run, and somebody with no load can still send a message.

The panel is on `/help` and `/recover`, both of which are **public routes** —
that is the whole point of them being public. `/admin/health` and
`/admin/support` report `No public channel` in red until one variable is set.
It is the only gap in this application that costs somebody their account rather
than a feature.

### The thread

`createSupportTicket` derives what it can rather than asking:

- **The subject** comes from the first line of the message when the field is
  left blank. A required subject is a form people abandon; a ticket with no
  subject is a queue row nobody can triage.
- **The vertical** comes from the related order.
- **The priority** comes from whether that order is still in flight —
  `HIGH` if it is, `NORMAL` otherwise. The rule is about *time*, not about the
  vertical: a question about the food on a motorbike right now is urgent, and
  the same question about last Tuesday is not. `URGENT` is deliberately
  unreachable from a form, because a priority a customer can select is a
  priority every customer selects. Liveness comes from the registry's own
  `terminalStatuses`, so nothing here knows which services exist.

`TICKET_STATUS_POLICY` in `lib/support/policy.ts` is keyed by every
`SupportTicketStatus`, so adding one is a compile error until somebody decides
whether it means a person is waiting. Two rules in it are worth stating:

- **`AWAITING_CUSTOMER` does not count as waiting on us.** Counting it would
  make the queue permanently red and teach whoever reads it to ignore the
  number.
- **A `RESOLVED` ticket still accepts a reply, and that reply reopens it.**
  "This did not actually fix it" is the most valuable message on any thread,
  and making somebody open a second ticket to say it is how it gets lost. The
  same rule takes a thread out of `AWAITING_CUSTOMER` the moment they answer —
  precisely the state in which tickets are forgotten.

A support reply moves `OPEN` to `AWAITING_CUSTOMER` and leaves every other
state alone. Marking something resolved is a judgement somebody makes on
purpose; an escalated ticket that de-escalated itself because an agent sent a
holding message is how a hard problem gets dropped.

`firstRespondedAt` is set once and never cleared. `updatedAt` moves whenever
anything at all changes, so it cannot answer "has anybody replied to this" —
which is the only support number that matters.

### Nobody has to notice a ticket

Two alerts, both to every administrator, both `SUPPORT_TICKET_WAITING`:

1. **When it is raised**, enqueued *inside the same transaction as the ticket*.
   There is no ordering in which somebody asks for help and nobody is told; a
   failure to enqueue rolls the ticket back, which is the right way round.
2. **When it has been waiting past `SUPPORT_RESPONSE_TARGET_MINUTES`** (two
   hours) with no reply at all, from `chaseWaitingTickets()` in the order
   sweep. `alertedAt` makes it once rather than every cron tick, exactly like a
   new error report.

Two hours, not fifteen minutes: this is one person answering tickets between
other work, and an alert that fires before a human could plausibly have got to
it is an alert that gets muted. Answered-then-quiet does not chase — it is the
*first* silence, where the customer has no acknowledgement whatsoever, that
this protects against.

The three events (raised, customer replied, still waiting) share one
notification kind and are told apart by `ticketEvent` in the context. A
customer's reply announced as "New support ticket" is how an administrator
learns to stop reading the title.

`SUPPORT_TICKET_WAITING` is **not** on SMS: the volume of this kind is bounded
by how many customers have a problem, which is exactly the number that spikes
on the worst day, and a channel that can spend money on the worst day is one
somebody switches off. `SUPPORT_REPLY` **is**, because a human typed it, so the
rate is bounded by staff time — and an answer nobody reads is a ticket raised
twice.

**The reply text never leaves the app.** The notification carries the ticket
number and nothing else; not truncated, not redacted — the body is simply never
handed to the notification layer. The subject is not in the SMS either, because
it is text the customer typed and a text message is delivered to whoever is
holding the phone, which on an account-recovery ticket may not be them.

### Who may read a thread

Every customer-facing read puts `userId` in the `WHERE` rather than loading the
row and checking afterwards — an ownership check that happens after the fetch is
one somebody later moves. A thread that is not yours is a **404, not a 403**:
there is nothing to learn from the difference, and one of the two answers
confirms that a given id is real.

### The console side

`/admin/support` is the queue, worst first: priority, then length of silence.
Ordered in TypeScript rather than SQL — Postgres sorts an enum by declaration
order, so `orderBy: { priority: 'desc' }` happens to put `URGENT` first today
and would silently reorder the whole queue the day somebody tidies the enum.
`PRIORITY_RANK` says the order out loud instead.

"Never answered" is counted separately from "waiting". Ten threads
mid-conversation and ten nobody has ever replied to are the same waiting count
and completely different situations: one set of people are having a
conversation, the other are wondering whether this company exists.

The three console actions live in `lib/actions/support-console-actions.ts`
rather than `admin-actions.ts`, and the split is deliberate. Every action in
that file demands a reason of at least eight characters and writes an audit
row, and a test asserts it of each one, because everything in there moves
money, roles, or somebody's ability to sign in. These three do none of those,
and a better record already exists for them: a reply is stored verbatim with
its author and its timestamp, which is more than an eight-character note would
say. Demanding a reason as well would produce a column containing the word
"replied", eight hundred times. Rather than weaken that invariant with an
exemption list, these live next door. The line to hold: the moment a support
control touches a balance, a role or a phone number, it moves back and takes
the reason and the audit row with it. What does not change is `requireAdmin()`
on every one of them — a server action is its own entry point.

### These forms need JavaScript, and they say so

Measured, not assumed. A form submitted before hydration arrives as a plain
POST, which Next 15.1 runs **with no request scope**, so `cookies()` throws —
and every action here needs the session cookie to know whose ticket it is.
`LoginFlow` hit exactly this and made the same call for its code step.

Verified in a real browser with JavaScript disabled: the plain POST returns
500. So each submit waits for hydration rather than posting into an error
nobody can act on, and a `<noscript>` note says why — and points at the phone
number and email on the same screen. The fallback for "the bundle failed" is
the same as the fallback for "I cannot sign in", which is the second reason the
contact panel is there.

---

## Store staff — inviting a phone number, not an account

For a long time `StoreMember` rows were written by the seed or by hand. That
meant onboarding a partner shop needed somebody with database access for every
waiter they hired — and worse, there was **no way to create a store at all**
outside the seed, so a new partner needed a person writing SQL for the store
row, its menu, and its membership. The predictable end state of that friction
is one shared login for the whole shop, which is worse than any failure mode
the rules below guard against.

### The hard part is that the person has no account yet

A shop owner wants to add the waiter who started on Monday. That waiter has
probably never opened the app. The two obvious answers are both bad:

- **Fabricate an account** for a number nobody has verified. The demo-data work
  exists precisely because phantom accounts are dangerous.
- **Tell the owner to come back** once their staff have registered. Nobody
  comes back.

So access is offered to a **phone number**, held as a `StoreInvite`, and
redeemed on the first sign-in from that number — inside `checkLoginCode`,
right after the OTP has been verified. That is the only honest moment for it:
before then nobody has proved they hold the SIM, and an invite is a grant to
whoever does.

Which means an invite **expires**, after `INVITE_VALID_DAYS` (14). Philippine
prepaid numbers are recycled after a period of inactivity, and a forgotten
invitation to a reassigned number would hand a stranger the order queue two
years later.

Redemption never throws. A sign-in that failed because of a shop invitation
would be baffling to the person it happened to and unfixable by them; the
invite simply stays live for their next attempt.

### Nothing is ever texted to the invited number

A decision, not an omission. An invite form that sent an SMS would be a way for
any shop owner to message strangers at our expense, from our sender name. The
invited person hears about it from whoever is hiring them — who knows them,
which is why they are being hired — and gets an in-app notification the moment
their account exists. A test asserts that no SMS sender is reachable from the
invite path.

### Who may hand out what

`staff-policy.ts` is pure and keyed by every `StoreRole`, so adding a role is a
compile error until somebody decides what it may do.

| Actor | May grant | May remove |
| --- | --- | --- |
| **OWNER** | owner, manager, staff | anybody |
| **MANAGER** | staff | only themselves |
| **STAFF** | nothing | only themselves |

The asymmetry is deliberate on both ends.

**A manager may add staff but not another manager.** Only an owner decides who
else can change prices and settings, and a manager who could appoint peers
could build a majority that outvotes the person whose business it is.

**An owner may appoint another owner.** Ownership is the one role that has to be
transferable by the person holding it — otherwise handing a shop to a new
proprietor, or adding the spouse who actually runs it, needs a support ticket,
and what people do when a screen will not let them is share the login.

**Anybody may remove themselves.** Somebody who has stopped working at a shop
should not need the owner's cooperation to stop appearing in its staff list.

Changing an existing role is judged against **both** roles, and that is the
escalation it stops: a manager cannot grant OWNER, but without the second check
they could still "change the role" of the owner to staff and take the shop
over. The refusal names the half that failed, too — a manager told "only a
manager or the owner can add staff" would go and ask for the wrong permission.

### A store always keeps at least one owner

The one invariant that would otherwise need a database edit to repair. Lose the
last owner and the store is stranded: nobody can invite staff, change the menu,
or hand ownership on.

Enforced **twice**. `wouldStrandStore()` gives the person a sentence explaining
what to do instead; `prisma/sql/store_members.sql` is the enforcement that
counts, because it holds for code paths that do not exist yet — a future
script, a console action, a hand-written `UPDATE` at 2am.

Three details in that trigger are load-bearing:

- **`DEFERRABLE INITIALLY DEFERRED`**, which is what makes a handover possible
  at all. Promoting the new owner and demoting the old one are two statements,
  and a non-deferred check would reject whichever order they were written in.
  Deferred, the pair is judged once, at `COMMIT`, on the end state.
- **It checks the store still exists.** Deleting a `Store` cascades to its
  members, and complaining that a store being deleted has no owner would make
  stores undeletable.
- **It does not guard `INSERT`.** A store's first member is created before it
  can possibly have an owner, and a store with no members at all is one nobody
  has been given yet rather than a stranded one.

It honours the same transaction-scoped `tara.allow_purge` hatch as the credits
ledger and the audit log, so `db:purge-demo` still works.

### Two screens, and what each is for

**`/merchant/<store>/staff`** is the shop's own. Add by number, change a role,
remove somebody, withdraw an invitation nobody took up. Every "can I" question
is answered on the server from the viewer's real membership and passed down as
a boolean; the client component renders controls and never decides who may use
them. The same policy functions run again inside the actions, because **a
hidden button is not an authorisation check**.

**`/admin/stores`** is the console's, and it does exactly the two things the
shop cannot do for itself: create the store, and name its first owner. A new
partner shop has nobody at it who could invite anybody. After that first owner
the console gets out of the way — the menu, the prep time and the rest of the
staff belong to the people who work there, and duplicating those controls would
mean two screens that disagree.

A new store is created **hidden**. A shop with no menu that customers can find
is worse than one they cannot: they open it, see nothing, and conclude the app
is broken. The console refuses to make a menuless store visible, and the store
list puts the not-yet-ready shops first, because those are the ones waiting on
somebody.

### Putting the pin on the shop

Coordinates are the field on that form that matters most and looks least like
it. Every delivery fee from a shop is measured from them, so a transposed pair
does not fail — it charges the wrong money forever, quietly. And transcribing
two eight-decimal numbers off a phone screen is exactly the task people get
wrong.

So there is a map, and **four ways in, all writing the same two fields**:

1. **Search for the address.** Where somebody starts when they have a shop name
   and a street rather than a pin.
2. **Click or drag on the map.** How they finish — a geocoder lands you on the
   right road, not the right doorway.
3. **Paste a Google Maps or Waze link.** What they actually have — the way
   coordinates for a small shop are really obtained is that somebody stands
   outside it, drops a pin on their phone, and shares the link.
4. **Type the numbers.** The keyboard path, and the one that still works when
   nothing else is reachable.

The number inputs **are** the form fields, not a read-out beside hidden ones.
That keeps the value inspectable and keyboard-editable, and it is what makes
the form correct when the map is broken — a map is not an accessible way to
enter a coordinate and must not be the only way.

`parseCoordinateInput` in `lib/geo/philippines.ts` handles every shape a
Philippine operator would paste: a bare pair, `@lat,lng` from a map centre,
`!3d…!4d…` from a Google *place*, `?q=`/`?ll=` from Google, Waze and Apple, and
`geo:` from an Android share sheet. Two details in it are the interesting ones:

- **The place beats the centre.** A Google place URL carries the pin twice, and
  the two differ once somebody has panned. `!3d!4d` is the shop; `@` is wherever
  they were looking.
- **A reversed pair is corrected rather than rejected**, and the screen says it
  was. This is only safe because Philippine latitude (4–21) and longitude
  (116–127) do not overlap, so a pair that is invalid as given and valid when
  swapped can only be a swap. Anywhere else in the world that would be a guess.

A shortened `maps.app.goo.gl` link is named for what it is. The coordinates are
not in it and the browser cannot follow it to find out — cross-origin — so
"no numbers found" would send somebody hunting for a typo that is not there.

The bounds live in **one** module, read by both the picker and the server action
that accepts the form. They were written out twice for a while, which is
exactly the pair that drifts: a picker that lets somebody drop a pin the server
then rejects is worse than no picker.

### Address search, through the server

The search box goes to **Nominatim**, OpenStreetMap's own geocoder, and it goes
through the server rather than from the browser. Three reasons, and the first is
the one that decides it:

- **Nominatim's policy asks for a `User-Agent` identifying the application.** A
  browser cannot set one. Server-side, TARA can say who it is and carry a
  contact address — the difference between being a good citizen of a free
  service and being an anonymous source of traffic somebody eventually blocks.
- **The policy caps requests at one a second.** A throttle in one place is a
  throttle; a throttle in every operator's browser tab is a hope. It is claimed
  *before* the call, so two searches in the same millisecond do not both go out.
- **It keeps the third party at arm's length**, exactly like the SMS gateway,
  the push service and the CAPTCHA verifier. Nothing in this application lets a
  browser talk to somebody else's API directly.

`requireAdmin()` on the action, without which this would be an open geocoding
proxy for anybody who found the action id — an abuse of a free service and a
good way to get the deployment's address blocked. It lives outside
`admin-actions.ts` for the same reason the support controls do: it is a read of
a public search index, and "an administrator typed a street name" would be noise
in the log that matters.

Two things make the results usable rather than merely present.
`countrycodes=ph` is the single biggest improvement to relevance — without it
"Mabini Street" matches a dozen countries — and a `viewbox` around the city
already chosen on the form nudges the rest, deliberately *without* `bounded=1`,
because a shop just over a city line should still be findable.

Every candidate is checked against the same Philippine bounds as everything
else, so a result can never place a pin the form would then refuse. And the
response is read defensively throughout: it is somebody else's free JSON, under
no obligation to keep its shape, so an unreadable row costs one result rather
than the search. Nominatim sends coordinates as **strings**, which is the
detail that quietly turns a coordinate into `NaN` if you trust the field names
and not the types.

**None of it is load-bearing.** Search sits on top of three ways of setting a
coordinate that already work, and `GEOCODER_URL=off` removes the box entirely
rather than leaving one that can only fail. Every failure message names one of
the other three — "tap the map, paste a link, or type the coordinates" — which
is a property a test asserts, because a dead end is the one thing a convenience
must never become.

One implementation note worth keeping. The picker renders **inside** the store
form, so the search cannot be its own `<form>`: a nested form is invalid HTML,
the browser unnests it, and the outer form starts submitting on the wrong
button. The action is therefore dispatched by hand — which means wrapping it in
`startTransition`, because React only establishes an action context
automatically for a dispatch passed to a form's `action` prop. Called bare it
works *and* logs an error, which is the worst of both.

### What the map costs, and what it does when it breaks

Tiles come from OpenStreetMap: free, no account, no key, and better coverage of
barangay streets than some paid providers. Their tile policy permits light use
and a console form is about as light as it gets — but `MAP_TILE_URL` exists for
the day that changes, because if TARA ever renders a map on a customer screen
the volume stops being light and OSM's answer is to self-host or buy tiles.
Better to have the seam now than to find it in a policy email. It is read on
the **server** and passed down as a prop rather than through a `NEXT_PUBLIC_`
variable, which would be inlined at build time and freeze whatever was set
during `docker build`.

Tiles are fetched by the **browser**, so nothing here depends on the server
having egress. When they cannot be reached the panel says so in words, in
place of the map, and names the two ways in that still work. Getting that right
needed a real browser: Leaflet's `load` event fires when the visible batch has
*settled* — loaded or errored, it does not distinguish — so the obvious
`once('load') → ready` declared the map working with every single tile failed.
Latching on the first `tileerror` would be wrong the other way, because one
missing tile over the Sulu Sea is normal. Broken means the batch settled and
**nothing** loaded. A tile server that accepts the connection and never answers
fires neither event, so a timeout covers that too.

The pin is an inline SVG whose tip is at a known point, with `iconAnchor` set to
it. Not Leaflet's default marker, whose image is loaded from a relative path no
bundler resolves — that shows up as an invisible pin and no error. And not a
CSS teardrop either: the tip of a rotated square does not land where its
bounding box says, which put the pin about fifteen metres off on screen, which
is precisely the accuracy the control exists for.


### Where the audit line falls

The console's four store actions **do** carry a reason and an audit row, unlike
the three support controls. The distinction is what the action moves: a support
reply is already recorded verbatim with its author, while granting store access
hands somebody the power to change prices and accept orders in a real business.
That is squarely what the audit log is for. The phone number written into the
audit detail is masked — the log is read by more people than the account record
is.

---

## Ratings — derived, private, and slow to make a claim

`Store.ratingAvg` and `FleetPartner.ratingAvg` were read in six places from the
first commit — the storefront, the service listing, search, the home rail, the
fleet profile, and **dispatch ranking** — and written by nothing except the
seed. Every one of those was showing or scoring a zero.

### One review per order, two scores

`OrderReview` is keyed `@@unique` on the order, not one row per subject. An
order is a single experience somebody had and they rate it once; the food and
the delivery are two scores on that one event rather than two events. Rating
the same order twice is unrepresentable rather than merely discouraged.

Both scores are optional, and which ones apply is **registry-driven**: a
vertical whose `requiresMerchant` is false offers no shop to rate, and an order
nobody was dispatched to offers no rider. Nothing in the flow knows which
services exist. Somebody who thought the food was fine and the rider was late
can say exactly that and nothing else.

`storeId` is **snapshotted onto the review**, not read through the order. The
store lives in the order's `details` JSON and an aggregate query cannot join
through that — the same reason addresses are snapshotted onto orders.

### The reviews are the truth and the aggregate is derived

The same rule the credits ledger follows, and here for a sharper reason:
`FleetPartner.ratingAvg` is what dispatch scores on, so an aggregate that has
drifted does not fail — it quietly offers work to the wrong people and nobody
can reconcile it afterwards.

So the aggregate is **never incremented**. It is recomputed from the rows,
inside the same transaction as the review that changed them, and both subjects
are recomputed every time: an edit that moved a score from the shop to the
rider changes two aggregates, and recomputing only the one just set leaves the
other carrying a score it no longer has.

The average is computed in TypeScript rather than with SQL `AVG`, deliberately.
It means there is exactly one definition of what the average is —
`averageStars` — covered directly by tests, rather than a rounding rule in SQL
that happens to agree with it. Two decimals, because the screens round to one
and rounding 4.65 to 4.7 in the column that decides who is offered work first
is a change of substance. The cost is a column of small integers per recompute,
which is the thing to revisit if a shop ever has tens of thousands of reviews.

`npm run db:ratings-recompute` rebuilds everything and **reports what it
changed**. On a correct database it changes nothing; anything it changes is a
bug in the write path. Running it the first time immediately found one: the
seed was writing "4.7 from 412 reviews" for the demo shops, which was harmless
while nothing wrote ratings and is a number no review supports now. The seed no
longer invents them, so a demo shop shows "New" — which is true.

### Two privacy rules, enforced by what the functions return

Not by remembering to redact at the call site:

- **`storeReviews` and `partnerReviews` cannot return the author.** A rider who
  can see who gave them one star also knows that person's address, and a shop
  that can see who complained can decide how to treat them next time. They get
  the **order number** instead, which identifies the transaction being
  described without identifying the person and which they can look up in their
  own history.
- **A comment never appears on a public page.** A free-text review on a shop
  page is a moderation burden and a defamation risk; the same sentence is worth
  a great deal to the operator and the merchant, who are the ones who can act
  on it. So the storefront shows stars only.

`adminReviewFeed` is the one place an identity and a comment appear together,
and the console panel says so on the page. The rating form tells the customer
both rules right next to the box, because people write differently when they
think a shop will see their name, and differently again when they think it will
be published — and neither of those is what happens.

### When a rating is allowed, and when a number is worth showing

Only a **COMPLETED** order, and only for `RATING_WINDOW_DAYS` (14) afterwards.

Not a cancellation and not a failed delivery. That looks harsh — somebody whose
order never arrived has the strongest opinion of anybody — but a rating is a
judgement of an experience that happened, and what they need is a refund and a
person to talk to. Both exist: the timeout sweep refunds automatically and the
tracking screen offers support. Letting a non-delivery become a one-star review
would fold two different problems into the one signal dispatch ranking reads.

The window is also what makes the average describe the shop **as it is now**: a
restaurant that changed hands in March should not be carrying January's
kitchen. Within it, a review can be edited, which is what somebody who
mis-tapped a star expects and which costs nothing because the aggregate is
recomputed either way.

And **below `MIN_REVIEWS_TO_SHOW` (3) no number is shown at all**. One
five-star review makes a new shop look better than a shop with two hundred
reviews averaging 4.6, and a customer reading "★ 5.0" has no way to tell which
they are looking at. `RatingBadge` says "New" instead — true, useful, and not a
claim. A shop looking at its **own** numbers sees all of them from the first
review, with the count beside it and a note saying customers do not see a score
yet; that threshold protects a stranger from a misleading verdict, not a
merchant from their own data.

### Telling the shop and the rider — a digest, not a buzz per star

The first version of ratings notified nobody, on the grounds that a one-star
alert is a bad way to learn something and an easy thing to abuse. Both are true
and neither is a reason to leave a complaint unread, so the answer is the shape
of the message rather than its absence.

**One notification per subject, covering everything since the last one.** A
shop with a good lunch would otherwise get thirty of them, learn to swipe them
away, and miss the one that mattered. Batching turns that into "eleven new
ratings, averaging 4.6, lowest was a two" — less annoying and more useful.

The batching is a delay rather than a schedule: `sendRatingDigests()` runs in
the order sweep, and a batch goes out once its **oldest** un-notified member is
past `RATING_DIGEST_DELAY_MINUTES` (60). So a rating that lands mid-rush waits
for the rest of the rush instead of going out alone, and nothing needs to know
what time of day it is. Nobody is waiting on a shop to read a rating.

`OrderReview` carries **two** notification timestamps, `storeNotifiedAt` and
`partnerNotifiedAt`, because the two subjects are told independently — a review
of only the food has no rider to tell, and the shop's digest and the rider's
digest cover different sets of rows. Same shape as
`ServiceInterest.notifiedAt`.

Three properties are worth stating:

- **It carries the numbers and never the words.** Count, average, and the
  lowest score. A comment is text somebody typed about a person and a
  notification lands on a lock screen, which is the wrong place to read it and
  the wrong place for somebody else to read it. The screens have the words.
- **It names the worst score when one is poor.** "3 new ratings" that hid a
  one-star inside a good afternoon would be a digest people learn to ignore,
  and the bad one is the entire reason to open the screen.
- **It is INFORMATIONAL, and here the deferral is the feature.** Quiet hours
  hold an informational push until 6am. Nobody should learn they got one star
  at eleven at night, and it reads no differently over breakfast. Never SMS
  either: the volume is bounded by how many orders were delivered, which is the
  number that spikes on a good day, and a shop's best afternoon should not be
  its biggest bill.

At a shop it goes to **MANAGER and above**. Staff work the order queue; a
review of the cooking is not theirs to answer and not a thing to push at
somebody mid-shift. A shop with nobody at that level is **skipped rather than
marked told** — its ratings wait for whoever is next given the keys, because
marking them told would lose them silently.

The mark happens after the enqueues, so a batch that fails is picked up next
pass: a rating nobody hears about is a missed message, and hearing about the
same one twice is worse. The dedupe key is the newest review in the batch,
which makes a retried pass a collapse and a later batch a different key.

### The database guards, and the one that was removed

`prisma/sql/order_reviews.sql` holds two checks: a star is 1–5, and a review
rates something. A stray 0 or 11 does not error anywhere — it just moves the
number a shop is judged on — and a row that rates nothing would sit in the
table looking like feedback while counting towards nobody.

A third was tried and removed, and the reason is worth keeping. "A score
implies a subject" looks obviously right, but `storeId` is `ON DELETE SET NULL`
so that removing a shop does not erase the rider's half of the same review —
which means the cascade nulls the id, the stars stay, and every DELETE of a
shop with any review on it fails on the check. Verified against the real
database rather than reasoned about. The invariant is a write-time one and
lives in `submitReview`, where a score and its subject id are set together or
neither is, with a test asserting it.

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

### Push, which was the test of this design

`NotificationChannelAdapter` was one interface with two implementations, and the
claim was that a third would be a file rather than a refactor. It was:
`push/channel.ts` implements the same `deliver()`, `resolveChannels()` gained
three lines, and nothing above the adapter layer changed. `KIND_POLICY` and
`CHANNEL_DEFAULTS` are keyed by every enum member, so adding `PUSH` to
`NotificationChannel` was a compile error until somebody decided its defaults —
which is what those exhaustive records are for.

**Push carries every kind. SMS keeps its restraint.** That is the whole reason
both exist. Push costs nothing per message and reaches a closed tab, so
withholding it from a message worth writing down would need a reason and there
isn't one. SMS reaches a phone with no browser permission granted, which is the
one thing push cannot do, and each message costs a peso. Quiet hours still apply
to informational push — free does not mean welcome at 2am — which is why `PUSH`
is deliberately *not* in `ALWAYS_ON_CHANNELS`.

#### The crypto is written out, not pulled in

RFC 8291 payload encryption and RFC 8292 (VAPID) tokens are about two hundred
lines in `src/lib/notifications/push/`. The reason to own them rather than add a
dependency is the failure mode: a payload encrypted wrongly is **accepted** by
the push service, which answers 201, and the browser silently discards a message
it cannot decrypt. Nothing raises anywhere. Code that can fail that way should be
readable.

Which also means it cannot be verified by reasoning about it. So:

- The encrypted output is **byte-identical to `http_ece`** — the reference
  implementation, written by the author of RFC 8291 — across a fixed vector, a
  decrypt round-trip, and 200 randomised rounds with fresh keys, salts and
  payload sizes.
- The VAPID tokens verify under `jws` (the library `web-push` uses) across 50
  fresh key pairs, in both directions.
- Neither reference library is a dependency of this project. What is committed
  is the *agreed output*: two pinned vectors in `push-crypto.test.ts` that fail
  if a single byte changes, plus a decryptor written independently of the
  encryptor, so agreement means the derivation is right rather than merely
  self-consistent.

#### GONE is not FAILED

The distinction `send.ts` exists for. A 404 or 410 means the browser threw the
subscription away: the row is marked dead and never retried. Anything else might
be transient. Conflating them either retries a device uninstalled last month
forever, or discards a live one over a single 500. Both directions have tests.

The fan-out lives in the adapter, not the delivery table: one
`NotificationDelivery` row per channel, every live browser behind it, succeeding
if *any* browser took it — because the person was reached. A row per device would
make "was this person told" a question you answer by counting rows and guessing.

#### Two smaller judgements

**Enqueue skips push when the account has no live subscription.** Push is on by
default for every kind, so without that check every notification for every
account that never granted permission writes a PENDING row for the cron to
attempt against nothing. That is most accounts and most notifications. Deciding
it at enqueue makes it one SKIPPED row, written once, and the record still says
what we would have done.

**The service worker handles push and nothing else.** No `fetch` handler. One
that intercepts requests is a second, stale copy of the app that can serve
yesterday's prices, and that belongs in a considered caching strategy rather
than as a side effect of wanting notifications.

#### What is not verified

A subscription from a real push service. Chrome refuses the Push API in the
incognito profile Playwright uses, and the development environment's network
policy blocks the push services outright, so no endpoint could be obtained. The
whole server path *is* verified end to end against a stand-in push service over
real TLS that decrypts what it receives, and the browser half is verified with
a push delivered through the Chrome DevTools Protocol: the worker registers,
renders the right title, body, tag and href, replaces a same-tag notification,
and falls back to something rather than nothing on an unparseable payload.

---

## The admin console

Six screens at `/admin`, for an account carrying `UserRole.ADMIN`. It is the
first surface in this codebase that can change somebody else's data, so the
question it is designed around is not "what can an operator do" but **"how does
anybody later reconstruct what an operator did"**.

### Authorisation is in the action, not the route

Three layers, and only one of them is real.

`middleware.ts` checks that a session cookie exists. It runs on the edge runtime
where Prisma is unavailable, so it cannot tell whose cookie it is or what roles
it carries. It is a bounce for obviously signed-out traffic and nothing more.

The layout calls `getAdminUser()` and returns `notFound()` — a 404, not a 403.
A 403 tells somebody probing the app that `/admin` exists and that they merely
lack the role.

**Every server action calls `requireAdmin()` itself.** This is the boundary. A
server action is its own entry point, reachable by anybody who can post to the
app, and a layout check does not cover it. `admin-access.test.ts` asserts this
by reading the source: every exported `*Action` must contain `requireAdmin()`,
`normaliseReason()` and `recordAdminAction()`. It is exactly the rule that gets
broken by adding one more function that looks like the others.

`getAdminUser()` also checks `isBlocked` separately from the role, because
blocking an account that happens to be an admin should stop them using the
console rather than only stop them ordering lunch.

### Deciding who may take work

`/admin/fleet` replaced the last job in this application that could only be done
over SSH. Approving riders was `npm run fleet:approve`, run by whoever had the
production database — for something done daily, from a phone, while looking at a
photograph of a licence. Three things that script cannot do:

- **Record who decided.** A shell has no identity, so
  `FleetPartnerServiceVerification.decidedByUserId` stayed null and no audit row
  was written. The console sets both.
- **Tell the rider.** Somebody waiting to work learned nothing until they
  guessed to check their profile.
- **Refuse to decide an application nobody made.** The script upserts, so it
  will happily create an approval for a vertical whose documents nobody
  submitted — which is exactly the mistake the per-service table exists to
  prevent. The console reads the row and throws `NotAnApplicationError` when
  there is none.

The queue is one row per APPLICATION, not per partner, oldest first: that is the
unit of the decision, and a rider approved for food while waiting on passengers
should appear once, for the thing still outstanding. Same ordering rule as the
support queue, for the same reason — a list sorted newest-first is how somebody
who applied on Monday is still waiting on Friday.

**One decision per submission.** Each application renders its own controls, with
the service in a hidden field; nothing in the console can approve two verticals
at once. `enabledServices` is recalculated from the verification rows inside the
same transaction — dispatch reads that array on every candidate query, so a
value assigned from what the caller intended is a quiet misroute.

**The refusal reason is the applicant's, not the log's.** It goes to
`rejectionReason`, which the partner's own profile screen shows, and to the
audit row — one field, because an administrator writing "see notes" in the box
the rider reads is how a refusal becomes a dead end. The form says so where it
is typed. An approval clears any previous reason, so nobody reads last month's
rejection beside the word "Approved".

**Suspension is a separate judgement** from the per-service decisions: not
whether the documents are good but whether somebody should be working at all
today. It leaves every approval intact — reinstating is one click rather than
three decisions taken again — and it clears `isOnline`, because a partner left
online while suspended is one dispatch keeps considering and skipping while
their own screen says they are working.

Each decided row says **"they were told"**, and only where a decider is
recorded. That is the one thing an administrator cannot otherwise see, it is
true by construction (the message is enqueued in the same transaction), and a
row decided in a shell says so instead — claiming otherwise about somebody
still waiting to hear would be a comfortable lie.

### Every control refreshes the page it changed

`ReasonForm` calls `router.refresh()` after a successful action, and that is not
a nicety. The actions call `revalidatePath`, which invalidates the **server's**
copy; the page the operator is looking at was rendered before the click, and a
server action invoked from inside a client function is a plain call rather than
a navigation. Without the refresh the console reads back the state it had
before: an application approved a moment ago still says "Pending", so somebody
clicks again and is told the decision was "already in that state".

Found in a browser against a production build while verifying the fleet screen,
and it applied to every control in the console, since they all come through
this one component.

### The audit trail is append-only, in the database

`AdminAuditEvent` gets the same treatment as the credits ledger, for the same
reason: an audit trail the people it describes can edit answers no question
worth asking. A trigger raises on UPDATE and DELETE. A mistaken entry is
corrected by a later entry.

The write and its audit row **commit in one transaction**. Logging afterwards
loses the record exactly when the process dies mid-action, which is the case
somebody will later need to reconstruct.

`reason` is `NOT NULL` and, by CHECK constraint, at least eight non-blank
characters. Not decoration — it is the only field that answers *was this
legitimate*, and `"."` satisfies `NOT NULL` while answering nothing. The subject
is identified twice, by id and by a denormalised `subjectLabel`, so the log still
reads after the subject has been renamed or deleted.

`AdminAction` is a closed enum rather than free text, and `ADMIN_ACTION_LABEL` is
keyed by all of it: a new kind of privileged action is a decision plus a line of
English, not a string somebody typed.

### The credits control cannot become a top-up

`adjustCreditsAction` calls `recordAdjustment`, which is the same one function
every balance change goes through. The console does not touch a balance field
and cannot: the ledger table refuses UPDATE and DELETE, an `ADJUSTMENT` without
an `adminUserId` fails a CHECK, and a grep test asserts this file never writes
`balanceCentavos` and contains no top-up, transfer or withdrawal.

A single adjustment is capped at **₱500**. A support tool that can issue
unlimited credit is a support tool that will. A promotion belongs in a campaign
with its own approval, not in one form field.

### What the console deliberately cannot do

- **Force an order's status.** A state machine with a manual override is not a
  state machine: an order pushed straight to `DELIVERED` skips the credit-back
  grant and the notification, and the next person to look wonders why the
  ledger disagrees with the timeline. Fixing a stuck order means fixing the
  transition that stuck. The order screen is read-only.
- **Edit roles.** A role change has consequences across three apps and belongs
  in a reviewed script, not a dropdown.
- **Edit a phone number.** The phone *is* the identity; changing it is an
  account takeover with extra steps.
- **List every account.** People are found by search only, minimum three
  characters. A console that opens onto everybody's records invites browsing,
  and browsing other people's records is the behaviour the audit trail exists to
  discourage — much easier to discourage by not offering the list.

### The launch switches, and the bug they exposed

`/admin/services` is the payoff for making the registry data. Launching a
vertical is two form posts — available in a city, then live — with no deploy and
no code change. The page names no service and no city; it reads both from the
database, which is the one thing the registry exists for.

Two guards keep the two switches consistent. A service available in no city
cannot be switched on, and withdrawing its last city switches it off, because a
tappable tile that fails at checkout is worse than an honest "coming soon".

Building the switch immediately exposed a real bug in
`getServicesByIntentGroup()`, which had been unreachable until something could
put a service into the state that triggers it. The old rule was "coming-soon
tiles show everywhere; a live service only shows where it is live" — so a
vertical launched in Cebu **vanished from Manila entirely**: neither usable nor
coming, just absent, with no way for anyone in Manila to know it existed. Since
this business launches one city at a time, that would have been the outcome of
the first real launch.

The fix separates two questions that had been one. `isOrderableIn(service,
cityId)` is now the tile's condition, distinct from `Service.isActive`; a
service live elsewhere stays visible as something to anticipate. `ServiceTile`
reads `orderableHere`, never `isActive`.

---

## Demand for the verticals that do not exist yet

Four of the five tiles on the home screen are dimmed, and the decision about
which vertical to build next was a guess. `ServiceInterest` is the only
evidence the product collects: a tap on a dimmed tile, attributed to a city,
so "is Mart worth building" becomes "how many people in Iloilo asked for it".

The tile used to be an inert `<div>` — deliberately, since there was nothing to
activate — and is now a button. Everything about it still derives from the
`Service` row; what changed is that `orderableHere === false` has an action
instead of nothing.

**Two shapes of row, counted separately and never added up.**

| Row | Means | Trustworthy? |
| --- | --- | --- |
| `userId` set | One account, `askCount` for repeats | Yes — needed a code sent to a real phone |
| `userId` NULL | One shared counter per service and city | No — anybody who can post a form can raise it |

Summing them would give the console a number that one person with a loop can
move, and a launch decision made on it. So `foldDemand()` — pure, and tested at
every shape — keeps them apart, the tile only ever shows the account count, and
the console labels the anonymous tally as what it is. The anonymous rows are
also a single counter per pair rather than a row per tap, so a script costs
storage nothing.

**The interest is refused where it would be meaningless.** An unregistered
service key, and a service that is already orderable in that city — otherwise a
launched vertical accrues "unmet demand" forever. Both are reachable by posting
to the action rather than tapping the tile, which is why they are checked
server-side against the registry rather than by rendering the tile differently.

**The tap is a promise, so something keeps it.** `announceLaunchedServices()`
runs on the same cron as the order timeouts and tells everybody whose service
has since gone live where they asked. It is a query over current state, not an
event fired from the launch switch: a launch done before this existed, or by a
SQL update, or by withdrawing and re-adding a city, is picked up anyway — and an
administrator flipping a switch does not wait on a fan-out to thousands of
people. It is bounded per pass, and the dedupe key is the interest row, so
switching a service off and on cannot tell the same person twice.

`SERVICE_NOW_AVAILABLE` carries IN_APP and PUSH and **not SMS**. The recipient
asked us to note that they wanted Mart; they did not ask to be texted, and a
launch announcement to a waiting list at a peso a head is the message that
teaches people to ignore texts from us.

### The storefront is public

A delivery app whose front door demands a phone number has already lost the
customer, and the demand signal above was measuring the wrong population: only
people who had already signed up could see a tile at all.

So `/`, `/services/…`, `/stores/…`, `/search` and `/help` are reachable with no
account. Nothing under them renders anything about a person — no contact
details, no order history, no saved addresses. A stranger browses the tiles, a
service's stores and a store's menu, taps a coming-soon tile, and fills a cart,
which lives in their own browser and survives the login detour. Signing in is
asked for at the first point it is actually needed: `/checkout`, which redirects
there itself, and anything about a person rather than a product.

**Two lists, matched differently, and the difference is the point.**
`PUBLIC_PATHS` is exact; `PUBLIC_SUBTREES` matches on a path **boundary** —
`/services` or `/services/anything`, never `/servicesomething`. A plain
`startsWith` has two traps in it: `'/'` in the list makes the entire
application public because `'/admin'.startsWith('/')` is true, and `/help` in
the list makes a future `/helpdesk` public. Neither fails loudly. Both are
asserted in `src/tests/public-routes.test.ts`, in both directions — sixteen
private paths bounce, and the storefront does not.

**What being public changed about the tiles.** Two things a tile said were
true only for a signed-in reader, and became lies the moment a stranger could
tap one:

- *"you and 33 others"* counted them among 33 accounts they are not one of;
- *"we will tell you"* promised a message to somebody the product has no way to
  reach.

So the action returns `canBeTold`, and a visitor with no account gets
**"Noted — sign in to be told"**: true, and the one thing that would let us
keep the promise. Their tap is still counted, anonymously, in the shared
counter.

**A caveat on the anonymous numbers.** `getCurrentCityId()` falls back to
`NEXT_PUBLIC_DEFAULT_CITY_ID` for somebody with no saved address, so every
anonymous tap is attributed to the default city. The per-city breakdown is only
as good as the accounts column — which is the column the console already tells
you to trust.

## Shipping it: the image and CI

Blocker 10 on the pre-launch list was "no Dockerfile, no CI and no deploy
configuration". There are now all three, plus `docker-compose.yml` for the
self-hosted case.

### Two images, one file

| Target | Job | Carries |
| --- | --- | --- |
| `web` (default) | answers requests | the standalone bundle, nothing else |
| `ops` | migrations, guards, the sweep, backups, the restore drill | full dependencies, `scripts/`, the Postgres 16 client |

Splitting them is not tidiness. `pg_dump` and `psql` on the machine that
answers customer requests is attack surface for no benefit — nothing on a
request path shells out to either — and the ops image needs both. Postgres
**16** specifically, from PGDG rather than Debian's own 15: `pg_dump` 15
refuses to dump a 16 server, and `psql` is what `npm run prisma:guards` shells
out to, so without it the append-only triggers on the credits ledger silently
never apply.

`output: 'standalone'` in `next.config.ts` makes the web image 86 MB of traced
runtime files instead of 737 MB of `node_modules`. That layout was verified by
running it: the exact three paths the Dockerfile copies were assembled in a
temporary directory and `node server.js` booted in 67 ms, served the public
storefront, and rendered `/admin/health` with live Prisma queries.

`/api/health` returns **503** when the database is unreachable, so a rolling
deploy does not route traffic to an instance that cannot answer. It is in the
middleware's public list — behind the login wall it would answer 307 to
`/login`, which some probes read as healthy and others as unhealthy, and
neither is true.

### On `NEXT_PUBLIC_*` and build arguments

Nothing here needs a secret at build time, and it must stay that way: an `ARG`
is visible in `docker history` forever. The one thing to watch is
`NEXT_PUBLIC_*`, which Next inlines into the **client** bundle at build. Every
use today is in a server component — verified by running the built server with
a site key set only at runtime and seeing it reach the page — so they are all
runtime configuration. A `'use client'` component reading one would silently
bake in whatever was set at build, and would need an `ARG`.

### CI, and the four things it is for

`checks` runs typecheck, lint, tests and **a production build**, because the
build is the only one of the four that catches a `'use server'` module
exporting a constant, or an edge-runtime import that stops instrumentation
compiling. Both have happened here; `tsc` and ESLint pass both.

`database` applies every migration to a real Postgres 16, then the SQL guards,
then the seed — then asserts that the seed *refuses* `NODE_ENV=production` and
that `db:purge-demo` leaves nothing behind. The guards step is the only thing
in the project that would catch a broken trigger definition, which is the
failure that quietly makes the credits ledger editable.

`backup` takes a dump, restores it into a scratch database, checks the ledger
adds up there, and then flips a byte in the middle of an encrypted dump and
requires the restore to be **refused**. The restore drill, on every push,
rather than an instruction somebody remembers.

`image` builds both container targets. There is no Docker daemon in the
environment these files were written in, so CI is the first place they are
built at all — and that is stated plainly rather than implied otherwise.

### Three bugs that simulating CI locally caught

Running the workflow's steps by hand, with `.env` moved out of the way to match
a runner, found three things that would each have failed on the first push:

1. **The Prisma CLI's `.env` overrides the shell.** A command run with an
   exported `DATABASE_URL` still used the one from `.env`, so any local "it
   works" was meaningless. Only moving the file aside gave an honest answer.
2. **`DIRECT_URL` is not optional.** `schema.prisma` declares
   `directUrl = env("DIRECT_URL")` for pooled hosts, and the CLI refuses to
   *load* a schema whose referenced variables are missing — P1012, before it
   touches a database. A developer never sees it; a runner has no `.env`. Every
   Prisma step in CI, and the compose `ops` service, sets both.
3. **`docker compose run --rm ops …` named a service that did not exist.** The
   header comments documented it; the file defined `cron` and `backup` and no
   `ops`. It is now a real service under a `tools` profile, so `up` does not
   start it.

## Backups

The honest position first, because it decides everything else. **The real
backup is a feature of wherever the database is hosted.** Point-in-time
recovery on a managed Postgres restores to the second and survives this machine
catching fire. Turn it on. Nothing in this repository replaces it, and code
that shipped a `pg_dump` loop while implying otherwise would be worse than no
backup code at all.

What `src/lib/backup/` and the two scripts add is the part a managed host does
not give you:

- **a portable dump** you can take off the platform — the answer to "the
  provider suspended our account" and "we are moving hosts";
- **a restore drill**, because a dump nobody has restored is a hope. This is the
  step almost nobody builds and the only one that proves the rest;
- **a record** of when a backup last succeeded, so "are backups running" is a
  question the console answers rather than a belief somebody holds.

### `npm run db:backup`

`pg_dump --format=custom --serializable-deferrable`, so the dump is one
consistent moment even while orders are being placed, and restorable
selectively — which is what a real recovery usually needs.

The connection details go into the child's **environment, never argv**:
`pg_dump postgresql://tara:hunter2@host/db` puts the database password in `ps`
output for every process on the machine. There is a test asserting it stays out
of the command line.

Then it reads the archive's own table of contents back with `pg_restore --list`,
which catches a truncated write, a full disk, and a dump that failed halfway
with a zero exit somewhere in a pipe. A `BackupRun` row is written before the
dump starts, so a failure leaves a trace — a table of only successes cannot
answer "when did this start going wrong" — and old dumps are pruned, but only
files matching our own naming pattern, so a directory somebody also keeps notes
in does not lose them.

**Encryption is optional and warned about.** With `BACKUP_ENCRYPTION_KEY` set
the dump is AES-256-GCM with a per-file salt and IV; without it the script says
plainly that the file will contain every customer's phone number and home
address in plaintext. Optional rather than mandatory because an encrypted
backup whose key is lost is not a backup — that trade is the operator's to
make, not ours. GCM rather than CBC because it authenticates: a single flipped
byte fails to decrypt rather than restoring a plausible-looking database, which
is asserted in a test.

### `npm run db:restore-check`

The step that makes the rest worth having. It restores the newest dump into a
**brand-new scratch database**, never over the live one, and asks four
questions:

1. Are the tables all there?
2. Did the data come back? A *difference* in row counts is expected and
   reported without alarm — the dump is a snapshot and the business keeps
   taking orders. A table that holds rows live and none in the copy is a
   failure, and that is the thing a row count can actually catch.
3. **Does the credits ledger still add up to the wallet balances, in the
   restored copy?** That is the invariant the whole financial side rests on,
   and checking it against the restored data catches a dump that lost
   transactions while keeping a plausible row count.
4. Are the append-only triggers still present? They live in `prisma/sql`, so a
   restore into a fresh database legitimately needs `npm run prisma:guards`
   afterwards — and the check says so, because a restored database that works
   and cannot be trusted is the worse outcome.

The scratch database is dropped whatever happened.

### What the console claims, and what it admits

`backupPosture()` has three answers, and the middle one is why it exists rather
than an `if` on the health page:

| `BACKUP_STRATEGY` | The console says |
| --- | --- |
| unset | Red: nothing is declared, and this data exists nowhere else |
| `host` | Calm: the provider is responsible, **and this application cannot see whether that is true** |
| `script` | Last backup, its age, whether one has ever been restored — red past 36 hours |

Thirty-six hours rather than twenty-four: a daily cron at 02:00 is 24 hours old
at 01:59 the next night through nobody's fault, and a check that goes red every
night before the run is a check people learn to ignore.

A deployment relying on its host's PITR is doing the right thing, and stating
the limit is the whole point — a green tick this code cannot justify is worse
than no tick.

### A bug worth recording

The first version attached the child process's `close` listener *after* reading
its stdout to completion. For a small database the child has already exited by
then, `close` has already fired, and it does not fire again — so the script
hung, then exited silently with status 0, leaving a `BackupRun` row that said
"not ok" with no error beside a dump file that was perfectly fine. It failed
only on the encrypted path at first, purely because that path was fast enough
to lose the race. The subscription now happens before the read, and a test
asserts that ordering.

### Verified

52 checks on the pure parts, and then the whole thing run for real against
Postgres 16: a plaintext dump and an encrypted dump both taken, both read back,
both restored into a scratch database with the ledger checked and the triggers
found, retention pruning five of seven, and three failure modes confirmed to
fail — the wrong key, no key, and a dump with one byte flipped in the middle.

## Error monitoring

Before this, a page that started failing was discovered when a customer said
so — and most customers do not say so, they leave. Nothing here makes anything
more reliable; it makes failure *visible*, which is the prerequisite for
everything else.

### Not Sentry, and why

Sentry is the obvious choice and a good product. What it also is, for this
application, is a US processor receiving Philippine phone numbers, home
addresses and order contents inside error payloads — before this business has
a privacy policy or a named data protection officer, both of which are still
open items on the launch list. It would also do nothing at all until somebody
creates an account and sets a DSN, which is the same "configured later, so
unprotected today" shape as the SMS gateway.

So the record lives in the same database as everything else, needs no
configuration, and works on the first deploy. It sits behind a narrow enough
seam — `reportError(error, context)` — that forwarding to Sentry later is
another file rather than a rewrite. What is given up is source-mapped client
stacks and release tracking, which is a real loss and the right trade at this
stage.

### One row per fault, not per occurrence

`ErrorReport` is grouped by a `fingerprint` — kind, plus the redacted message,
plus the first stack frame belonging to our own code — with an `occurrences`
counter and first/last timestamps. A page failing four hundred times in an hour
is one row saying "four hundred times, still happening", which is a shape
somebody can act on, and a loop cannot fill the disk. The route is deliberately
NOT in the fingerprint: the same bug on four pages is one bug.

Framework frames are skipped when picking the frame to group on, because an
error thrown inside React's renderer has the same top frame whatever caused it.

### What is not a fault

A row on the error page is a claim that something needs fixing, so the page is
only worth reading if everything on it is one. Two kinds of thrown error are
not, and both were observed on the real console:

- **An authorisation refusal.** `requireAdmin()` throws, the layout turns that
  into a 404, and the customer gets exactly the right response — but the throw
  still reaches `onRequestError`. A signed-in non-admin opening a bookmarked
  `/admin` URL logged a fault, and anybody could have filled the page by
  requesting `/admin` in a loop. The same applies to `NoStoreAccessError`,
  `InsufficientStoreRoleError`, `NotAFleetPartnerError`, and to being signed
  out at a server action. `lib/monitoring/expected.ts` holds the list.
- **An abandoned request.** A tab closed mid-load leaves the render writing to
  a stream that is gone. Seen as `/help/contact :: Error: Connection closed.`
  Nothing on our side is wrong and nothing on our side can be fixed.

The check runs first in `reportError`, before the hash and before the database,
so the loop case costs one set lookup rather than one write per request.

Matching is by error **name**, not `instanceof`: this module is reachable from
the edge-compiled instrumentation hook, and importing the error classes would
drag `next/headers` and Prisma behind them — the trap the hand-written hash
below already documents. A test constructs every one of those classes and
asserts the names still match, so a rename cannot quietly empty the list.

**What this costs, and it is real.** A role bug that wrongly refuses a
legitimate administrator now produces no error report. That is accepted: the
alternative is a page nobody reads, and such a bug is loud in the other
direction — the person locked out says so immediately. What is not accepted is
widening the list. An error belongs on it only when the response the customer
received was the correct one.

### Redaction, which is the part that matters

Everything is redacted **before** it is written. These are all real messages
this codebase can produce:

| What arrives | What is stored |
| --- | --- |
| `HTTP 422: {"message":["481923 is your TARA code…"]}` | `…["[6-digit] is your TARA code…"]` |
| `POST …/messages?apikey=abc123` | `…?apikey=[redacted]` |
| `Unique constraint failed on +639171234567` | `…failed on [phone]` |
| `Can't reach database at postgresql://tara:hunter2@…` | `…at postgresql://[redacted]` |

An error log that captured the login code it failed to send would be the
softest target in the database. Redaction earns its place twice over: it also
makes grouping work, since `Invalid phone +639171234567` and `Invalid phone
+639189876543` only become one fault after both turn into `Invalid phone
[phone]`.

### Where errors are caught

| Source | Caught by |
| --- | --- |
| Page render, route handler | `onRequestError` in `src/instrumentation.ts` |
| Server action | the same hook, distinguished by `routeType` |
| A component throwing in the browser | `src/app/error.tsx` → one narrow server action |
| The root layout itself | `src/app/global-error.tsx` (reports nothing; the server hook already has it) |
| The maintenance sweep | `runMaintenance`, and the script's own catch |

Next's `digest` is stored, because it is the only thing linking the opaque
message a customer saw to the stack we recorded — and it appears, small and
selectable, at the bottom of the error screen, so "it says 986393595" is the
start of a support conversation rather than a guess.

The client report endpoint takes a message and a digest and **never a stack**:
it is reachable by anybody who can post to the app, and an accepted stack would
be unverifiable text written straight into the database. A flood of junk
becomes one row with a high count, which is the same protection the table's
shape gives everything else.

### Nothing in `report.ts` may make things worse

It never throws — every entry point wraps its own body, because a monitoring
call that can fail turns one broken page into two, and the second happens
inside the handler for the first. It never reports its own failure, which would
be an infinite loop with a database connection attached.

**No `node:crypto`.** The fingerprint uses four seeded FNV-1a lanes written out
in the file. This is not a preference: `instrumentation.ts` is compiled for the
edge runtime as well as for Node, so a `node:crypto` import fails the
production build outright — and in development it fails *quietly*, because the
instrumentation module never compiles, the hook is never registered, and errors
vanish with no sign that monitoring is off. That happened during this work and
cost an hour. A grouping key is not a security primitive; a collision merges
two rare faults into one row, which is cosmetic next to silent blindness.

### Being told

`alertOnNewErrors()` runs on the order cron and notifies every unblocked
administrator the **first** time a fingerprint appears — `alertedAt`, once,
per fault. An error loop with ten thousand occurrences is one notification, and
at most five faults are announced per pass: if twenty things broke at once an
administrator needs to know something is badly wrong, not to receive twenty
messages, which is indistinguishable from spam and gets muted.

`ERROR_DETECTED` is OPERATIONAL, so it ignores quiet hours — a checkout broken
since 2am is worth waking one person for — and carries push and inbox but
**not SMS**: a monitoring system that can run up a bill during an error loop is
one somebody switches off. Not SUPPORT_AGENT either: a support agent cannot
deploy a fix, so a stack trace at 2am is noise with no action attached.

### Verified

594 tests, including every redaction rule against the string that motivated it.
Then driven end to end against a production build: a server component, a route
handler, a server action and a client component were each made to throw, and
all four landed with the right `source`, the phone number and code and API key
redacted, three hits of the same page grouped into one row with
`occurrences = 3`, and the client row carrying the same `digest` as the server
row so the opaque message a customer sees ties back to the real stack. The cron
then alerted the administrator once per fault, and a second pass alerted nobody
again. Marking one fixed from the console wrote its audit entry.

## The CAPTCHA on the login screen

Three rate limits already guard the code request — three per number per fifteen
minutes, twelve per address per hour, a forty-five second resend cooldown — and
they hold against a careless script. What they do not hold against is somebody
with a list of numbers and a few hundred addresses, and **every request that
gets through costs a peso of ours**.

So Cloudflare Turnstile sits in front of `sendLoginCode()`, behind the same kind
of interface the SMS gateway has (`src/lib/auth/captcha/`). Free at any volume,
silent for a normal browser — which matters on a low-end handset over patchy
mobile data, where "click the six squares containing a bus" is a reason to give
up on ordering — and it builds no advertising profile of the person signing in.

**It is a cost control, not an authentication control.** The boundary on an
account is the six-digit code sent to a phone somebody physically holds; a
CAPTCHA does not strengthen that by a bit. Every decision below follows from
keeping that straight.

### Checked before anything is spent

The verification happens before the number is looked at any further, before a
row is written and before the gateway is called. That ordering is the only one
where a refused request costs nothing, and the only one that preserves the
no-enumeration property: a bot that fails the check learns nothing about the
number it tried, because nothing about the number was consulted.

### The asymmetry, which is the whole design

| What happened | Answer |
| --- | --- |
| No CAPTCHA configured | **Allowed** — the rate limits carry the load, exactly as before |
| Token checks out | **Allowed** |
| Token missing, or rejected by Cloudflare | **Refused** |
| Verifier unreachable, timed out, 5xx, or *our* secret rejected | **Allowed**, and logged loudly |

The last row is a deliberate decision to fail **open**, against this codebase's
usual instinct, and it is asserted in a test so that "tidying" it into
consistency is a failing build. Failing closed would mean an outage at
Cloudflare stops every customer in the country ordering dinner, every rider
earning and every store selling — to prevent an attacker from spending SMS
credit that three independent limits still cap. That trades a bounded cost for
an unbounded one. Nobody reaches an account without the code.

`missing-input-secret` and `invalid-input-secret` are treated as unavailability
rather than rejection for the same reason: those are *our* misconfiguration, and
refusing every customer over it would be loud in the log and invisible on the
screen.

### Both keys, or none

`isCaptchaConfigured()` requires `TURNSTILE_SECRET_KEY` **and**
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`. Half a pair is a deployment where the widget
never renders and nobody can produce a token — reading that as "configured"
would lock out every customer, so it reads as "off" and the console says so in
red. The site key is read at request time rather than inlined into the client
bundle, so rotating the pair is a restart rather than a rebuild.

### The widget, and what it costs

Rendered explicitly rather than by the script's own DOM scan, because that scan
runs once on load and would never find the second step's widget. It appears on
**both** steps: "resend code" is the same server call as "send the code" with
the number already filled in, so exempting it would leave the bypass open at
identical cost per request.

The honest price of switching this on: the first login step was built to work
before the page has hydrated, and a CAPTCHA cannot be — it is JavaScript by
construction. With a pair configured, signing in needs JavaScript, and both the
`<noscript>` note and the script-failed message say so rather than presenting a
button that will be refused.

### Verified

Wire tests run the adapter against a real HTTP server on a loopback socket and
assert the bytes Cloudflare would receive — method, content type, `secret`,
`response`, `remoteip`, and the percent-encoding of a token containing `+` and
`/` — plus every response shape siteverify can answer with. Then the whole path
was driven through the real login form against a local stand-in: no token, a
forged token and an expired token are all refused **with no `PhoneVerification`
row written and no SMS attempted**, a good token reaches the code step, and a
rejected secret lets the person through. What none of it establishes is
Cloudflare's own behaviour — this environment has no route to
`challenges.cloudflare.com`, so no real token has ever been checked from here.

## Demo data, and why it cannot be allowed to matter

`prisma/seed.ts` writes six accounts and three stores so a fresh clone has
something to click. Five of the six numbers belong to strangers in real life
and one of them — `0917 000 9999` — holds ADMIN. Nothing in the login flow can
tell that a row was invented, so on a production deployment whoever owns that
number could request a code and be an administrator.

The fix is not a checklist item. `User.isDemo` and `Store.isDemo` are set by
the seed and read by `src/lib/demo/policy.ts`, whose one rule is that a demo
account **cannot hold a session in production**:

```ts
export function signInIsPermitted(user, nodeEnv = process.env.NODE_ENV) {
  if (user.isBlocked) return false;
  if (user.isDemo && !demoDataIsUsable(nodeEnv)) return false;
  return true;
}
```

Called in two places, not one: `checkLoginCode()`, so a person gets a sentence,
and `loadSession()`, so a cookie minted before the deploy stops working too.
Both used to test `isBlocked` directly; one function now decides, and the
refusal message is identical for both reasons, because somebody who happens to
own a seeded number should learn nothing from the screen.

**The seed refuses to run where it was not asked to.** Two independent checks —
`NODE_ENV=production`, and a `DATABASE_URL` whose host is not local. The second
catches the likelier mistake by far: `npm run db:seed` in a terminal with a
production connection string exported and no NODE_ENV at all. `--force` exists
because a check with no way past it gets deleted rather than respected.

**Cleaning up is one command.** `npm run db:purge-demo` prints what would go and
stops; `--confirm` removes it. It deletes only the ids it printed, never a
predicate. Audit entries written *by* a demo administrator need `--and-audit`
as well: an audit row records what was done to somebody else, so it is not the
actor's to erase, and the purge names them and stops rather than deciding.

**And there is a way back in.** Purging removes the only ADMIN a fresh database
has, and there is deliberately no screen for granting console access — a screen
for making yourself an administrator would be the largest hole in the product.
`npm run admin:grant -- 09171234567 --reason "…"` does it from a shell, which
is honest about where the boundary really is: anybody with `DATABASE_URL` can
already write any row. What the script adds is the audit entry. It **refuses to
create the account**: it must already exist, which means the person has signed
in with that number and thereby proved they hold the phone. On the audit row,
`actorId` is the account that gained or lost the role, because a shell has no
identity to record — which is why `--reason` is mandatory and should name a
human.

The console's health page reports demo data as a health problem, in the same
sense as an undrained outbox, and says which command to run.

## Verification

Database-free, in CI (`npm run verify`) — **1544 tests across 42 files**. The
table below names the ones that carry a rule rather than a case; the rest cover
a single feature each and are named for it.

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
| `sms-wire.test.ts` | The exact bytes a gateway receives, over a real loopback socket |
| `push-crypto.test.ts` | RFC 8291 output pinned to the reference implementation; an independent decryptor; VAPID signing and refusals |
| `push-send.test.ts` | The Web Push request over a real socket; GONE versus FAILED on every status; what a browser may register |
| `admin-access.test.ts` | Who counts as an admin, the reason rule, Manila day boundaries, and grep rules that every action is authorised, reasoned and logged |
| `live-tracking.test.ts` | The four gates on a rider's position, the share throttle including a held fix, distance wording, and greps for the privacy boundary and the map's honesty |
| `payments.test.ts` | The no-top-up rule per instrument and in the database, the prepaid hold across every lifecycle, event signs, the derived status including a short payment, and what the rider is told to collect |
| `settlement.test.ts` | The order-value split proved exhaustive over every combination of fees, tips and commission; who holds the money per payment method; the cash round trip netting to zero; and the payout ceiling |
| `loyalty.test.ts` | Points earned on the food only and rounded down; the sign forced by type so an added redemption is unrepresentable; whole-block redemption leaving no fraction of a centavo at any rate; oldest-first expiry netting; and that nothing loyalty-shaped reaches the checkout |
| `referrals.test.ts` | Self-referral and re-attribution refused at every layer; the code alphabet excluding both members of each confusable pair; whether a given pair of amounts makes farming profitable; the Manila month boundary a cap resets on; and that no path exists from a referral to cash |
| `surge-alerts.test.ts` | Only a step up counts as news, proved over an hour of simulated measurements; the perishable rule dropping rather than deferring; the sustained-run clock arithmetic; and that no self-detecting stall alert exists |
| `surge-pricing.test.ts` | The step ladder proved monotonic across the whole ratio range on a mistyped ladder as well as a good one, the ceiling agreeing with the SQL guard, every uncertainty resolving to ₱0, a free-delivery benefit not reaching the rider's surge, and greps that the sweep measures after the timeout pass and the screen sends the figure it displayed |
| `menu-options.test.ts` | Server-authoritative choice pricing, group bounds, satisfiability, and every tamper case |
| `menu-photos.test.ts` | Magic-byte sniffing, dimension limits, and the bytes never entering a page payload |
| `fleet-verification.test.ts` | Who may decide an application, per-service independence, and what the partner is told |
| `public-routes.test.ts` | Which subtrees are reachable without a session, asserted against the middleware itself |

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
