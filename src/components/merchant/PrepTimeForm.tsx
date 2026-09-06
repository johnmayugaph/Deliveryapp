'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setPreparationMinutesAction } from '@/lib/actions/merchant-actions';

/**
 * The store's quoted preparation time.
 *
 * Worth being careful with: this value is snapshotted into every new order and
 * feeds the customer's ETA, so a store that quotes 10 minutes and takes 40 is
 * generating complaints rather than saving face.
 */
export function PrepTimeForm({
  storeId,
  minutes,
  canEdit,
}: {
  storeId: string;
  minutes: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(String(minutes));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (!canEdit) {
    return (
      <p className="text-sm">
        <span className="font-semibold tabular-nums">{minutes}</span> minuto
        <span className="ml-2 text-[11px] text-ink-faint">
          Manager lang ang puwedeng magbago
        </span>
      </p>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(false);
        startTransition(async () => {
          const result = await setPreparationMinutesAction(storeId, Number(value));
          if (result.ok) {
            setSaved(true);
            router.refresh();
          } else {
            setError(result.message);
          }
        });
      }}
    >
      <label htmlFor="prep" className="sr-only">
        Minuto ng paghahanda
      </label>
      <input
        id="prep"
        type="number"
        inputMode="numeric"
        min="1"
        max="180"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="w-20 rounded-lg bg-surface-sunken px-2 py-2 text-right text-sm tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      <span className="text-sm text-ink-muted">minuto</span>
      <button
        type="submit"
        disabled={isPending || value === String(minutes)}
        className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-800 disabled:bg-ink-faint"
      >
        {isPending ? '…' : 'Save'}
      </button>
      {saved && !isPending ? (
        <span role="status" className="text-[11px] font-semibold text-emerald-700">
          Saved
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-[11px] text-rose-700">
          {error}
        </span>
      ) : null}
    </form>
  );
}
