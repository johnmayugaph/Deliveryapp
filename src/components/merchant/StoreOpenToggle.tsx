'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setStoreOpenAction } from '@/lib/actions/merchant-actions';

/**
 * Open/closed switch.
 *
 * In the header of every merchant screen rather than buried in settings,
 * because closing is the most urgent thing a kitchen ever needs to do — the
 * rice runs out and orders have to stop arriving now, not after two taps.
 */
export function StoreOpenToggle({ storeId, isOpen }: { storeId: string; isOpen: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="shrink-0 text-right">
      <button
        type="button"
        disabled={isPending}
        aria-pressed={isOpen}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await setStoreOpenAction(storeId, !isOpen);
            if (result.ok) router.refresh();
            else setError(result.message);
          })
        }
        className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-60 ${
          isOpen
            ? 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
            : 'bg-rose-50 text-rose-800 hover:bg-rose-100'
        }`}
      >
        {isPending ? '…' : isOpen ? 'Bukas' : 'Sarado'}
      </button>
      <p className="mt-1 text-[10px] text-ink-faint">
        {isOpen ? 'Tap para isara' : 'Tap para buksan'}
      </p>
      {error ? (
        <p role="alert" className="mt-1 max-w-[8rem] text-[10px] text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
