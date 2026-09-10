# The dry run

Deploy TARA and walk a real order through it **without paying for SMS** and
without touching a live customer. Fourteen steps. Every command and every
number below was run on a production build against a fresh PostgreSQL 16
database, in the order printed.

This is not [LAUNCH.md](./LAUNCH.md), which is about going live, and it is not
[DEPLOY.md](./DEPLOY.md), which explains why each step is shaped the way it is
and is the place to look when one of these fails. This file is the rehearsal:
the shortest path from an empty database to *money reconciling to the centavo*.

**What it costs:** nothing. No gateway, no top-up, no branded sender.

**What it therefore does not prove:** that a code reaches a real handset, and
that order notifications arrive. Both need a funded gateway, and both are
[LAUNCH.md step 1](./LAUNCH.md). Everything else in the product is exercised
here.

---

## 0 — What you need

- PostgreSQL 16, reachable.
- Node 22 and this repository.
- Four phone numbers you invent. They never receive anything, so they can be
  numbers nobody owns — use the `0999` prefix, which is not a real Philippine
  network, so a slip cannot text a stranger.

## 1 — A database, provisioned the operator's way

```bash
export DATABASE_URL="postgresql://postgres@127.0.0.1:5432/tara"
export DIRECT_URL="$DATABASE_URL"
npm ci
npm run db:setup
```

**Never `prisma migrate deploy` alone.** Migrations plus guards leave a schema
with no cities, no services and no delivery fee rules, and the home page then
answers 200 with *"No service is available in your area yet."* — the app
politely telling every customer you do not operate here, on a deployment where
nothing looks broken.

Measured on a fresh database:

| | |
| --- | --- |
| Migrations applied | 57 |
| SQL guard files | 20 |
| Tables | 64 |
| CHECK constraints | 90 |
| Triggers | 21 |
| Seeded | 5 cities, 5 services, 2 delivery fee rules, 6 demo accounts, 3 demo stores |

To count the constraints yourself, read `pg_constraint` and not
`information_schema` — the latter synthesises a CHECK per NOT NULL column and
answered **619** where the real number is 90:

```bash
psql "$DATABASE_URL" -tAc "select count(*) from pg_constraint
  where contype='c' and connamespace='public'::regnamespace;"
```

## 2 — Purge the demo data

```bash
npm run db:purge-demo              # dry run, prints what it would remove
npm run db:purge-demo -- --confirm
```

The seed writes six accounts on **real Philippine number formats** and one of
them holds ADMIN — strangers own those numbers in real life. The dry run prints
the warning that matters: *"after this there is no administrator account at
all."*

Measured: `Purged 6 account(s) and 3 store(s).` Cities, services, fee rules,
plans and FAQ content all survive.

**This is the step that makes the rest of this file necessary.** A purged
database has no accounts, no stores, no menu and no addresses, which is exactly
the state a real deployment starts in — and it is the state in which every gap
below was found.

## 3 — Build, and write the environment

```bash
npm run build
```

Then the environment. Four that are not optional, plus the one this file is
about:

```bash
DATABASE_URL="postgresql://…"
DIRECT_URL="postgresql://…"                 # prisma CLI only
AUTH_SECRET="$(openssl rand -hex 32)"
NEXT_PUBLIC_DEFAULT_CITY_ID="city_manila"

# The allowlist: these numbers sign in with the code named beside them,
# and no text message is sent.
AUTH_TEST_NUMBERS="09991110001:111111,09991110002:222222,09991110003:333333,09991110004:444444"
```

One number per role — customer, shop, rider, you. Pick codes you will not
mistype at three in the morning.

**What the allowlist is not.** It is not "OTP off". A number that is not on the
list takes the real path, and with no gateway configured that still means
refused. Verified on the production build below: an unlisted number never even
reached the code field. Every other rule is untouched — five-minute expiry,
single use, five wrong tries, the 45-second resend cooldown and both request
throttles.

## 4 — Boot the production build

```bash
cp -r .next/static .next/standalone/.next/static
cp -r public       .next/standalone/public
cd .next/standalone && NODE_ENV=production PORT=3000 node server.js
```

Then open `/login` and check both notices are there:

- a **red** one: *"This deployment cannot send login codes."* — still true, and
  deliberately not suppressed. The allowlist makes sign-in work for four
  numbers, not for a customer, and a clean login page would have you believing
  otherwise until the first real one arrived.
- an **amber** one: *"This deployment is in test mode."*, listing the masked
  numbers.

Two on-purpose facts about this step. `NODE_ENV=production` is required — demo
accounts are refused sessions in production, which is a safety net you want
running. And `http://127.0.0.1` works because browsers store `Secure` cookies
on loopback; on a real hostname over plain http the browser takes the code,
accepts the sign-in and silently discards the session. That is
[LAUNCH.md step 6](./LAUNCH.md), and it is the failure that looks like a
session bug.

## 5 — Sign in as all four, and name them

Open each number in its own browser profile or private window, enter its code,
and give each account a name when `/welcome` asks. The account is created the
moment the code is accepted.

Measured: all four landed on `/welcome`, then `/`, with `roles: {CUSTOMER}`.

> **The throttles apply to test numbers, and they will bite you here.** Three
> code requests per number per 15 minutes, and 45 seconds between two. A
> rehearsal that signs the same number in repeatedly hits the cap and the login
> screen stops offering a code field at all. `PhoneVerification` is not an
> append-only table, so the rehearsal reset is one line:
>
> ```bash
> psql "$DATABASE_URL" -c 'DELETE FROM "PhoneVerification";'
> ```
>
> Do not make a habit of it against anything real: those rows are the throttle.

## 6 — Become the administrator

```bash
npm run admin:grant -- 09991110004 --reason "dry run, first admin"
```

It **refuses a number that has never signed in**, which is why step 5 comes
first. Measured output:

```
  0999 111 0004 — Ops Admin
  roles: CUSTOMER  ->  CUSTOMER, ADMIN
  /admin works for them on their next page load.
```

If the account has signed in but not finished onboarding it grants anyway and
warns, exiting 0 — the gate `/admin` reads is `onboardedAt`.

## 7 — Create the shop

`/admin/stores` → **Add a partner shop**. Name, city, address, the owner's
number (09991110002), tick **Food**, and a reason for the audit log.

**The pin is required and it is the part that goes wrong.** Every delivery fee
from this shop is measured from it. Four ways in, and they all write the same
two visible number fields: search, tap the map, paste a Google Maps or Waze
link, or type the coordinates. If your network cannot reach the tile server the
map says so and the other three keep working — that is how this rehearsal was
done, typing `14.6042, 120.9822`.

## 8 — The shop adds a dish

Sign in as 09991110002 and open `/merchant`. The store is already attached, by
the owner's number from step 7.

`/merchant/<storeId>/menu` → **Add an item**. Name, section, price. One dish at
₱100 is enough for the whole rehearsal. The menu then reads *"1 of 1
orderable"*.

This comes before making the shop visible, and the order is not a preference —
the next step is refused without it.

## 9 — Make the shop visible

A new shop is created **hidden**, and this catches people out: the owner can
sign in, see their store and add a menu, and the shop still cannot be found.
The merchant header says so plainly — *"Nobody can find your shop right
now."* — and Settings explains that only TARA can change it.

`/admin/stores/<storeId>` → **Make visible**.

**Menu first, and the button says so.** Pressed on a shop with an empty menu it
refuses: *"That shop has no menu yet. A customer would find it, open it and see
nothing — have the owner add items first."* This file had these two steps the
other way round until a rehearsal ran them in the printed order and hit the
refusal.

## 10 — The rider applies, and you approve

As 09991110003: `/fleet/apply` → vehicle, plate, tick **Food**, apply. The
rider's own screen then reads *"Your approval is still pending. No offers will
arrive until a service is approved."*

As the administrator: `/admin/fleet` → the partner → **Approve for Food**.
Approval is **per service** — cleared to carry food is not cleared to carry a
passenger.

## 11 — The customer saves an address

As 09991110001: `/addresses` → fill in the form → **Save this address**.

The first address is made the default automatically, because `/checkout`
pre-selects the default. The pin here is the *delivery* end of the fee
measurement, so the same rules apply as step 7.

> This screen had **no form at all** until this rehearsal went looking for it.
> `/checkout` refused the order and linked here saying "Add an address"; this
> page answered "No saved addresses yet." and offered nothing. The seed writes
> addresses for the demo accounts, so the gap was invisible until step 2 —
> which is the first thing a real deployment does.

## 12 — Place the order

Open the shop from the home screen, **Add** the dish, then `/checkout`.
Measured on a 0.4 km delivery:

| | |
| --- | --- |
| Subtotal | ₱100.00 |
| Delivery (0.4 km) | ₱39.00 |
| Service fee | ₱10.00 |
| Small order fee | ₱20.00 |
| **Total** | **₱169.00** |

Pay **Cash on delivery** — the credits balance is ₱0.00 on a fresh account, and
credits are not a wallet you can load. Place it.

## 13 — Walk it through all four roles

**The shop** (`/merchant/<storeId>`, the Queue tab) has three separate taps,
and the order is not dispatchable until the third:

1. **Accept** — *"7m left to answer. After that TARA cancels it and refunds the
   customer."*
2. **Start cooking**
3. **Ready** — now *"19m for TARA to find a rider."*

**The sweep** is what offers the job. Nothing happens on a request:

```bash
npm run jobs:orders
```

The first run said `no approved partner online in range.` — **the rider has to
be Online.** As 09991110003, open `/fleet` and tap the Offline pill.

**Allow location when the browser asks.** Going online needs it, and a refusal
is silent: the pill shows its pending state, then settles back on Offline with
nothing said. A rider who denied the prompt once, or who is on a browser that
refuses it, taps that pill and simply stays offline — and the sweep then blames
the range.

Then run the sweep again:

```
DA-20260909-RNGX2: offered to 1 partner(s).
```

**The rider** has **60 seconds** to answer, so have `/fleet` open before you run
the sweep. Then **Accept**, and five more taps, each of which is a real status
change the customer's tracking screen follows:

```
I am at the pickup  →  I have the order  →  On my way
  →  I am at the dropoff  →  Delivered
```

## 14 — Check the money, which is the actual test

Three screens, three parties, one identity. Measured:

| Screen | Says |
| --- | --- |
| `/fleet/earnings` | holding TARA's cash **₱130.00** · earned **₱39.00** · collected ₱169.00 |
| `/merchant/<id>/payouts` | TARA owes you **₱100.00** |
| `/admin/settlement` | we owe **₱100.00** · cash held by riders **₱130.00** |

**₱130 = ₱100 + ₱30.** The rider hands in ₱130; ₱100 of it is the shop's food
subtotal and ₱30 is TARA's (the ₱10 service fee and the ₱20 small-order fee).
Commission is 0.00% until you negotiate one, which the settlement screen says
out loud: *"a default would have invented revenue and quietly changed what
every shop is owed."* The rider keeps the ₱39 delivery fee and the whole tip.

Check the same identity on yours. If those three numbers do not close, stop —
that is the one failure in this list worth halting a launch over.

Two things correctly show **nothing** on a fresh deployment, and neither is a
bug:

- **Credits ₱0.00 after a completed order.** Credit-back comes from a TARA Plus
  benefit, and no plan is active.
- **No loyalty points.** There is no loyalty programme until you make one.

Both are [LAUNCH.md step 10](./LAUNCH.md) — features that exist in full and do
nothing until switched on. `/admin/health` lists them so you do not have to
remember.

---

## When you are done

```bash
# Switch the allowlist off. This is the whole of it.
unset AUTH_TEST_NUMBERS   # and remove it from your compose file or unit
```

Then restart. The login screen's amber notice disappears; nothing else about the
deployment changes.

**Do not leave it set.** A fixed code is a password that never changes, and
those four accounts now have order history and a settlement balance against
them. `/admin/health` reports the allowlist in red for exactly this reason, and
lists any entry it could not parse — a typo otherwise means somebody entering a
code that cannot work with nothing anywhere saying why.

## What this rehearsal has caught

Kept here because a rehearsal that never finds anything is a rehearsal nobody
is really running:

| | |
| --- | --- |
| No way to add a delivery address | `/checkout` sent people to a page with no form. Purging the demo data was what exposed it. |
| Store-form copy on the customer's address screen | *"Where the shop is / Every delivery fee from this shop is measured from here"*, shown to somebody adding their own home. |
| A shop that is invisible with nothing saying why | Fixed in an earlier phase; step 9 exists because of it. |
| `information_schema` answering 619 CHECK constraints | The measuring instrument was the broken part. Fourth time in this project. |
| Steps 8 and 9 printed in an order the app refuses | Visibility is gated on the menu existing. Running the file top to bottom was what found it; they are now the other way round. |
| The Offline pill fails silently without location permission | It shows pending, then returns to Offline with no message, and `no approved partner online in range.` is what you see instead. |

## If something fails

- **Home page says "No service is available in your area yet."** → step 1 was
  `prisma migrate deploy` without the seed.
- **The login screen has no code field.** → the per-number throttle. See the
  note in step 5.
- **`no approved partner online in range.`** → the rider is Offline, was
  approved for a different service, or tapped the pill with location permission
  denied and stayed offline without being told.
- **The offer vanished before you could take it.** → 60 seconds. Have `/fleet`
  open before running the sweep.
- **Signed in, then immediately signed out.** → plain http on a real hostname.
  Terminate TLS and forward `X-Forwarded-Proto: https`.
- **Anything else** → [DEPLOY.md](./DEPLOY.md) has the reasoning behind each
  step and the measured output of every command in it.
