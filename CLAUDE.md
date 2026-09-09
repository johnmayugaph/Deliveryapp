# Working notes

## Verification

Every change is verified two ways, and no more:

1. **The four gates, checked by exit code** — not by reading the tail of the
   output, which has been misleading before:

   ```
   npm run lint          # ~4s
   npx tsc --noEmit      # ~7s
   npx vitest run        # ~12s, 2135 tests
   npx next build        # ~90s
   ```

2. **A browser pass** on the screen that changed, with real data in a live
   database. `next dev`, not a production build — demo users are refused
   sessions in production, so a production build cannot be signed into.

**No mutation round.** It was in the loop for the merchant audit and it earned
its keep, but it re-runs the suite a dozen times per change for a fraction of
the findings the browser gives. Deliberately dropped. What that costs: a test
that passes against broken code will not be caught, so a new assertion is worth
reading twice — a check that cannot fail is worse than no check, because it
reports safety it does not provide.

The browser is the round that has actually found things. Twice now a change had
passing units and rendered nothing at all: once because the data was gated on a
condition unrelated to it, once because a prop was never read. Units cannot see
either.

## This container

- **Postgres dies periodically.** Restart and wait for it:
  ```
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/dapg/data -o '-p 5433' -l /var/tmp/dapg/log start"
  until pg_isready -h 127.0.0.1 -p 5433 -q; do sleep 1; done
  ```
  `DATABASE_URL="postgresql://postgres@127.0.0.1:5433/tara"`
- **`prisma migrate dev` needs a TTY and fails here.** Use `migrate diff` +
  `migrate deploy` + `generate`. And `migrate diff --from-url` against the live
  database wants to DROP indexes the SQL guards created — hand-write the
  migration instead.
- **Never run `prisma format`.** It invents relations that are not wanted.
- **Never `git checkout` an uncommitted file.**
- Chromium for Playwright: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
  Free port 3000 with `fuser -k 3000/tcp` — never `pkill -f "next dev"`.
- Scratch scripts run under `tsx`, which **strips types rather than checking
  them**: an invalid enum member silently becomes `undefined` and Prisma falls
  back to the column default. A fixture that looks wrong on screen is usually a
  wrong fixture, not a wrong screen.

## Rules that hold everywhere

- **No hardcoded service list, and no `if (serviceType === 'FOOD')` in shared
  logic.** Read the service registry.
- **Credits are not a wallet.** No top-up, no transfers between users, no
  cash-out. Balance is spendable on orders only. Every change goes through the
  one ledger function that writes a `WalletTransaction` and recalculates the
  balance from the ledger — never write a balance field directly. Label it
  *credits* or *rewards* in the UI, never *wallet* or *e-money*.
- **Append-only tables** (`WalletTransaction`, `LoyaltyEntry`, `PaymentEvent`,
  `AdminAuditEvent`) are enforced by triggers. The lawful escape is
  `SET LOCAL tara.allow_purge = 'on'` in the **same transaction** as the delete.
- Money is integer centavos. Prisma `undefined` in a `data` block means "do not
  change this column" — write `null` to clear one.
