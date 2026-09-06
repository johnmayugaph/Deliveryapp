'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cancelOrderAction } from '@/lib/actions/checkout-actions';
import { formatCentavos } from '@/lib/money';

/**
 * Customer cancellation.
 *
 * Whether cancelling is possible at all is the transition map's call, checked
 * server-side; this button is only rendered when the map says the customer may.
 * The confirmation step is deliberate — cancelling is not undoable.
 */
export function CancelOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [isConfirming, setIsConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refundNotice, setRefundNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (refundNotice) {
    return (
      <p role="status" className="rounded-xl bg-emerald-50 px-3 py-3 text-xs text-emerald-800">
        {refundNotice}
      </p>
    );
  }

  if (!isConfirming) {
    return (
      <button
        type="button"
        onClick={() => setIsConfirming(true)}
        className="w-full rounded-xl bg-surface px-3 py-3 text-sm font-semibold text-rose-700 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-rose-50"
      >
        Kanselahin ang order
      </button>
    );
  }

  return (
    <div className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
      <p className="text-sm font-semibold">Sigurado ka?</p>
      <p className="mt-1 text-xs text-ink-muted">
        Hindi na ito maibabalik. Ang credits na ginamit mo ay ibabalik sa credits mo.
      </p>
      <label className="mt-2 block">
        <span className="sr-only">Bakit kinansela</span>
        <input
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={200}
          placeholder="Bakit? (optional)"
          className="w-full rounded-lg bg-surface-sunken px-2.5 py-2 text-xs ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await cancelOrderAction(orderId, reason);
              if (result.ok) {
                setIsConfirming(false);
                // The refund lands in credits; say so rather than leaving them
                // to go and check.
                setRefundNotice(
                  result.refundedCentavos > 0
                    ? `Kinansela. Ibinalik ang ${formatCentavos(result.refundedCentavos)} sa credits mo.`
                    : 'Kinansela ang order.',
                );
                router.refresh();
              } else {
                setError(result.message);
              }
            });
          }}
          className="flex-1 rounded-lg bg-rose-600 px-3 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-rose-700 disabled:bg-ink-faint"
        >
          {isPending ? 'Kinakansela…' : 'Oo, kanselahin'}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => setIsConfirming(false)}
          className="flex-1 rounded-lg bg-surface-sunken px-3 py-2.5 text-xs font-semibold transition-colors hover:bg-brand-50"
        >
          Huwag na
        </button>
      </div>
    </div>
  );
}
