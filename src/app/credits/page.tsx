import { WalletTransactionType } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth/session';
import {
  getSpendableCentavos,
  listWalletTransactions,
  WALLET_CONSTRAINTS,
} from '@/lib/wallet/ledger';
import { formatCentavos } from '@/lib/money';

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
  [WalletTransactionType.ORDER_PAYMENT]: 'Spent on an order',
  [WalletTransactionType.ADJUSTMENT]: 'Adjustment',
};

export default async function CreditsPage() {
  const user = await getCurrentUser();

  const [balanceCentavos, transactions] = user
    ? await Promise.all([
        getSpendableCentavos(user.id),
        listWalletTransactions(user.id, { limit: 50 }),
      ])
    : [0, []];

  return (
    <main>
      <header className="bg-gradient-to-br from-brand-700 to-brand-900 px-4 pb-6 pt-6 text-white">
        <h1 className="text-sm font-semibold uppercase tracking-wide text-white/75">
          {WALLET_CONSTRAINTS.uiLabel}
        </h1>
        <p className="mt-1 text-3xl font-bold tabular-nums">
          {formatCentavos(balanceCentavos)}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-white/80">
          Rewards from us — promos, referral bonuses and refunds. Spend them on any
          order in the app.
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

      <section aria-labelledby="credits-history" className="mt-5">
        <h2
          id="credits-history"
          className="px-4 text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
        >
          History
        </h2>

        {transactions.length === 0 ? (
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
                    {transaction.createdAt.toLocaleDateString('en-PH', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
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
      </section>
    </main>
  );
}
