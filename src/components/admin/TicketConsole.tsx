'use client';

import { useActionState, useEffect, useState } from 'react';
import { SupportTicketPriority, SupportTicketStatus } from '@prisma/client';
import type { AdminActionResult } from '@/lib/admin/access';
import {
  assignTicketToMeAction,
  replyToTicketAsSupportAction,
  setTicketStatusAction,
} from '@/lib/actions/support-console-actions';
import { TICKET_STATUS_POLICY, MAX_MESSAGE_LENGTH } from '@/lib/support/policy';

/**
 * The controls on one ticket.
 *
 * No reason field, unlike every other console control, and that is a decision
 * rather than an omission — see the note at the top of
 * `support-console-actions.ts`. The reply itself is the record: stored
 * verbatim with its author and its timestamp, which is strictly more than an
 * eight-character audit note would say. Nothing here moves money, roles, or
 * anybody's ability to sign in.
 *
 * Three separate forms rather than one with shared state, each with its own
 * `useActionState`, so the result comes back as a sentence next to the control
 * that caused it rather than one shared line that could belong to any of them.
 *
 * They wait for hydration. Every action here reads the session cookie to know
 * which administrator is acting, and a pre-hydration form post runs with no
 * request scope, so `cookies()` throws — measured, not assumed. Unlike the
 * customer side there is no fallback worth offering: this is a desktop console
 * for one operator, and a disabled button that re-enables a moment later is
 * the honest behaviour.
 */

function Outcome({ result }: { result: AdminActionResult | null }) {
  if (!result) return null;
  return (
    <p
      role="status"
      className={`text-xs leading-relaxed ${
        result.ok ? 'text-emerald-700' : 'text-rose-700'
      }`}
    >
      {result.message}
    </p>
  );
}

export function TicketConsole({
  ticketId,
  status,
  priority,
  assignedToMe,
  assignedToSomebody,
}: {
  ticketId: string;
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  assignedToMe: boolean;
  assignedToSomebody: boolean;
}) {
  const [reply, sendReply, replying] = useActionState(
    replyToTicketAsSupportAction,
    null,
  );
  const [moved, move, moving] = useActionState(setTicketStatusAction, null);
  const [assigned, assign, assigning] = useActionState(assignTicketToMeAction, null);

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  return (
    <div className="space-y-4">
      <form action={sendReply} className="space-y-2">
        <input type="hidden" name="ticketId" value={ticketId} />
        <label className="block">
          <span className="text-xs font-semibold text-ink-muted">
            Reply to the customer
          </span>
          <textarea
            name="body"
            required
            rows={5}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="They get a notification with none of this text in it — the message stays in the app."
            className="mt-1 w-full rounded-lg border border-black/10 bg-surface px-3 py-2 text-[13px]"
          />
        </label>
        <button
          type="submit"
          disabled={replying || !hydrated}
          className="rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
        >
          {replying ? 'Sending…' : 'Send reply'}
        </button>
        <Outcome result={reply} />
      </form>

      <div className="flex flex-wrap items-end gap-4 border-t border-black/5 pt-3">
        <form action={move} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="ticketId" value={ticketId} />
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              State
            </span>
            <select
              name="status"
              defaultValue={status}
              className="mt-1 rounded-lg border border-black/10 bg-surface px-2 py-1.5 text-[13px]"
            >
              {Object.values(SupportTicketStatus).map((value) => (
                <option key={value} value={value}>
                  {TICKET_STATUS_POLICY[value].queueLabel}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              Priority
            </span>
            <select
              name="priority"
              defaultValue={priority}
              className="mt-1 rounded-lg border border-black/10 bg-surface px-2 py-1.5 text-[13px]"
            >
              {Object.values(SupportTicketPriority).map((value) => (
                <option key={value} value={value}>
                  {value.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={moving || !hydrated}
            className="rounded-lg bg-surface-sunken px-3 py-2 text-[13px] font-semibold text-brand-700 disabled:opacity-60"
          >
            Apply
          </button>
        </form>

        <form action={assign}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="release" value={assignedToMe ? '1' : '0'} />
          <button
            type="submit"
            disabled={assigning || !hydrated || (assignedToSomebody && !assignedToMe)}
            title={
              assignedToSomebody && !assignedToMe
                ? 'Somebody else has this one. They can hand it back.'
                : undefined
            }
            className="rounded-lg bg-surface-sunken px-3 py-2 text-[13px] font-semibold text-brand-700 disabled:opacity-40"
          >
            {assignedToMe ? 'Hand back to the queue' : 'Take this one'}
          </button>
        </form>
      </div>

      <Outcome result={moved} />
      <Outcome result={assigned} />
    </div>
  );
}
