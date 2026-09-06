'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { acceptOfferAction, declineOfferAction } from '@/lib/actions/fleet-actions';
import { formatCentavos } from '@/lib/money';

export interface OfferCardData {
  offerId: string;
  orderNumber: string;
  serviceName: string;
  pickupLabel: string;
  pickupArea: string;
  dropoffArea: string;
  distanceMeters: number;
  earningsCentavos: number;
  secondsRemaining: number;
}

/**
 * One dispatch offer.
 *
 * The countdown is the point: an offer that lapses counts against acceptance
 * rate, so a partner should be able to see how long they have rather than
 * discovering after the fact that they were marked unresponsive.
 */
export function OfferCard({ offer }: { offer: OfferCardData }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(offer.secondsRemaining);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (remaining <= 0) {
      // Lapsed: pull the board so the dead card goes away rather than sitting
      // there inviting a tap that can only fail.
      router.refresh();
      return;
    }
    const timer = window.setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining, router]);

  const urgent = remaining <= 15;

  return (
    <li className={`rounded-xl bg-surface p-3.5 shadow-sm ring-1 ${urgent ? 'ring-2 ring-amber-400' : 'ring-black/5'}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold">
          {formatCentavos(offer.earningsCentavos)}
        </span>
        <span
          className={`text-[11px] font-bold tabular-nums ${urgent ? 'text-amber-800' : 'text-ink-faint'}`}
        >
          {remaining}s
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-ink-muted">
        {offer.serviceName} · {(offer.distanceMeters / 1000).toFixed(1)} km papunta sa pickup
      </p>

      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex gap-2">
          <dt aria-hidden className="shrink-0">🏪</dt>
          <dd className="min-w-0">
            <span className="block font-medium">{offer.pickupLabel}</span>
            <span className="block text-[11px] text-ink-faint">{offer.pickupArea}</span>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt aria-hidden className="shrink-0">📍</dt>
          <dd className="min-w-0 text-ink-muted">{offer.dropoffArea}</dd>
        </div>
      </dl>

      <p className="mt-1.5 text-[10px] text-ink-faint tabular-nums">{offer.orderNumber}</p>

      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-rose-700">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={isPending || remaining <= 0}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await acceptOfferAction(offer.offerId);
              // Success redirects to the job screen, so anything returned is a
              // failure — usually somebody else got there first.
              if (result && !result.ok) setError(result.message);
            })
          }
          className="flex-1 rounded-lg bg-brand-700 px-3 py-2.5 text-xs font-bold text-white transition-colors hover:bg-brand-800 disabled:bg-ink-faint"
        >
          {isPending ? '…' : 'Tanggapin'}
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await declineOfferAction(offer.offerId);
              if (result.ok) router.refresh();
              else setError(result.message);
            })
          }
          className="rounded-lg bg-surface-sunken px-3 py-2.5 text-xs font-semibold ring-1 ring-black/5 transition-colors hover:bg-rose-50"
        >
          Hindi
        </button>
      </div>
    </li>
  );
}
