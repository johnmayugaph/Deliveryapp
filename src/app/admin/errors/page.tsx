import { requireAdmin } from '@/lib/admin/access';
import {
  ERROR_SOURCE_LABEL,
  errorSummary,
  listErrorReports,
} from '@/lib/monitoring/queries';
import { resolveErrorReportAction } from '@/lib/actions/admin-actions';
import { ReasonForm } from '@/components/admin/ReasonForm';
import { Empty, Panel, Pill, Stat, manilaTime } from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * What is broken.
 *
 * The page that answers "is anything failing right now", which before this
 * existed was answered by waiting for a customer to say so — and most
 * customers do not say so, they leave.
 *
 * Ordered by MOST RECENT occurrence rather than by count, deliberately. A
 * fault that happened four hundred times last Tuesday and stopped is history;
 * one that happened twice in the last minute is happening. Sorting by volume
 * buries the second under the first, which is how a monitoring page becomes a
 * page nobody opens.
 *
 * Everything here is grouped and redacted before it arrives: one row per
 * distinct fault with a count, and phone numbers, codes, tokens and connection
 * strings taken out on the way in. See `src/lib/monitoring/redact.ts` — an
 * error log that captured the login code it failed to send would be the
 * softest target in the database.
 */
export default async function AdminErrorsPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  await requireAdmin();

  const [{ all }, summary] = await Promise.all([searchParams, errorSummary()]);
  const includeResolved = all === '1';
  const reports = await listErrorReports({ includeResolved });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Errors</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          One row per distinct fault, however many times it happened, newest
          occurrence first. Messages and stacks have phone numbers, codes and
          tokens stripped out before they are written down — so a trace here is
          slightly less specific than the original, on purpose.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Open faults" value={String(summary.open)} />
        <Stat
          label="New in 24h"
          value={String(summary.newToday)}
          note="distinct, not occurrences"
        />
        <Stat
          label="Occurrences"
          value={String(summary.occurrences)}
          note="across every open fault"
        />
        <Stat
          label="Last seen"
          value={summary.lastSeenAt ? manilaTime(summary.lastSeenAt) : '—'}
          note={summary.lastSeenAt ? undefined : 'nothing has failed yet'}
        />
      </div>

      <Panel
        title={includeResolved ? 'Every fault' : 'Open faults'}
        description={
          includeResolved
            ? 'Including the ones somebody has marked fixed.'
            : 'Marked-fixed faults are hidden. A fault that happens again reopens itself.'
        }
        action={
          <a
            href={includeResolved ? '/admin/errors' : '/admin/errors?all=1'}
            className="text-[11px] font-semibold text-brand-700 hover:underline"
          >
            {includeResolved ? 'Open only' : 'Show resolved too'}
          </a>
        }
      >
        {reports.length === 0 ? (
          <Empty>
            {includeResolved
              ? 'Nothing has ever been recorded here.'
              : 'Nothing is failing. This is the state you want.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {reports.map((report) => (
              <li key={report.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-mono text-[13px] font-semibold">
                    {report.kind}
                  </span>
                  <Pill tone={report.resolvedAt ? 'good' : 'bad'}>
                    {report.resolvedAt ? 'Fixed' : `${report.occurrences}×`}
                  </Pill>
                  <Pill>{ERROR_SOURCE_LABEL[report.source]}</Pill>
                  {report.route ? (
                    <span className="font-mono text-[11px] text-ink-muted">
                      {report.route}
                    </span>
                  ) : null}
                  {report.alertedAt === null && !report.resolvedAt ? (
                    <Pill tone="warn">Not yet alerted</Pill>
                  ) : null}
                </div>

                <p className="mt-1 break-words text-xs text-ink">{report.message}</p>

                <p className="mt-1 text-[11px] text-ink-faint">
                  First {manilaTime(report.firstSeenAt)} · last{' '}
                  {manilaTime(report.lastSeenAt)}
                  {report.digest ? (
                    <>
                      {' '}
                      · digest{' '}
                      <span className="select-all font-mono">{report.digest}</span>
                    </>
                  ) : null}
                  {report.user ? (
                    <> · while {report.user.fullName ?? report.user.phone} was signed in</>
                  ) : null}
                  {report.resolvedBy ? (
                    <>
                      {' '}
                      · marked fixed by{' '}
                      {report.resolvedBy.fullName ?? report.resolvedBy.phone}
                    </>
                  ) : null}
                </p>

                {report.stack ? (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-[11px] font-semibold text-ink-muted">
                      Stack
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-sunken px-2.5 py-2 text-[10px] leading-relaxed">
                      {report.stack}
                    </pre>
                  </details>
                ) : null}

                <div className="mt-2">
                  {report.resolvedAt ? (
                    <details>
                      <summary className="cursor-pointer text-[11px] font-semibold text-ink-muted">
                        Reopen
                      </summary>
                      <div className="mt-1.5">
                        <ReasonForm
                          action={resolveErrorReportAction}
                          hidden={{ errorId: report.id, resolved: 'false' }}
                          submitLabel="Reopen"
                          tone="danger"
                          placeholder="Why it is not fixed"
                        />
                      </div>
                    </details>
                  ) : (
                    <ReasonForm
                      action={resolveErrorReportAction}
                      hidden={{ errorId: report.id, resolved: 'true' }}
                      submitLabel="Mark fixed"
                      placeholder="What was changed, or why it is not a fault"
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
