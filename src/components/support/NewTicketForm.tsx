'use client';

import { useActionState, useEffect, useState } from 'react';
import { openTicketAction } from '@/lib/actions/support-actions';
import { MAX_MESSAGE_LENGTH, MAX_SUBJECT_LENGTH } from '@/lib/support/policy';

/**
 * The form that reaches a human.
 *
 * Two choices worth naming.
 *
 * **The message is the only required field.** A subject is derived from the
 * first line when it is left blank, and a category is a hint rather than a
 * gate. Every extra required field on a support form is a person who gives up
 * and tells their friends the app is broken instead.
 *
 * **The order is picked from a list, not typed.** It attaches the ticket to a
 * real record — which sets the vertical and the priority — and it means the
 * agent opening the ticket already has the order in front of them rather than
 * asking for a number the customer has to go and find.
 *
 * **This form needs JavaScript, and it says so.** Verified rather than
 * assumed: a pre-hydration submission arrives as a plain form post, which Next
 * 15.1 runs with no request scope, so `cookies()` throws — and every action
 * here needs the session cookie to know whose ticket it is. `LoginFlow` hit
 * exactly this and made the same call for its second step.
 *
 * A dead submit button on the one screen somebody reaches when everything else
 * has failed would be the worst possible version of this. So the button is
 * disabled until hydration, a `<noscript>` says why, and both point at the
 * phone number and email on the same screen — plain HTML, no session needed,
 * which is the whole reason the contact panel is there.
 */

export interface OrderChoice {
  id: string;
  label: string;
  live: boolean;
}

export interface CategoryChoice {
  slug: string;
  title: string;
}

const FIELD =
  'mt-1 w-full rounded-xl border border-black/10 bg-surface px-3 py-2 text-sm';

export function NewTicketForm({
  orders,
  categories,
  /** Preselected when the customer arrived from an order's tracking screen. */
  initialOrderId,
}: {
  orders: OrderChoice[];
  categories: CategoryChoice[];
  initialOrderId?: string;
}) {
  // Only ever holds a FAILURE: a successful submission redirects to the new
  // thread and this component is gone.
  const [result, submit, busy] = useActionState(openTicketAction, null);

  // False until the client has hydrated, because a form post made before then
  // cannot read the session cookie. Gates the submit rather than letting it
  // fail with a 500 nobody can act on.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <form action={submit} className="space-y-3">
      {orders.length > 0 ? (
        <label className="block">
          <span className="text-xs font-semibold text-ink-muted">
            Is this about an order?
          </span>
          <select name="relatedOrderId" defaultValue={initialOrderId ?? ''} className={FIELD}>
            <option value="">No — something else</option>
            {orders.map((order) => (
              <option key={order.id} value={order.id}>
                {order.label}
                {order.live ? ' — happening now' : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {categories.length > 0 ? (
        <label className="block">
          <span className="text-xs font-semibold text-ink-muted">What is it about?</span>
          <select name="categorySlug" defaultValue="" className={FIELD}>
            <option value="">Not sure</option>
            {categories.map((category) => (
              <option key={category.slug} value={category.slug}>
                {category.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="block">
        <span className="text-xs font-semibold text-ink-muted">
          Subject <span className="font-normal text-ink-faint">(optional)</span>
        </span>
        <input
          type="text"
          name="subject"
          maxLength={MAX_SUBJECT_LENGTH}
          className={FIELD}
          placeholder="Rider never arrived"
        />
      </label>

      <label className="block">
        <span className="text-xs font-semibold text-ink-muted">What happened?</span>
        <textarea
          name="body"
          required
          rows={6}
          maxLength={MAX_MESSAGE_LENGTH}
          className={FIELD}
          placeholder="Tell us what went wrong, and what you would like us to do about it."
        />
      </label>

      <noscript>
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          Sending a message needs JavaScript. Turn it on, or use the phone
          number or email below — those work either way.
        </p>
      </noscript>

      <button
        type="submit"
        disabled={busy || !hydrated}
        className="w-full rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-ink-faint"
      >
        {busy ? 'Sending…' : 'Send to support'}
      </button>

      {result ? (
        <p role="alert" className="text-xs leading-relaxed text-rose-700">
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
