# Deploying TARA

Every command in this file was run against a real database and a real
production build during a deployment rehearsal, and the output quoted is what
came back. Nothing here is a plan. Where the rehearsal found something broken,
it says so and says what was changed.

It is written for the shape in `docker-compose.yml` — one machine, Docker, a
reverse proxy in front. On a managed platform the sequence is the same; only
how you invoke the two images differs.

---

## What you must have before you start

Four variables. The application refuses to start without the first two and
misbehaves in specific, documented ways without the others.

| Variable | Why |
| --- | --- |
| `DATABASE_URL` | Postgres 16. Nothing works without it. |
| `AUTH_SECRET` | `openssl rand -hex 32`. Sessions are signed with it; rotating it signs everybody out. |
| `NEXT_PUBLIC_DEFAULT_CITY_ID` | Which city a first-time visitor sees. Defaults to `city_manila`. |
| An SMS gateway | **The only long-lead item.** Without one nobody can sign in — see below. `SEMAPHORE_API_KEY`, or Twilio's `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + an origin. Set both to survive an outage. |

`DIRECT_URL` is needed by `prisma migrate` only, and only because the schema
declares it: the CLI refuses to load a schema whose referenced variables are
missing, before it looks at any database. The runtime does not need it — the
order sweep was run with `DATABASE_URL` alone and completed normally.

Everything else in `.env.example` is optional, and `/admin/health` reports what
is missing rather than pretending.

### The SMS gateway is the thing to start first

A Philippine SMS sender needs an account and, for a branded sender name, an
approval that takes days. Nothing in this repository shortens that. Until it is
in place **no one can sign in at all** — not a customer, not a shop, not you.
Order that before you order the server.

**You do not have to wait to test, though.** Twilio signs up in minutes and
sends from a shared sender, which is enough to answer the question this project
had never been able to answer — does a code actually reach a handset. Point
`SMS_PROVIDER_ORDER` at it, keep the branded application running in parallel,
and switch the order when the local sender is approved.

**Configure both, not one.** Every session in the application starts with a
code over SMS, so a single gateway is a single point of failure for the whole
product: an expired card or an hour of provider downtime locks out customers,
shops, riders and support simultaneously, and the only symptom is sends that
throw. With two configured, the first to accept wins. The cost is stated in
`lib/auth/sms/fallback.ts`: a gateway that accepts and then fails to answer is
retried, so a customer can receive the same code twice. Both messages carry the
same code against the same single-use record, so that is a few centavos and an
annoyance rather than a security problem.

---

## The sequence

```
mkdir -p ./backups && sudo chown 1000:1000 ./backups
docker compose up -d --build
docker compose run --rm ops npm run db:setup
docker compose run --rm ops npm run db:purge-demo -- --confirm
docker compose ps
docker compose logs -f web
```

**`db:setup`, not `prisma migrate deploy`.** This file used to say the latter,
and the rehearsal found out why that is wrong: migrations plus the guards leave
a schema with **no cities, no services and no delivery fee rules**, and there
is no screen and no script that creates any of them — `prisma/seed.ts` is the
only thing in the repository that does. Booted against such a database, the
home page answers **200** with:

```
No service is available in your area yet. We will come back to you.
```

which is the app politely telling every customer that the business does not
operate here, on a deployment where nothing looks broken. `db:setup` is
`migrate deploy && prisma:guards && db:seed`; the purge on the next line takes
the demo accounts and shops back out and keeps exactly that operating data.

The first line is not cosmetic. Docker creates a missing bind-mount source as
`root:root 0755`, and the ops image runs as uid 1000 — so without it the backup
service cannot write to `/backups`. The rehearsal measured what that looks like:

```
Error: EACCES: permission denied, mkdir '/backups'
```

...swallowed by the loop's `|| true`, retried every sixty seconds, container
reporting healthy, no backups. The loop now checks writability once at start
and exits, so it crash-loops visibly instead. **`docker compose ps` after the
first `up` is part of the deploy** — a `backup` container in `Restarting` means
that `chown` was skipped.

### What `db:setup` does, measured

`db:setup` is `prisma migrate deploy && npm run prisma:guards && npm run
db:seed`. On a database created empty, in this order:

```
57 migrations found in prisma/migrations
All migrations have been successfully applied.
Applied 20 guard file(s).
Seeding TARA into …
Done.
```

and the result, counted directly:

```
tables              64
CHECK constraints   90
triggers            21
migrations applied  57
```

These four numbers are re-measured on every rehearsal, and the migration count
is the only one that has moved: it was 56 when this file was written and is 57
since `20260909180000_menu_out_of_stock_since`. Tables, CHECK constraints and
triggers are unchanged, which is the useful part — thirteen phases of screen
work added one column and touched no guard.

Count the CHECK constraints from `pg_constraint`, not from
`information_schema.table_constraints`. The latter synthesises a CHECK row for
every NOT NULL column, so it answers **619** on this schema against the real
90, and a rehearsal that used it would report a wild discrepancy and go looking
for a problem that is not there. (It did, on this one.)

```
SELECT count(*) FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = c.connamespace
 WHERE c.contype = 'c' AND n.nspname = 'public';
```

The guards are the third of those numbers. They are **not** in the Prisma
migrations — they are applied by `scripts/apply-sql-guards.mjs`, which shells
out to `psql`. That is why the ops image carries the Postgres 16 client, and
why running `prisma migrate deploy` alone gives you a database with the tables
but without the append-only triggers on the credits ledger. If you ever apply
migrations by hand, run `npm run prisma:guards` after.

---

## Before anybody can reach it

`db:seed` writes demo data, and the seed says so itself. It uses real
Philippine number formats, so a stranger owns every one of those numbers.

```
docker compose run --rm ops npm run db:purge-demo
docker compose run --rm ops npm run db:purge-demo -- --confirm
```

The first is a dry run and removes nothing. Both print the warning that
matters:

```
WARNING: after this there is no administrator account at all.
Nobody will be able to open /admin. Make one first, or straight
afterwards, on a number you control:

  npm run admin:grant -- 09171234567 --reason "first admin, launch"
```

`admin:grant` refuses a number that has never signed in, and exits 1:

```
No account with 0917 123 0000.

Ask them to open the app and sign in with that number once —
the account is created the moment they enter the code. Then run
this again. Creating it here would grant console access to a
number nobody has answered.
```

So the real order is: **purge, sign in yourself on the live site with your own
number, then grant.** Which means the SMS gateway has to be working before you
can have an administrator. There is no way around this and it is deliberate.

---

## What is switched off until you switch it on

After the purge the database keeps the operating data and nothing else.
Counted on the rehearsal database:

| | |
| --- | --- |
| Cities | 5 |
| Services | 5, of which **only `FOOD` is active** — the other four are `isComingSoon` |
| Delivery fee rules | 2 |
| Subscription plan | 1, **`isActive = false`** |
| FAQ | 3 categories, 6 articles |
| Loyalty programme | **0** |
| Loyalty tiers | **0** |
| Surge bands | **0** |
| Accounts, stores, orders | 0 |

The three zeros are worth understanding, because each one means a feature that
exists in full and does nothing at all on a fresh deployment:

- **No loyalty programme** means no points are earned, which means no tiers,
  which means no tier benefits. Create it at `/admin/loyalty`.
- **No surge bands** means no surge is ever charged and riders never see a
  multiplier. Create them at `/admin/surge`. Launching without any is a
  reasonable choice; not knowing you did is not.
- **The plan is inactive**, so nobody can subscribe. Activate it when you are
  ready to bill.

Onboarding real shops and riders is console work from there.

`/admin/health` now reports all of this, so it is a checklist rather than
something to remember. On a database provisioned the wrong way it names five
gaps; on one provisioned as above and purged, two:

```
2 features are switched off because the rows they read do not exist.

  No points programme exists, so no customer earns points — which means
  no tiers, and no tier benefits, however many are configured.
  /admin/loyalty

  There are no surge bands, so busy periods are never priced and riders
  never earn a multiplier. Fine as a launch choice, worth knowing if it
  was not one.
  /admin/surge
```

**A limit worth knowing.** `City` and `DeliveryFeeRule` rows can be created
only by `prisma/seed.ts` — there is no console screen and no script. Adding a
sixth city or a third fee band today means editing that file and running the
seed again. The panel says so rather than pointing at a page that cannot do
it.

---

## TLS is not optional, and the failure is silent

`docker-compose.yml` publishes the app on `127.0.0.1:3000` and terminates no
TLS. Put Caddy, nginx or a load balancer in front, and make it forward
`X-Forwarded-Proto: https`.

This is the one failure the rehearsal could not find by testing locally, and
it was measured rather than reasoned about. The session cookie carries `Secure`
in production. Browsers make an exception for loopback, so:

```
over http · localhost, Secure        (how you will test)    -> stored
over http · a real domain, Secure    (how you will deploy)   -> DROPPED
over http · a real domain, no Secure (development mode)      -> stored
```

A dropped cookie is not an error. The code sends, the code is correct, the
sign-in succeeds, and the next page is signed out. Nothing throws and nothing
is logged.

Because of that, `/login` now checks at request time and says so on the page
itself — that screen and no other, because if nobody can sign in then nobody
can reach `/admin/health` where every other misconfiguration is reported. It
covers both this and a missing SMS gateway. On a correctly configured
deployment, and on every development one, it renders nothing.

---

## Running it without Docker

The rehearsal also booted the real production server directly, which nothing
in the project's history had done before. The standalone bundle needs three
things next to each other, and `next build` does not assemble them for you:

```
NODE_ENV=production npx next build
cp -r .next/static  .next/standalone/.next/static
cp -r public        .next/standalone/public
cd .next/standalone && NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 node server.js
```

```
▲ Next.js 15.1.3
✓ Ready in 72ms
```

`HOSTNAME=0.0.0.0` matters: the standalone server binds localhost by default,
which inside a container means nothing outside it can connect. `npm start` is
`next start`, which serves the ordinary build and needs the full
`node_modules`; the image runs `node server.js` on the traced standalone
bundle instead — 86 MB against 737 MB, and no build tooling on the machine
answering customer requests.

Check it answers:

```
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/health
200
```

`/api/health` returns **503** when the database is unreachable and 200
otherwise, and says nothing else on purpose. It is what the container
healthcheck and a load balancer should watch.

---

## The two things that must keep running

### The order sweep

Without it: riders are never offered jobs, stores are never told about orders,
notifications never send, abandoned orders never time out or refund, recovered
credits never unfreeze, subscriptions never bill or lapse, points never expire,
and new faults never reach an administrator. Orders sit there forever.

`docker-compose.yml` runs it in a loop with `sleep 90`. Run once by hand:

```
docker compose run --rm ops npm run jobs:orders
```

```
No stale orders.
```

That was with `DATABASE_URL` and `AUTH_SECRET` and nothing else, which is what
the `cron` service sets.

### Backups, and the drill that proves them

```
docker compose run --rm ops npm run db:backup -- --dir /backups --keep 14
docker compose run --rm ops npm run db:restore-check -- --dir /backups
```

A real dump on the rehearsal database:

```
Wrote 0.26 MB
sha256 235203991a9b62c0…
archive lists 64 table(s)

NOT YET PROVEN. Run this next, ideally on a schedule too:
  npm run db:restore-check
```

**Set `BACKUP_ENCRYPTION_KEY`.** Without it the script says, correctly:

```
NOT ENCRYPTED. This file will contain every customer's phone
number and home address in plaintext.
```

Keep that key somewhere that survives the loss of the machine. A dump you
cannot decrypt is not a backup.

The compose `backup` service does both daily — and the rehearsal found the
schedule broken. It tested `if [ "$now" = "1800" ]`, which only sees the minute
the loop happens to sample, and the loop samples nothing while a job is
running. Driven under a compressed clock with a dump that takes four hours:

```
old loop:  [1800] ran db:backup          ← and the 18:30 check never ran, ever
new loop:  [1800] ran db:backup
           [2200] ran db:restore-check   ← as soon as the dump returned
```

That failure arrives on the day the database grows past a thirty-minute dump,
which is the same day the drill starts being worth having. It is now a
once-per-UTC-day latch with `-ge`, which is immune to both that and to sampling
drift, and which takes a backup immediately on a deployment first brought up
mid-afternoon rather than leaving it unprotected until tomorrow.

None of this replaces point-in-time recovery on a managed database. It is the
second line.

---

## Where the operator looks afterwards

`/admin/health`, signed in as an administrator. It reports the notification
backlog per channel, a half-configured CAPTCHA, demo data still present, and
whether there is a real administrator at all. The two things it cannot report
are the two on `/login`, for the reason given above.
