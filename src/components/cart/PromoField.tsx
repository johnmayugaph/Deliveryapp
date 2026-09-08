'use client';

import { useState } from 'react';
import { formatCentavos } from '@/lib/money';
import {
  REFUSAL_TEXT,
  codeLooksPlausible,
  normalisePromoCode,
  type PromoDisplay,
} from '@/lib/promo/policy';

/**
 * The promo code field.
 *
 * ### Why it does not re-quote as you type
 *
 * The parent re-quotes whenever anything price-bearing changes, and that is the
 * right behaviour for a tip or an address. It is the wrong behaviour for a
 * code: somebody typing TARA50 would fire five quotes and watch four of them
 * come back "That code is not available", the last of which is the truth and
 * the first four of which are noise. Worse, the message for the half-typed
 * prefix is indistinguishable from the message for a real code that has
 * expired.
 *
 * So the draft text lives here and nothing leaves this component until Apply
 * (or Enter). The applied code lives in the parent, in the quote key, which is
 * what makes the discount arrive through the same server quote as every other
 * number on the screen. This component computes no money.
 *
 * ### Why the state comes back from the parent
 *
 * The verdict — accepted, refused, or beaten by the customer's own plan — is
 * derived from the server's quote, which the parent owns. If this component
 * kept its own copy it would be a second truth about a discount, and the first
 * time the two disagreed the customer would read one number and pay another.
 * Same lesson as the points screen: the component that shows the outcome must
 * not be the component that remembers it.
 */
export function PromoField({
  appliedCode,
  display,
  isQuoting,
  onApply,
  onRemove,
}: {
  /** The code the parent is currently quoting with. Empty for none. */
  appliedCode: string;
  /** The verdict, from the server quote. Null while there is no quote yet. */
  display: PromoDisplay | null;
  isQuoting: boolean;
  onApply: (code: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState('');

  const normalised = normalisePromoCode(draft);
  const canApply = codeLooksPlausible(normalised) && !isQuoting;

  function apply() {
    if (!canApply) return;
    onApply(normalised);
    setDraft('');
  }

  function remove() {
    setDraft('');
    onRemove();
  }

  return (
    <section
      aria-labelledby="promo-heading"
      className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
    >
      <h2 id="promo-heading" className="text-[13px] font-semibold">
        Promo code
      </h2>

      {appliedCode.length === 0 ? (
        <div className="mt-2 flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Promo code</span>
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              // Enter applies. A code field that ignores Enter is a code field
              // that submits the whole form on a phone keyboard.
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  apply();
                }
              }}
              maxLength={40}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="TARA50"
              aria-describedby="promo-message"
              className="w-full rounded-lg bg-surface-sunken px-2.5 py-2 text-xs uppercase tracking-wide ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </label>
          <button
            type="button"
            onClick={apply}
            disabled={!canApply}
            className="shrink-0 rounded-lg bg-brand-600 px-3.5 py-2 text-xs font-bold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-faint"
          >
            Apply
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-lg bg-surface-sunken px-2.5 py-2 text-xs font-bold tracking-wide">
            {appliedCode}
          </span>
          <button
            type="button"
            onClick={remove}
            className="shrink-0 rounded-lg px-2.5 py-2 text-xs font-semibold text-brand-700"
          >
            Remove
          </button>
        </div>
      )}

      {/* One live region for every verdict, so a screen reader hears the
          outcome without the applied code having to move focus. */}
      <p
        id="promo-message"
        aria-live="polite"
        className="mt-1.5 text-[11px] leading-relaxed empty:mt-0"
      >
        {appliedCode.length > 0 && (isQuoting || display === null) ? (
          <span className="text-ink-faint">Checking {appliedCode}…</span>
        ) : (
          <Verdict code={appliedCode} display={display} />
        )}
      </p>
    </section>
  );
}

function Verdict({
  code,
  display,
}: {
  code: string;
  display: PromoDisplay | null;
}) {
  if (display === null) return null;

  switch (display.kind) {
    case 'none':
      return null;

    case 'accepted':
      return (
        <span className="text-emerald-700">
          {formatCentavos(display.discountCentavos)} off with {code}.
        </span>
      );

    case 'refused':
      return <span className="text-rose-700">{REFUSAL_TEXT[display.refusal]}</span>;

    // The code is real, it works, and it took nothing off — because it does
    // not stack and the customer's own plan saved them more. Saying so is the
    // whole point: the alternative is an accepted code, no discount line, and
    // a customer who thinks we lost it.
    case 'outbid':
      return (
        <span className="text-ink-muted">
          Your plan already saves you more than {code}
          {' '}({formatCentavos(display.offeredCentavos)}), so we kept your plan
          and left the code unused. You can use it another time.
        </span>
      );
  }
}
