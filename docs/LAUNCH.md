# Launching TARA

The order to do things in, with the traps marked. Twelve steps, and the first
three are the ones that decide how long the whole thing takes.

This is deliberately **not** a second copy of [DEPLOY.md](./DEPLOY.md). That
file explains why each step is shaped the way it is and quotes the measured
output of every command; this one says what to do next. Where a step needs a
reason, it links. Two documents describing the same commands is how one of them
starts lying — the defect this project has spent a dozen phases removing from
its own screens — so the rule here is: **the runbook owns the commands and the
reasoning, this file owns the order.**

**Want to see it work before spending anything?** [DRY-RUN.md](./DRY-RUN.md)
is the same product walked end to end on an allowlist of test numbers, with no
gateway and no top-up. Fourteen steps, every number measured. It postpones
step 1 rather than replacing it.

**Before anything:** [DEPLOY.md](./DEPLOY.md) is honest that the
`docker compose` wrappers have never been executed. The npm scripts inside them
are proven twice over; the container orchestration is not. Budget for
`docker compose up` to need a fix.

---

## The three things that set your timeline

| | Lead time | Blocks |
| --- | --- | --- |
| A Semaphore account with credit and a live API key | **hours** | all testing, all sign-in |
| A branded sender name (`TARA`, not the account default) | **days** — carrier approval | nothing, if you start with the above |
| A server, a domain, TLS | hours | going public |

**Testing does not wait on the branded sender.** A funded account with a key
sends from the account's default sender, and that is enough to answer the one
question this project could never answer from code — does a code actually reach
a handset. Start the branded application in parallel; when it is approved it is
one variable (`SEMAPHORE_SENDER_NAME`) and a restart.

Set that variable to a name that is not yet registered and Semaphore rejects
the message outright, so an approval you have not received yet is a gateway
that has stopped working. Leave it unset until the approval lands.

---

## 1 — Get one SMS gateway sending today

Nothing else can be tested until a code reaches a phone. Sign-in is OTP-only,
so with no gateway **nobody can sign in — not a customer, not a shop, not
you.**

Open a [Semaphore](https://semaphore.co) account, **buy credit** — an account
with a valid key and a zero balance sends nothing — and take the API key from
Account → API Keys. Then, from a machine with outbound internet:

```bash
SEMAPHORE_API_KEY=… npm run sms:send-one -- 09XXXXXXXXX
```

Use your own number, and read the output rather than the exit code: *accepted*
means queued, not delivered. Check the handset, and check the message id
against Semaphore's own dashboard for the final status.

Do not set `SEMAPHORE_SENDER_NAME` yet. Unset, the message goes out under the
account default; set to a name that has not been approved, the gateway rejects
it (HTTP 422) and you will spend the afternoon debugging the wrong layer.

**Do not skip this to save an hour.** It is the only step whose failure is
invisible from the code: everything in this repository about SMS is verified at
the wire and nothing is verified at the carrier.

### If you are not ready to top up yet

You can rehearse the whole application before paying for a single message, on
an **allowlist** of numbers that sign in with a code you choose:

```bash
AUTH_TEST_NUMBERS="09171234567:123456,09181234568:654321"
```

Those numbers get their code written straight to the database and no text is
sent. Everything else about them is a real login: same five-minute expiry, same
single use, same five wrong tries, same resend cooldown and request throttles.
So a rehearsal on this is a rehearsal of the real thing, minus the carrier.

What it deliberately is **not** is "OTP off". A number that is not on the list
takes the real path, and with no gateway configured that still means refused —
verified on a production build with no gateway: the listed number reached
`/welcome` with a session, and an unlisted one never got as far as a code
field. So this cannot be how a stranger who finds your URL gets in as somebody
else.

Two things follow from it being real, though:

- **A fixed code is a password that never changes.** Anybody who learns the
  pair owns that account until you unset the variable.
- **Unlike `SEMAPHORE_ENDPOINT`, this is honoured in production**, because a
  dry run happens on a production build. The price of that is noise: the login
  screen tells every visitor the deployment is in test mode and lists the
  masked numbers, and `/admin/health` reports it in red with the numbers and
  any entry it could not parse.

Unset it and restart before you have real customers. That is the whole of
switching it off; nothing else in the deployment changes.

Note it does not remove step 1 — it postpones it. Sign-in for everybody else,
and every order notification, still needs the gateway.

## 2 — Start the branded sender application

In parallel, not after. Apply through the same Semaphore account for a
registered sender name. This is the multi-day item: a code arriving from `TARA`
rather than the account default is worth real money in conversion and in the
number of people who believe the message, but it blocks nothing while step 1 is
carrying the load.

Semaphore wants DTI or SEC business registration for a branded sender. Have
that ready.

When it is approved, set `SEMAPHORE_SENDER_NAME=TARA`, restart, and run
`npm run sms:send-one` once more — the approval is on their side, and the only
way to know it took effect is a message that arrives with the new name on it.

## 3 — A server, Postgres 16, and a domain

One small VPS is enough to start. Point the domain at it now so the TLS
certificate in step 6 has something to validate against.

## 4 — Write the environment

Copy `.env.example` — it lists every variable with a comment on what breaks
without it. The four that are not optional:

```bash
DATABASE_URL="postgresql://…"          # Postgres 16
DIRECT_URL="postgresql://…"            # prisma CLI only; the runtime ignores it
AUTH_SECRET="$(openssl rand -hex 32)"  # rotating it signs everybody out
NEXT_PUBLIC_DEFAULT_CITY_ID="city_manila"
```

Then the gateway:

```bash
SEMAPHORE_API_KEY=…
SEMAPHORE_SENDER_NAME=TARA   # ONLY once step 2 is approved. Wrong = every send rejected.
```

**Know what you are accepting here.** Every session in the application starts
with a code over SMS, so this one account is a single point of failure for the
entire product: an expired card, an empty balance or an hour of provider
downtime locks out customers, shops, riders and support simultaneously. There
is one adapter and no failover — this build does not hedge it. What it does do
is refuse to pretend: with no gateway configured a production deployment will
not start a login, `/admin/health` reports it, and the login screen reports it
to whoever loads the page, because in that state nobody can reach
`/admin/health` at all.

So the operational answers are the boring ones: **keep credit on the account**
and put the balance on whatever you already check daily. A second gateway is a
file in `src/lib/auth/sms/` plus one registry entry if you later decide the
outage risk is worth the second bill.

Also set `BACKUP_ENCRYPTION_KEY` now. Without it your database dumps hold every
customer's phone number and home address in plaintext.

## 5 — Deploy, and check `ps` before anything else

```bash
mkdir -p ./backups && sudo chown 1000:1000 ./backups
docker compose up -d --build
docker compose ps
```

The `chown` is not cosmetic and the `ps` is part of the deploy — a `backup`
container in `Restarting` means you skipped it, and without it the backup loop
fails silently while reporting healthy. See
[DEPLOY.md → The sequence](./DEPLOY.md#the-sequence).

## 6 — TLS, before you sign in even once

Put Caddy or nginx in front. The app publishes on `127.0.0.1:3000` and
terminates no TLS.

**This failure is silent.** Session cookies are `Secure` in production, so over
plain HTTP the browser takes the code, accepts the sign-in, and discards the
session — the next page comes back signed out with no error anywhere. Codes
send fine; nobody stays signed in.

## 7 — Provision the database with `db:setup`

```bash
docker compose run --rm ops npm run db:setup
```

**Never `prisma migrate deploy` alone.** Migrations plus guards leave a schema
with no cities, no services and no delivery fee rules, and the home page then
answers **200** with *"No service is available in your area yet."* — the app
politely telling every customer you do not operate here, on a deployment where
nothing looks broken. Reproduced at both rehearsals.

Expect 57 migrations, 20 guard files, then 64 tables / 90 CHECK constraints /
21 triggers.

## 8 — Purge the demo data

```bash
docker compose run --rm ops npm run db:purge-demo             # dry run
docker compose run --rm ops npm run db:purge-demo -- --confirm
```

The seed writes six accounts on **real Philippine number formats** — strangers
own those numbers, and one of them holds ADMIN.

## 9 — Become the first administrator

The order here is forced, and it is why step 1 comes first:

1. Open your live site and **sign in with your own number.** The account is
   created the moment you enter the code. (No gateway yet? Put your own number
   on the `AUTH_TEST_NUMBERS` allowlist from step 1 and sign in with the code
   you chose — the account it creates is an ordinary account.)
2. Then grant yourself the role:

```bash
docker compose run --rm ops npm run admin:grant -- 09171234567 --reason "first admin, launch"
```

`admin:grant` **refuses a number that has never signed in** and exits 1 — it
will not fabricate an account for a number nobody has answered.

If you have signed in but not finished onboarding it **grants anyway and warns
you**, exiting 0: *"They have not finished onboarding — the app will ask for a
name before /admin opens. That is expected."* The gate `/admin` reads is
`onboardedAt`, so finish the name prompt and the console opens on the next page
load.

## 10 — Turn on what ships switched off

Open `/admin/health` — it lists this so you do not have to remember. On a
correctly provisioned, purged database it names exactly two gaps.

| Thing | Ships as | Where |
| --- | --- | --- |
| Loyalty programme | **none** — no points, so no tiers, so no tier benefits | `/admin/loyalty` |
| Surge bands | **none** — busy periods never priced, riders never earn a multiplier | `/admin/surge` |
| TARA Plus plan | **inactive** — nobody can subscribe | `npm run plan:activate` |
| Support contact | **unset** — somebody who cannot sign in can reach nobody | `SUPPORT_PHONE` |

Launching with no surge and no loyalty is a defensible choice. Not knowing you
did is not. The support contact is the only one on this list whose absence
costs somebody their account rather than a feature.

## 11 — Onboard the first shop and the first rider

- **Shop:** `/admin/stores` → create it, set its pin, then grant the owner
  access by phone number. They must have signed in once first, same rule as
  step 9. They write their own menu at `/merchant/<storeId>/menu`.
- **Rider:** they apply at `/fleet/apply` per service; you approve at
  `/admin/fleet`. Approval is **per service** — cleared to carry food is not
  cleared to carry a passenger.

One limit worth knowing before you promise anything: a store's name or address
cannot be changed after creation without a database edit.

**Adding a town is now three clicks, not a redeploy.** `/admin/areas` creates
the city, `/admin/services` launches a service in it, and `/admin/areas` prices
delivery there. The order matters and the screen says so — a city with a live
service and nothing pricing delivery is one where checkout FAILS rather than
one that politely says it is closed, so set a **fallback** fee rule per service
once and every city you add afterwards is priced from the moment you launch in
it.

## 12 — Prove it with one real order

Place a FOOD order, accept it on the shop's Queue tab (`/merchant/<storeId>`),
mark it cooking then ready,
let the sweep offer it, take it as the rider, deliver it.

This whole path was walked on the production build during the staging
rehearsal, so you know what correct looks like. On a ₱169 order — ₱100 food,
₱39 delivery, ₱10 service, ₱20 small-order — the money landed as:

| | |
| --- | --- |
| Rider hands in | ₱130.00 |
| TARA owes the shop | ₱100.00 |
| TARA keeps | ₱30.00 |

₱130 = ₱100 + ₱30. Check the same identity on yours: `/fleet/earnings`,
`/merchant/<storeId>/payouts` and `/admin/settlement` should agree to the
centavo.

Two things will correctly show **nothing** on a fresh deployment: no credit-back
and no loyalty points. Both come from benefit rows, and with no active plan and
no loyalty programme there are none. That is step 10 unfinished, not a bug.

---

## Keep two loops alive

```bash
docker compose logs -f cron    # quiet, not erroring
curl -s -o /dev/null -w '%{http_code}\n' https://yourdomain/api/health   # 200
```

Without the sweep: riders are never offered jobs, shops are never told about
orders, nothing times out or refunds, credits never unfreeze, subscriptions
never bill, points never expire. **Orders sit there forever.** Point your
uptime monitor at `/api/health` — it answers **503** when the database is
unreachable and 200 otherwise, and says nothing else on purpose.

## Prove the backups, do not assume them

```bash
docker compose run --rm ops npm run db:backup -- --dir /backups --keep 14
docker compose run --rm ops npm run db:restore-check -- --dir /backups
```

A dump alone is **not yet proven** — the script says so itself.
`restore-check` restores into a throwaway database and verifies it, reporting
tables, rows, that ledger balances match and that the append-only triggers are
present.

---

## Where this will actually bite you

1. **Step 1**, if you skip it. It is the only step whose failure cannot be seen
   from the code, and every later step assumes somebody can sign in.
2. **Step 5**, because the compose path has never run.
3. **Step 6**, because it fails silently and looks like a session bug.
4. **Step 10**, because nothing is broken and two features simply do nothing.

Everything else in this list has been executed against a real database and a
real production build.
