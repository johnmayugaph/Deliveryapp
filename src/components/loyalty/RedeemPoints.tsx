'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { redeemPointsAction } from '@/lib/actions/loyalty-actions';
import { formatCentavos } from '@/lib/money';

/**
 * The whole redeem area: the offer, the refusal, and the answer to a tap.
 *
 * It owns BOTH states — enough points and not enough — rather than the page
 * choosing between this component and a paragraph. That is not tidiness; it is
 * a bug fix found in a browser.
 *
 * The earlier version rendered only when a redemption was available, and the
 * page rendered a "you need 300 more points" line otherwise. Redeeming then
 * dropped the balance below one block, `router.refresh()` re-rendered the
 * page, and this component was replaced by that line — **taking its own
 * success message with it.** The points changed, the credits changed, and the
 * customer was told nothing at all, which is indistinguishable from a tap that
 * did not work.
 *
 * Owning both states means the confirmation survives the thing it is
 * confirming.
 *
 * One tap, deliberately not a slider: the programme redeems in blocks, so a
 * customer holding 1,437 points with a 500-point block has two sensible
 * choices, not 1,437. The button names the outcome in pesos, because pesos are
 * what is being decided about.
 */
export function RedeemPoints({
  offer,
  points,
  blockPoints,
}: {
  /** Null when the balance is below one block. */
  offer: { points: number; centavos: number } | null;
  points: number;
  blockPoints: number;
}) {
  const router = useRouter();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const remainingAfter = offer ? points - offer.points : points;

  return (
    <div className="mt-3 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
      {offer ? (
        <>
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                setResult(null);
                const outcome = await redeemPointsAction(offer.points);
                setResult(outcome);
                if (outcome.ok) router.refresh();
              })
            }
            className="w-full rounded-xl bg-brand-700 px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-brand-800 disabled:opacity-60"
          >
            {isPending
              ? 'Redeeming…'
              : `Turn ${offer.points.toLocaleString('en-PH')} points into ${formatCentavos(offer.centavos)}`}
          </button>

          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            {remainingAfter > 0
              ? `${remainingAfter.toLocaleString('en-PH')} points would be left over, towards your next one.`
              : 'This uses all of your points.'}{' '}
            The credits go into your Credits balance and can only be spent on
            orders.
          </p>
        </>
      ) : (
        <p className="text-xs leading-relaxed text-ink-muted">
          {blockPoints > 0 ? (
            <>
              You need{' '}
              <strong className="text-ink">
                {Math.max(0, blockPoints - points).toLocaleString('en-PH')} more
                points
              </strong>{' '}
              before you can redeem — points are turned into credits{' '}
              {blockPoints.toLocaleString('en-PH')} at a time, so nothing is left
              stranded as a few unusable points.
            </>
          ) : (
            'Points cannot be redeemed at the moment.'
          )}
        </p>
      )}

      {result ? (
        <p
          role="alert"
          className={`mt-2 text-xs leading-relaxed ${
            result.ok ? 'text-emerald-700' : 'text-rose-700'
          }`}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
