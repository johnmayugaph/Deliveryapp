import Link from 'next/link';
import { AdminAction } from '@prisma/client';
import { ADMIN_ACTION_LABEL, listAdminActions, requireAdmin } from '@/lib/admin/access';
import {
  Empty,
  Panel,
  Pill,
  TableScroll,
  Td,
  Th,
  humaniseEnum,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * The log.
 *
 * Append-only, enforced by a database trigger rather than by convention: an
 * audit trail the people it describes can edit answers no question worth
 * asking. There is no delete button here and there is no code path that could
 * add one — an UPDATE or DELETE on the table raises.
 *
 * Every entry carries a reason of at least eight characters, also by
 * constraint. That is the only field that answers "was this legitimate", so it
 * is the one the form cannot skip and the table will not accept without.
 */
export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const action = Object.values(AdminAction).includes(params.action as AdminAction)
    ? (params.action as AdminAction)
    : undefined;

  const events = await listAdminActions({
    ...(action ? { action } : {}),
    limit: 200,
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Audit log</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          Every privileged action, with who did it and why. Append-only at the
          database level — a mistaken entry is corrected by a later one, the
          same way a wrong ledger row is corrected by a compensating one.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-surface p-3 shadow-sm ring-1 ring-black/5">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          Action
        </span>
        <Chip href="/admin/audit" active={!action}>
          All
        </Chip>
        {/* Built from the enum, so a new kind of privileged action appears here
            the moment it exists. */}
        {Object.values(AdminAction).map((value) => (
          <Chip key={value} href={`/admin/audit?action=${value}`} active={action === value}>
            {ADMIN_ACTION_LABEL[value]}
          </Chip>
        ))}
      </div>

      <Panel
        title={`${events.length} entr${events.length === 1 ? 'y' : 'ies'}`}
        description={events.length === 200 ? 'Showing the newest 200.' : undefined}
      >
        {events.length === 0 ? (
          <Empty>
            {action
              ? 'Nothing of that kind has been done.'
              : 'Nothing has been done through the console yet.'}
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Subject</Th>
                <Th>By</Th>
                <Th>Reason</Th>
                <Th>What changed</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <Td muted>{manilaTime(event.createdAt)}</Td>
                  <Td>
                    <Pill>{ADMIN_ACTION_LABEL[event.action]}</Pill>
                  </Td>
                  <Td>
                    {/* The label is denormalised on the row, so this reads even
                        after the subject has been renamed or removed. */}
                    {event.subjectType === 'User' ? (
                      <Link
                        href={`/admin/users/${event.subjectId}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {event.subjectLabel}
                      </Link>
                    ) : (
                      <span className="font-medium">{event.subjectLabel}</span>
                    )}
                    <span className="mt-0.5 block text-[10px] text-ink-faint">
                      {humaniseEnum(event.subjectType)}
                    </span>
                  </Td>
                  <Td>{event.actor.fullName ?? event.actor.displayName ?? event.actor.phone}</Td>
                  <Td>
                    <span className="block max-w-xs break-words">{event.reason}</span>
                  </Td>
                  <Td muted>
                    {event.detail === null ? (
                      '—'
                    ) : (
                      <pre className="max-w-sm overflow-x-auto whitespace-pre-wrap break-words text-[10px] leading-snug">
                        {JSON.stringify(event.detail, null, 1)}
                      </pre>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-md px-2 py-1 text-[11px] font-semibold ${
        active ? 'bg-brand-700 text-white' : 'bg-surface-sunken text-ink-muted hover:text-ink'
      }`}
    >
      {children}
    </Link>
  );
}
