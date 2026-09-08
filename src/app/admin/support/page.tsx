import Link from 'next/link';
import { requireAdmin } from '@/lib/admin/access';
import { supportQueue, supportSummary } from '@/lib/support/queries';
import {
  SUPPORT_RESPONSE_TARGET_MINUTES,
  TICKET_STATUS_POLICY,
  describeWait,
} from '@/lib/support/policy';
import { contactPosture, describeContactPosture } from '@/lib/support/contact';
import { displayNameFor } from '@/lib/auth/session';
import {
  Empty,
  Panel,
  PersonLink,
  Pill,
  Stat,
  TableScroll,
  Td,
  Th,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * The support queue.
 *
 * The page that answers "is anybody waiting on us", which before this existed
 * was answered by nothing at all: tickets were written to a table nobody read.
 *
 * Worst first, and "worst" is priority then length of silence — see
 * `supportQueue`. A ticket nobody has EVER answered is called out separately
 * from one mid-conversation, because those are the same "waiting" count and
 * completely different situations: one person is having a conversation, the
 * other is wondering whether this company exists.
 */
export default async function AdminSupportPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const admin = await requireAdmin();

  const [{ all }, summary] = await Promise.all([searchParams, supportSummary()]);
  const includeFinished = all === '1';
  const queue = await supportQueue({ includeFinished });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Support</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          Every conversation, across every service. Replying notifies the
          customer; the reply itself stays in the app rather than going out by
          text, so it is safe to write account details here.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Waiting on us" value={String(summary.waiting)} />
        <Stat
          label="Never answered"
          value={String(summary.neverAnswered)}
          note={summary.neverAnswered > 0 ? 'nobody has replied at all' : undefined}
        />
        <Stat
          label="Longest wait"
          value={summary.waiting === 0 ? '—' : describeWait(summary.longestWaitMinutes)}
          note={
            summary.longestWaitMinutes >= SUPPORT_RESPONSE_TARGET_MINUTES
              ? `past the ${describeWait(SUPPORT_RESPONSE_TARGET_MINUTES)} target`
              : undefined
          }
        />
        <Stat
          label="Typical first reply"
          value={
            summary.medianFirstReplyMinutes === null
              ? '—'
              : describeWait(summary.medianFirstReplyMinutes)
          }
          note={`median, ${summary.answeredThisWeek} answered this week`}
        />
      </div>

      {/* The gap that matters most, and the one nothing else on this screen
          would reveal: a queue can be empty because nobody needs help or
          because nobody who is locked out can reach you. */}
      {contactPosture() === 'none' ? (
        <Panel title="Nobody locked out of their account can reach you">
          <p className="px-4 py-3 text-xs leading-relaxed text-ink-muted">
            {describeContactPosture()}
          </p>
        </Panel>
      ) : null}

      <Panel
        title={includeFinished ? 'Every ticket' : 'Open tickets'}
        action={
          <Link
            href={includeFinished ? '/admin/support' : '/admin/support?all=1'}
            className="text-[11px] font-semibold text-brand-700"
          >
            {includeFinished ? 'Open only' : 'Include resolved and closed'}
          </Link>
        }
      >
        {queue.length === 0 ? (
          <Empty>
            {includeFinished
              ? 'No tickets have ever been raised.'
              : 'Nothing waiting. Every conversation is resolved or closed.'}
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Ticket</Th>
                <Th>Customer</Th>
                <Th>State</Th>
                <Th>Priority</Th>
                <Th>Silent for</Th>
                <Th>With</Th>
              </tr>
            </thead>
            <tbody>
              {queue.map((ticket) => {
                const policy = TICKET_STATUS_POLICY[ticket.status];
                const overdue =
                  policy.waitingOnUs &&
                  ticket.firstRespondedAt === null &&
                  ticket.waitedMinutes >= SUPPORT_RESPONSE_TARGET_MINUTES;

                return (
                  <tr key={ticket.id} className="border-t border-black/5">
                    <Td>
                      <Link
                        href={`/admin/support/${ticket.id}`}
                        className="font-semibold text-brand-700"
                      >
                        {ticket.subject}
                      </Link>
                      <span className="block text-[11px] text-ink-faint">
                        {ticket.ticketNumber}
                        {ticket.serviceType ? ` · ${ticket.serviceType}` : ''}
                        {ticket._count.messages > 0
                          ? ` · ${ticket._count.messages} repl${
                              ticket._count.messages === 1 ? 'y' : 'ies'
                            }`
                          : ''}
                      </span>
                    </Td>
                    <Td>
                      <PersonLink user={ticket.user} />
                    </Td>
                    <Td>
                      <Pill tone={policy.waitingOnUs ? 'warn' : 'neutral'}>
                        {policy.queueLabel}
                      </Pill>
                    </Td>
                    <Td>{ticket.priority.toLowerCase()}</Td>
                    <Td>
                      <span className={overdue ? 'font-semibold text-rose-700' : ''}>
                        {describeWait(ticket.waitedMinutes)}
                      </span>
                      {ticket.firstRespondedAt === null ? (
                        <span className="block text-[11px] text-ink-faint">
                          never answered
                        </span>
                      ) : null}
                      {/* Said out loud, because the queue is sorted by it. An
                          agent looking at a list ordered by something they
                          cannot see is an agent who assumes it is broken. */}
                      {ticket.tierBoostMinutes > 0 ? (
                        <span className="block text-[11px] text-ink-faint">
                          {ticket.tierName} · sorted as +
                          {ticket.tierBoostMinutes} min
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {ticket.assignedAgent
                        ? ticket.assignedAgent.id === admin.id
                          ? 'You'
                          : displayNameFor(ticket.assignedAgent)
                        : '—'}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}
