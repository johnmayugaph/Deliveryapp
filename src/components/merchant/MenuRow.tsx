'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  setItemAvailabilityAction,
  setItemPriceAction,
} from '@/lib/actions/merchant-actions';
import { formatCentavos } from '@/lib/money';

/**
 * One menu item.
 *
 * Availability is a single tap because it changes hourly — the pork runs out at
 * lunch. Price editing is behind an explicit edit step and MANAGER access,
 * because it is the one control here with money attached.
 */
export function MenuRow({
  storeId,
  item,
  canEditPrice,
}: {
  storeId: string;
  item: { id: string; name: string; category: string; priceCentavos: number; isAvailable: boolean };
  canEditPrice: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [pesos, setPesos] = useState((item.priceCentavos / 100).toFixed(2));
  const [isPending, startTransition] = useTransition();

  return (
    <li className="bg-surface px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <span className={`min-w-0 flex-1 ${item.isAvailable ? '' : 'opacity-50'}`}>
          <span className="block text-sm font-medium">{item.name}</span>
          <span className="mt-0.5 block text-[11px] text-ink-faint">
            {item.category}
            {item.isAvailable ? '' : ' · Wala ngayon'}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {editing ? (
            <span className="flex items-center gap-1">
              <span className="text-xs text-ink-muted">₱</span>
              <input
                type="number"
                inputMode="decimal"
                min="1"
                max="10000"
                step="0.01"
                value={pesos}
                onChange={(event) => setPesos(event.target.value)}
                autoFocus
                className="w-20 rounded-lg bg-surface-sunken px-2 py-1 text-right text-xs tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                type="button"
                disabled={isPending}
                onClick={() =>
                  startTransition(async () => {
                    setError(null);
                    const centavos = Math.round(Number(pesos) * 100);
                    const result = await setItemPriceAction(storeId, item.id, centavos);
                    if (result.ok) {
                      setEditing(false);
                      router.refresh();
                    } else {
                      setError(result.message);
                    }
                  })
                }
                className="rounded-lg bg-brand-700 px-2 py-1 text-xs font-semibold text-white disabled:bg-ink-faint"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setPesos((item.priceCentavos / 100).toFixed(2));
                  setError(null);
                }}
                className="text-xs font-semibold text-ink-faint"
              >
                Cancel
              </button>
            </span>
          ) : (
            <>
              <span className="text-sm font-semibold tabular-nums">
                {formatCentavos(item.priceCentavos)}
              </span>
              {canEditPrice ? (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="text-[11px] font-semibold text-brand-700"
                >
                  Edit
                </button>
              ) : null}
            </>
          )}

          <button
            type="button"
            disabled={isPending}
            aria-pressed={item.isAvailable}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await setItemAvailabilityAction(
                  storeId,
                  item.id,
                  !item.isAvailable,
                );
                if (result.ok) router.refresh();
                else setError(result.message);
              })
            }
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors disabled:opacity-60 ${
              item.isAvailable
                ? 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                : 'bg-surface-sunken text-ink-faint hover:bg-brand-50'
            }`}
          >
            {item.isAvailable ? 'In stock' : 'Out'}
          </button>
        </span>
      </div>

      {error ? (
        <p role="alert" className="mt-1.5 text-[11px] text-rose-700">
          {error}
        </p>
      ) : null}
    </li>
  );
}
