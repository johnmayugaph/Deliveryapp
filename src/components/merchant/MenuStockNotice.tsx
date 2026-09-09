'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { restoreAllStockAction } from '@/lib/actions/merchant-actions';
import { stockWarnings, type MenuStock } from '@/lib/merchant/menu-stock';

/**
 * What is not sellable on this menu, and the one tap that undoes a busy night.
 *
 * The restore control is the half of the out-of-stock switch that never
 * existed. The only writer of `isAvailable` was a single manual tap, so the
 * 8pm "the pork has run out" had no 6am counterpart, and putting eleven dishes
 * back meant eleven taps on a phone in a kitchen — which is why it did not
 * happen, and why a shop's menu quietly shrank one forgotten dish at a time.
 *
 * It is offered to staff for the same reason the individual switch is: whoever
 * opens the shop is whoever is on the counter.
 */
export function MenuStockNotice({
  storeId,
  stock,
}: {
  storeId: string;
  stock: MenuStock;
}) {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const warnings = stockWarnings(stock);
  /**
   * `note` is part of the condition, and that is not defensive padding.
   *
   * Seen in a browser: putting four dishes back succeeded, the page
   * refreshed, `markedOut` became zero, and this whole block — the note
   * included — unmounted before anybody could read "4 dishes are back on the
   * menu". The action computed a confirmation and threw it away, which is the
   * same defect this phase exists to fix, one layer up.
   */
  if (warnings.length === 0 && stock.markedOut === 0 && note === null) return null;

  return (
    <div className="mx-4 mb-2 space-y-2">
      {warnings.map((warning) => (
        <p
          key={warning.reason}
          role="status"
          className={`rounded-xl px-3.5 py-2.5 text-[12px] leading-relaxed ${
            warning.reason === 'CHOICES_RUN_OUT'
              ? 'bg-rose-50 text-rose-900'
              : 'bg-amber-50 text-amber-900'
          }`}
        >
          {warning.line}
        </p>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        {stock.markedOut > 0 ? (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setNote(null);
                const result = await restoreAllStockAction(storeId);
                setNote(result.message);
                if (result.ok) router.refresh();
              })
            }
            className="rounded-lg bg-surface-sunken px-3 py-2 text-[12px] font-semibold text-brand-700 disabled:opacity-60"
          >
            {pending
              ? '…'
              : stock.markedOut === 1
                ? 'Put 1 dish back in stock'
                : `Put all ${stock.markedOut} back in stock`}
          </button>
        ) : null}
        {/* Outside the button's own condition, so it survives the refresh
            that removes the button. */}
        {note ? (
          <span role="status" className="text-[11px] font-semibold text-emerald-800">
            {note}
          </span>
        ) : null}
      </div>
    </div>
  );
}
