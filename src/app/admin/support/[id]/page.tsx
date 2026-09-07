import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/admin/access';
import { getTicketForAgent } from '@/lib/support/queries';
import {
  SUPPORT_RESPONSE_TARGET_MINUTES,
  TICKET_STATUS_POLICY,
  describeWait,
  waitingMinutes,
} from '@/lib/support/policy';
import { displayNameFor } from '@/lib/auth/session';
import { humaniseEnum, manilaTime, Panel, Pill } from '@/components/admin/primitives';
import { TicketConsole } from '@/components/admin/TicketConsole';

export const dynamic = 'force-dynamic';

/**
 * One conversation, from the operator's side.
 *
 * Everything needed to answer without asking the customer to repeat
 * themselves: the thread, who they are, and the order it is about if there is
 * one. The order number links straight to the console's own order page, which
 * is the difference between answering a question and starting an
 * investigation.
 */
export default async function AdminTicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = await requireAdmin();

  const ticket = await getTicketForAgent(id);
  if (!ticket) notFound();

  const policy = TICKET_STATUS_POLICY[ticket.status];
  const now = new Date();
  const silentFor = waitingMinutes({ since: ticket.lastMessageAt, now });
  const overdue =
    policy.waitingOnUs &&
    ticket.firstRespondedAt === null &&
    silentFor >= SUPPORT_RESPONSE_TARGET_MINUTES;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/support" className="text-[11px] font-semibold text-brand-700">
          ← Support queue
        </Link>
        <h1 className="mt-1 text-lg font-bold">{ticket.subject}</h1>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span>{ticket.ticketNumber}</span>
          <Pill tone={policy.waitingOnUs ? 'warn' : 'neutral'}>{policy.queueLabel}</Pill>
          <span>{ticket.priority.toLowerCase()} priority</span>
          <span className={overdue ? 'font-semibold text-rose-700' : ''}>
            silent for {describeWait(silentFor)}
          </span>
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          <Panel title="The conversation">
            <div className="space-y-3 px-4 py-4">
              <article className="rounded-lg bg-surface-sunken p-3">
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">
                  {ticket.body}
                </p>
                <p className="mt-2 text-[11px] text-ink-faint">
                  {displayNameFor(ticket.user)} · {manilaTime(ticket.createdAt)}
                </p>
              </article>

              {ticket.messages.map((message) => (
                <article
                  key={message.id}
                  className={
                    message.isFromSupport
                      ? 'rounded-lg bg-brand-50 p-3'
                      : 'rounded-lg bg-surface-sunken p-3'
                  }
                >
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed">
                    {message.body}
                  </p>
                  <p className="mt-2 text-[11px] text-ink-faint">
                    {message.isFromSupport
                      ? message.author
                        ? `${displayNameFor(message.author)} (support)`
                        : 'Support'
                      : displayNameFor(ticket.user)}{' '}
                    · {manilaTime(message.createdAt)}
                  </p>
                </article>
              ))}
            </div>
          </Panel>

          <Panel title="Answer">
            <div className="px-4 py-4">
              {/* Keyed on the message count so a sent reply leaves an empty
                  box: revalidating re-renders the server tree but leaves an
                  uncontrolled textarea's DOM value alone. */}
              <TicketConsole
                key={ticket.messages.length}
                ticketId={ticket.id}
                status={ticket.status}
                priority={ticket.priority}
                assignedToMe={ticket.assignedAgentId === admin.id}
                assignedToSomebody={ticket.assignedAgentId !== null}
              />
            </div>
          </Panel>
        </div>

        <div className="space-y-5">
          <Panel title="Who is asking">
            <dl className="space-y-2 px-4 py-4 text-[13px]">
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-ink-muted">
                  Customer
                </dt>
                <dd>
                  <Link
                    href={`/admin/users/${ticket.user.id}`}
                    className="font-semibold text-brand-700"
                  >
                    {displayNameFor(ticket.user)}
                  </Link>
                  {ticket.user.isBlocked ? (
                    <span className="ml-2">
                      <Pill tone="bad">Blocked</Pill>
                    </span>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-ink-muted">
                  Phone
                </dt>
                <dd className="tabular-nums">{ticket.user.phone}</dd>
              </div>
              {ticket.relatedOrder ? (
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-ink-muted">
                    About this order
                  </dt>
                  <dd>
                    <Link
                      href={`/admin/orders?q=${ticket.relatedOrder.orderNumber}`}
                      className="font-semibold text-brand-700"
                    >
                      {ticket.relatedOrder.orderNumber}
                    </Link>
                    <span className="block text-[11px] text-ink-faint">
                      {humaniseEnum(ticket.relatedOrder.status)}
                    </span>
                  </dd>
                </div>
              ) : null}
              {ticket.categorySlug ? (
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-ink-muted">
                    Came in through
                  </dt>
                  <dd>{ticket.categorySlug}</dd>
                </div>
              ) : null}
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-ink-muted">
                  First answered
                </dt>
                <dd>
                  {ticket.firstRespondedAt
                    ? `${manilaTime(ticket.firstRespondedAt)} — after ${describeWait(
                        waitingMinutes({
                          since: ticket.createdAt,
                          now: ticket.firstRespondedAt,
                        }),
                      )}`
                    : 'Never'}
                </dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}
