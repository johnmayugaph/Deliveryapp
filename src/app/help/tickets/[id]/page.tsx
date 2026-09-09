import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireScreen } from '@/lib/auth/access';
import { getTicketForUser } from '@/lib/support/tickets';
import { contactDetails } from '@/lib/support/contact';
import { TICKET_STATUS_POLICY, customerMayReply } from '@/lib/support/policy';
import { ContactPanel } from '@/components/support/ContactPanel';
import { ReplyForm } from '@/components/support/ReplyForm';
import { formatDateTimeIn } from '@/lib/time/manila';

export const dynamic = 'force-dynamic';

function manilaMoment(at: Date): string {
  return formatDateTimeIn(at);
}

/**
 * One conversation.
 *
 * `getTicketForUser` filters on the signed-in id inside the query, so a ticket
 * belonging to somebody else is indistinguishable from one that does not exist
 * — a 404, not a 403. There is nothing to learn from the difference and one of
 * the two answers confirms that a given id is real.
 *
 * The opening message is the ticket's own `subject`/`body` rather than a
 * `SupportTicketMessage` row. That is what the schema says, and duplicating it
 * into the thread would make the first message editable in one place and not
 * the other.
 */
export default async function TicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireScreen('ticketDetail', id);

  const ticket = await getTicketForUser(id, user.id);
  if (!ticket) notFound();

  const policy = TICKET_STATUS_POLICY[ticket.status];

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <Link href="/help/tickets" className="text-xs font-semibold text-brand-700">
          ← Your conversations
        </Link>
        <h1 className="mt-1 text-lg font-bold">{ticket.subject}</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          {ticket.ticketNumber} · {policy.label}
        </p>
      </header>

      <div className="space-y-3 px-4 py-4">
        {/* The opening message. */}
        <article className="rounded-xl rounded-tr-sm bg-brand-50 p-3.5">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{ticket.body}</p>
          <p className="mt-2 text-[11px] text-ink-faint">
            You · {manilaMoment(ticket.createdAt)}
          </p>
        </article>

        {ticket.messages.map((message) => (
          <article
            key={message.id}
            className={
              message.isFromSupport
                ? 'rounded-xl rounded-tl-sm bg-surface p-3.5 shadow-sm ring-1 ring-black/5'
                : 'rounded-xl rounded-tr-sm bg-brand-50 p-3.5'
            }
          >
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.body}</p>
            <p className="mt-2 text-[11px] text-ink-faint">
              {message.isFromSupport ? 'TARA support' : 'You'} ·{' '}
              {manilaMoment(message.createdAt)}
            </p>
          </article>
        ))}

        {customerMayReply(ticket.status) ? (
          <div className="pt-1">
            {/* Keyed on the message count, so a sent reply leaves an empty box
                rather than sitting there looking unsent — see ReplyForm. */}
            <ReplyForm key={ticket.messages.length} ticketId={ticket.id} />
          </div>
        ) : (
          <div className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
            <p className="text-xs leading-relaxed text-ink-muted">
              This conversation is closed.{' '}
              <Link
                href="/help/contact"
                className="font-semibold text-brand-700 underline"
              >
                Send a new message
              </Link>{' '}
              if there is anything else.
            </p>
          </div>
        )}

        {/* Somebody reading a thread that has gone quiet needs the number, not
            another reply into the same silence. */}
        {policy.waitingOnUs ? <ContactPanel contact={contactDetails()} /> : null}
      </div>
    </main>
  );
}
