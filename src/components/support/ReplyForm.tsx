'use client';

import { useActionState, useEffect, useState } from 'react';
import { replyToTicketAction } from '@/lib/actions/support-actions';
import { MAX_MESSAGE_LENGTH } from '@/lib/support/policy';

/**
 * Adding to a thread, from the customer's side.
 *
 * Needs JavaScript, for the same measured reason as the new-ticket form: a
 * pre-hydration post runs with no request scope and `cookies()` throws, so
 * there is no way to tell whose thread this is. The submit waits for
 * hydration and says so rather than failing.
 *
 * On failure the field keeps what was typed, because a network error that also
 * loses somebody's message is the worst version of this form.
 *
 * Clearing it on SUCCESS is the parent's job, by keying this component on how
 * many messages the thread has: revalidating the page re-renders the server
 * tree but leaves an uncontrolled textarea's DOM value alone, so without the
 * key a sent reply sits in the box looking unsent.
 */
export function ReplyForm({ ticketId }: { ticketId: string }) {
  const [result, submit, busy] = useActionState(replyToTicketAction, null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <form action={submit} className="space-y-2">
      <input type="hidden" name="ticketId" value={ticketId} />
      <label className="block">
        <span className="sr-only">Your reply</span>
        <textarea
          name="body"
          required
          rows={4}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder="Add to this conversation"
          className="w-full rounded-xl border border-black/10 bg-surface px-3 py-2 text-sm"
        />
      </label>
      <noscript>
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          Replying needs JavaScript. The phone number and email on the help
          screen work without it.
        </p>
      </noscript>

      <button
        type="submit"
        disabled={busy || !hydrated}
        className="w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-ink-faint"
      >
        {busy ? 'Sending…' : 'Send'}
      </button>
      {result && !result.ok ? (
        <p role="alert" className="text-xs leading-relaxed text-rose-700">
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
