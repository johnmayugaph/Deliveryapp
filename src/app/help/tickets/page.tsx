import Link from 'next/link';
import { requireScreen } from '@/lib/auth/access';
import { listUserTickets } from '@/lib/support/tickets';
import { TICKET_STATUS_POLICY, describeWait, waitingMinutes } from '@/lib/support/policy';

export const dynamic = 'force-dynamic';

/**
 * Every conversation somebody has had with support, across every vertical —
 * the same shape as the orders list and for the same reason: one `SupportTicket`
 * table, one query, no per-service branches.
 */
export default async function TicketsPage() {
  const user = await requireScreen('tickets');

  const tickets = await listUserTickets(user.id);
  const now = new Date();

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <Link href="/help" className="text-xs font-semibold text-brand-700">
          ← Help
        </Link>
        <h1 className="mt-1 text-xl font-bold">Your conversations</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          Everything you have sent us, and what we said back.
        </p>
      </header>

      {tickets.length === 0 ? (
        <div className="px-4 py-8">
          <p className="text-sm text-ink-muted">
            Nothing yet.{' '}
            <Link href="/help/contact" className="font-semibold text-brand-700 underline">
              Send us a message
            </Link>{' '}
            if something has gone wrong.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-black/5">
          {tickets.map((ticket) => {
            const policy = TICKET_STATUS_POLICY[ticket.status];
            return (
              <li key={ticket.id}>
                <Link
                  href={`/help/tickets/${ticket.id}`}
                  className="block bg-surface px-4 py-3.5"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-semibold">{ticket.subject}</p>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        policy.waitingOnUs
                          ? 'bg-brand-50 text-brand-700'
                          : 'bg-surface-sunken text-ink-faint'
                      }`}
                    >
                      {policy.label}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-muted">
                    {ticket.body}
                  </p>
                  <p className="mt-1.5 text-[11px] text-ink-faint">
                    {ticket.ticketNumber} ·{' '}
                    {describeWait(waitingMinutes({ since: ticket.lastMessageAt, now }))}
                    {waitingMinutes({ since: ticket.lastMessageAt, now }) >= 1
                      ? ' ago'
                      : ''}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
