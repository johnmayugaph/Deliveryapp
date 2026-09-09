import Link from 'next/link';
import { WalletTransactionType } from '@prisma/client';
import { requireScreen } from '@/lib/auth/access';
import { creditsState, describeHold } from '@/lib/wallet/held';
import { fetchCount, pageOf, readCursor } from '@/lib/pagination/pages';
import { OlderPager, StrandedPage } from '@/components/ui/OlderPager';
import {
  readCreditsBalance,
  listWalletTransactions,
  WALLET_CONSTRAINTS,
} from '@/lib/wallet/ledger';
import { formatCentavos } from '@/lib/money';
import { RedeemGiftCard } from '@/components/credits/RedeemGiftCard';
import { formatFullDayIn, formatLongDayIn } from '@/lib/time/manila';

export const dynamic = 'force-dynamic';

/**
 * Credits.
 *
 * Labelled "Credits" throughout — never "Wallet", "e-wallet", or "e-money".
 * The copy on this screen states the constraints plainly rather than leaving
 * customers to discover them: no top-up, no sending to another person, no
 * cash-out, spendable on orders here.
 */

/** Customer-facing labels for ledger entries. */
const TYPE_LABELS: Readonly<Record<WalletTransactionType, string>> = {
  [WalletTransactionType.PROMO_CREDIT]: 'Promo credit',
  [WalletTransactionType.REFUND]: 'Refund',
  [WalletTransactionType.REFERRAL_BONUS]: 'Referral bonus',
  [WalletTransactionType.GIFT_CARD]: 'Gift card',
  [WalletTransactionType.ORDER_PAYMENT]: 'Spent on an order',
  [WalletTransactionType.ADJUSTMENT]: 'Adjustment',
};

export default async function CreditsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /* The hero on this screen is a peso figure. With no user it rendered
     ₱0.00 — not "we could not check", but zero, in the largest type on the
     page, to somebody whose session had simply ended. A balance is the one
     thing a screen must never guess at. */
  const user = await requireScreen('credits');

  /* The balance is always the whole ledger — `getSpendableCentavos` sums every
     row and is not affected by which page is on screen. Only the history
     below is paged, and it needed to be: the rows that EXPLAIN the figure at
     the top of this screen were the ones that fell off the end at fifty. */
  const cursor = readCursor((await searchParams).before);
  const [wallet, fetched] = await Promise.all([
    readCreditsBalance(user.id),
    listWalletTransactions(user.id, {
      limit: fetchCount(),
      before: cursor,
    }),
  ]);
  /* The BALANCE, not the spendable figure. `getSpendableCentavos` reports zero
     for a held wallet — correct for a bill, and a lie as a balance. This
     screen showed that zero while its own ledger rows below it added up to
     something else, and said nothing about a hold: the comment on that
     function claimed this screen explained it, and no code here ever did. */
  const credits = creditsState(wallet, new Date());
  const balanceCentavos = wallet.balanceCentavos;
  const holdNote = describeHold(credits, formatCentavos, (date) =>
    formatLongDayIn(date),
  );
  const {
    rows: transactions,
    olderCursor,
    strandedPage,
  } = pageOf(fetched, cursor);

  return (
    <main>
      <header className="bg-gradient-to-br from-brand-700 to-brand-900 px-4 pb-6 pt-6 text-white">
        <h1 className="text-sm font-semibold uppercase tracking-wide text-white/75">
          {WALLET_CONSTRAINTS.uiLabel}
        </h1>
        <p className="mt-1 text-3xl font-bold tabular-nums">
          {formatCentavos(balanceCentavos)}
        </p>
        {holdNote ? (
          <p className="mt-2 rounded-lg bg-white/15 px-3 py-2 text-xs leading-relaxed text-white">
            {holdNote}
          </p>
        ) : null}
        <p className="mt-2 text-xs leading-relaxed text-white/80">
          Rewards from us — promos, referral bonuses, gift cards and refunds.
          Spend them on any order in the app.
        </p>
      </header>

      {/* The constraints, said out loud. A customer should never discover these
          at the moment they are counting on the opposite. */}
      <section
        aria-labelledby="credits-rules"
        className="mx-4 mt-4 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="credits-rules" className="text-[13px] font-semibold">
          How Credits work
        </h2>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-ink-muted">
          <li>• This is not an e-wallet. You cannot load your own money into it.</li>
          <li>• It cannot be sent to another person or transferred.</li>
          <li>• It cannot be withdrawn or cashed out.</li>
          <li>• Spend it on orders in this app — that is all.</li>
        </ul>
      </section>

      {/* Above the earning links on purpose: somebody who arrived holding a
          card came here to type it, not to read about points. It used to be
          hidden when nobody was signed in, so that typing a code could not
          bounce to the login screen and lose it — the gate on this screen
          makes that unreachable, and a condition that cannot be false is
          worse than none: it reads as a case somebody handled. */}
      <RedeemGiftCard />

      {/* Where credits come from, on the screen where somebody is looking at
          how few they have. The two earning paths a customer controls. */}
      <Link
        href="/points"
        className="mx-4 mt-4 flex items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 shadow-sm ring-1 ring-black/5"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Points</span>
          <span className="mt-0.5 block text-[11px] text-ink-muted">
            Earned on every order, turned into credits
          </span>
        </span>
        <span aria-hidden className="text-sm text-ink-faint">
          →
        </span>
      </Link>

      <Link
        href="/invite"
        className="mx-4 mt-4 flex items-center justify-between gap-3 rounded-xl bg-surface px-4 py-3 shadow-sm ring-1 ring-black/5"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Invite friends</span>
          <span className="mt-0.5 block text-[11px] text-ink-muted">
            Credits for you and for them
          </span>
        </span>
        <span aria-hidden className="text-sm text-ink-faint">
          →
        </span>
      </Link>

      <section aria-labelledby="credits-history" className="mt-5">
        <h2
          id="credits-history"
          className="px-4 text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
        >
          History
        </h2>

        {strandedPage ? (
          <StrandedPage basePath="/credits" label="credits history" />
        ) : transactions.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">
            No credits activity yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-black/5">
            {transactions.map((transaction) => (
              <li
                key={transaction.id}
                className="flex items-start gap-3 bg-surface px-4 py-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {TYPE_LABELS[transaction.type]}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-ink-muted">
                    {transaction.description}
                  </span>
                  <span className="mt-1 block text-[11px] text-ink-faint">
                    {formatFullDayIn(transaction.createdAt)}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span
                    className={`block text-sm font-semibold tabular-nums ${
                      transaction.amountCentavos > 0 ? 'text-emerald-700' : 'text-ink'
                    }`}
                  >
                    {transaction.amountCentavos > 0 ? '+' : '−'}
                    {formatCentavos(Math.abs(transaction.amountCentavos))}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-ink-faint tabular-nums">
                    {formatCentavos(transaction.balanceAfterCentavos)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {strandedPage ? null : (
          <OlderPager
            basePath="/credits"
            olderCursor={olderCursor}
            onFirstPage={cursor === null}
            label="credits"
          />
        )}
      </section>
    </main>
  );
}
