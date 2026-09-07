'use client';

import { useActionState, useEffect, useState } from 'react';
import { submitReviewAction } from '@/lib/actions/review-actions';
import {
  MAX_COMMENT_LENGTH,
  STAR_LABELS,
  STAR_VALUES,
  starsAsWords,
} from '@/lib/ratings/policy';

/**
 * Rating a delivered order.
 *
 * Two scores, because the food and the ride are two different people's work
 * and folding them into one number tells neither of them anything. Both are
 * optional: somebody who thought the food was fine and the rider was late
 * should be able to say exactly that and nothing else.
 *
 * The stars are radio inputs. Not a row of buttons with click handlers — a
 * radio group is what this is, so a keyboard gets arrow keys, a screen reader
 * announces "3 out of 5, okay", and the value is in the form whether or not
 * any of the JavaScript ran.
 *
 * The comment says where it goes, right next to the field. People write
 * differently when they think a shop will see their name, and differently
 * again when they think it will appear on a public page — and neither of those
 * is what happens here.
 */

function Stars({
  name,
  label,
  subject,
  defaultValue,
}: {
  name: string;
  label: string;
  subject: string;
  defaultValue: number | null;
}) {
  return (
    <fieldset className="border-0 p-0">
      <legend className="text-xs font-semibold">
        {label} <span className="font-normal text-ink-muted">{subject}</span>
      </legend>
      <div className="mt-1.5 flex flex-row-reverse justify-end gap-1">
        {STAR_VALUES.map((value) => (
          <label
            key={value}
            title={starsAsWords(value)}
            className="group cursor-pointer"
          >
            <input
              type="radio"
              name={name}
              value={value}
              defaultChecked={defaultValue === value}
              className="peer sr-only"
            />
            <span className="sr-only">{starsAsWords(value)}</span>
            {/* Reversed row plus a sibling selector, so hovering or choosing
                the fourth star lights the first four — which is what a star
                rating means and what a plain row of five cannot express. */}
            <span
              aria-hidden
              className="block text-2xl leading-none text-ink-faint transition-colors peer-checked:text-amber-500 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-brand-600 group-hover:text-amber-400"
            >
              ★
            </span>
          </label>
        ))}
      </div>
      <p className="mt-1 flex gap-2 text-[10px] text-ink-faint">
        <span>{STAR_LABELS[1]}</span>
        <span className="text-ink-faint/60">→</span>
        <span>{STAR_LABELS[5]}</span>
      </p>
    </fieldset>
  );
}

export function RatingForm({
  orderId,
  store,
  partner,
  existing,
}: {
  orderId: string;
  store: { id: string; name: string } | null;
  partner: { id: string; name: string } | null;
  existing: {
    storeStars: number | null;
    partnerStars: number | null;
    comment: string | null;
  } | null;
}) {
  const [result, submit, pending] = useActionState(submitReviewAction, null);
  // A form post made before hydration runs with no request scope, so
  // `cookies()` throws and there is no way to know whose order this is. The
  // login screen and the support forms carry the same limitation.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  if (result?.ok) {
    return (
      <div className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
        <p className="text-sm font-semibold">Rated. Thank you.</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">{result.message}</p>
      </div>
    );
  }

  return (
    <form
      action={submit}
      className="space-y-3 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
    >
      <input type="hidden" name="orderId" value={orderId} />

      <div>
        <h2 className="text-sm font-semibold">
          {existing ? 'Change your rating' : 'How was it?'}
        </h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
          {store && partner
            ? 'Two separate things — the shop and the rider. Rate either, or both.'
            : 'It helps the next person choose.'}
        </p>
      </div>

      {store ? (
        <Stars
          name="storeStars"
          label="The food"
          subject={`from ${store.name}`}
          defaultValue={existing?.storeStars ?? null}
        />
      ) : null}

      {partner ? (
        <Stars
          name="partnerStars"
          label="The delivery"
          subject={`by ${partner.name}`}
          defaultValue={existing?.partnerStars ?? null}
        />
      ) : null}

      <label className="block">
        <span className="text-xs font-semibold">
          Anything else? <span className="font-normal text-ink-muted">Optional</span>
        </span>
        <textarea
          name="comment"
          rows={3}
          maxLength={MAX_COMMENT_LENGTH}
          defaultValue={existing?.comment ?? ''}
          placeholder="What was good, or what went wrong"
          className="mt-1 w-full rounded-xl border border-black/10 bg-surface px-3 py-2 text-sm"
        />
        <span className="mt-1 block text-[11px] leading-relaxed text-ink-faint">
          This goes to the shop and to us. It is not shown on their page, and
          they are not told who wrote it.
        </span>
      </label>

      <noscript>
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          Sending a rating needs JavaScript. Turn it on, or use another browser.
        </p>
      </noscript>

      <button
        type="submit"
        disabled={pending || !hydrated}
        className="w-full rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-ink-faint"
      >
        {pending ? 'Sending…' : existing ? 'Save the change' : 'Send rating'}
      </button>

      {result && !result.ok ? (
        <p role="alert" className="text-xs leading-relaxed text-rose-700">
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
