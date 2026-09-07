'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cancelSubscriptionAction } from '@/lib/actions/subscription-actions';

/**
 * Cancelling asks once.
 *
 * Benefits stop immediately rather than at the end of the term, so the
 * confirmation says so — a customer who reads "cancel" and expects to keep the
 * month they are in should not find that out afterwards.
 */
export function CancelPlanButton() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full rounded-xl bg-surface px-3 py-3 text-sm font-semibold text-rose-700 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-rose-50"
      >
        Itigil ang plan
      </button>
    );
  }

  return (
    <div className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
      <p className="text-[13px] font-semibold">Itigil ang plan?</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        Titigil agad ang mga benefits — hindi hanggang sa katapusan ng buwan.
      </p>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-rose-700">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await cancelSubscriptionAction();
              if (result.error) {
                setError(result.error);
                return;
              }
              setConfirming(false);
              router.refresh();
            })
          }
          className="flex-1 rounded-xl bg-rose-700 px-3 py-2.5 text-sm font-bold text-white transition-colors hover:bg-rose-800 disabled:bg-ink-faint"
        >
          {isPending ? '…' : 'Oo, itigil'}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => setConfirming(false)}
          className="rounded-xl bg-surface-sunken px-3 py-2.5 text-sm font-semibold"
        >
          Hindi
        </button>
      </div>
    </div>
  );
}
