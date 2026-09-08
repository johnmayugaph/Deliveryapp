'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { redeemGiftCardAction } from '@/lib/actions/gift-card-actions';
import {
  GIFT_CODE_LENGTH,
  giftCodeLooksPlausible,
  normaliseGiftCode,
} from '@/lib/gift-cards/policy';

/**
 * The gift card field, on the screen where a balance lives.
 *
 * It owns the field AND the outcome, for the reason `RedeemPoints` documents
 * at length: redeeming changes the balance, the balance change refreshes the
 * page, and a confirmation rendered by the PAGE would be replaced by that
 * refresh — leaving somebody who just added ₱250 with a screen that says
 * nothing, which is indistinguishable from a tap that failed. The success
 * message has to live in the component that survives.
 *
 * It computes no money and validates nothing that matters. The plausibility
 * check below only decides whether the button is worth enabling; the server
 * re-normalises, re-checks and is the only thing that can actually redeem.
 */
export function RedeemGiftCard() {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const normalised = normaliseGiftCode(draft);
  const canSubmit = giftCodeLooksPlausible(normalised) && !isPending;

  function submit() {
    if (!canSubmit) return;
    startTransition(async () => {
      setResult(null);
      const outcome = await redeemGiftCardAction(draft);
      setResult(outcome);
      if (outcome.ok) {
        // Clear the field only on success. A refused code stays put so the
        // person can see what they typed and fix one letter, rather than
        // starting again from a printed card.
        setDraft('');
        router.refresh();
      }
    });
  }

  return (
    <section
      aria-labelledby="gift-card-heading"
      className="mx-4 mt-4 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
    >
      <h2 id="gift-card-heading" className="text-[13px] font-semibold">
        Add a gift card
      </h2>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
        Type the code from your card. It becomes credits you can spend on any
        order.
      </p>

      <div className="mt-2 flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Gift card code</span>
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            // Long enough for the grouped form plus the separators somebody
            // types instead of ours, and short enough that a pasted paragraph
            // cannot be submitted.
            maxLength={GIFT_CODE_LENGTH * 2}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            aria-describedby="gift-card-message"
            className="w-full rounded-lg bg-surface-sunken px-2.5 py-2 text-xs uppercase tracking-wider tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="shrink-0 rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-bold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-faint"
        >
          {isPending ? 'Adding…' : 'Add'}
        </button>
      </div>

      {/* One live region for both outcomes, so a screen reader hears the
          result without the field having to move focus. */}
      <p
        id="gift-card-message"
        aria-live="polite"
        className="mt-1.5 text-[11px] leading-relaxed empty:mt-0"
      >
        {result ? (
          <span className={result.ok ? 'text-emerald-700' : 'text-rose-700'}>
            {result.message}
          </span>
        ) : null}
      </p>
    </section>
  );
}
