import { requireAdmin } from '@/lib/admin/access';
import { subscriptionOverview, type InvoiceRow } from '@/lib/admin/subscriptions';
import { subscriptionRailStatus } from '@/lib/subscriptions/rails';
import {
  INVOICE_STATE_CONSOLE_TEXT,
  RECOVERY_DAYS,
} from '@/lib/subscriptions/billing-policy';
import { formatCentavos } from '@/lib/money';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  confirmSubscriptionInvoiceAction,
  refuseSubscriptionInvoiceAction,
  voidSubscriptionInvoiceAction,
} from '@/lib/actions/admin-actions';
import {
  Empty,
  Panel,
  Pill,
  Stat,
  manilaTime,
} from '@/components/admin/primitives';
import { formatDayIn } from '@/lib/time/manila';

export const dynamic = 'force-dynamic';

/**
 * Subscriptions.
 *
 * ### Two numbers, and the gap between them
 *
 * The screen leads with what is billed and what actually arrived, side by
 * side. Every subscription dashboard ever built shows the first one; on a rail
 * where the customer has to remember to pay and a person has to confirm it,
 * the first one is a ceiling and the second is the business. Showing MRR alone
 * here would report a healthy subscription product while nobody paid — and it
 * would keep doing so for months, because a lapse looks exactly like a
 * customer who has not got round to it yet.
 *
 * ### And a third number that decides when to replace this rail
 *
 * `Confirmations this month` is how many times somebody has to look at a
 * statement and click. It scales with subscribers and nothing else. Twenty is
 * a coffee; four hundred is a job, and at four hundred a provider's
 * per-transaction fee is cheaper than the person doing this. That is not an
 * argument against the rail — it needs a phone number rather than a DTI
 * registration, which is why Plus can be sold at all — but the number is the
 * signal, and a signal nobody can see is not a signal.
 */
export default async function AdminSubscriptionsPage() {
  await requireAdmin();

  const overview = await subscriptionOverview();
  const rail = subscriptionRailStatus();

  // Not a percentage of MRR: a month's collections include first payments from
  // people who were not subscribers when the month started, so it can exceed
  // MRR and a "97% collected" figure would be nonsense either way. Both
  // numbers are shown and the reader can do the division they mean.
  const shortfallCentavos = overview.mrrCentavos - overview.collectedThisMonthCentavos;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Subscriptions</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          A subscriber sends a transfer each month and quotes the bill&apos;s
          reference. Check it against the receiving account, then confirm —
          their benefits do not switch on until you do, and a bill left
          unconfirmed lapses the plan on its due date. Every decision is
          recorded with who made it and why.
        </p>
      </div>

      {rail.configured ? null : (
        <Panel title="No subscription rail is configured">
          <p className="text-xs leading-relaxed text-ink-muted">
            Nobody can buy a plan right now, so nothing will appear in these
            queues — grants still work, and need no rail. Set all three of{' '}
            <code className="rounded bg-surface-sunken px-1">
              PAYMENT_TRANSFER_LABEL
            </code>
            ,{' '}
            <code className="rounded bg-surface-sunken px-1">
              PAYMENT_TRANSFER_ACCOUNT_NAME
            </code>{' '}
            and{' '}
            <code className="rounded bg-surface-sunken px-1">
              PAYMENT_TRANSFER_ACCOUNT_NUMBER
            </code>{' '}
            — the same account checkout transfers use — to switch it on.
            Missing: <strong>{rail.missing.join(', ')}</strong>.
          </p>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Billed each month"
          value={formatCentavos(overview.mrrCentavos)}
          note={`${overview.activeCount} paid and active${
            overview.compedCount > 0 ? `, ${overview.compedCount} comped` : ''
          }`}
        />
        <Stat
          label="Collected this month"
          value={formatCentavos(overview.collectedThisMonthCentavos)}
          note={`${overview.collectedThisMonthCount} transfer${
            overview.collectedThisMonthCount === 1 ? '' : 's'
          } confirmed`}
        />
        <Stat
          label="Waiting on us"
          value={String(overview.awaitingReviewCount)}
          note={
            overview.awaitingReviewCount === 0
              ? 'Nobody has sent a reference'
              : 'Somebody has paid and is waiting'
          }
        />
        <Stat
          label="Confirmations this month"
          value={`${overview.confirmationsDone}/${overview.confirmationsThisMonth}`}
          note={
            overview.confirmationsLeft === 0
              ? 'Nothing left to check'
              : `${overview.confirmationsLeft} still to check by hand`
          }
        />
      </div>

      {overview.mrrCentavos > 0 && shortfallCentavos > 0 ? (
        <p className="rounded-xl bg-surface-sunken px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <span className="font-semibold text-ink">
            {formatCentavos(overview.mrrCentavos)} is billed and{' '}
            {formatCentavos(overview.collectedThisMonthCentavos)} has arrived
            this month.
          </span>{' '}
          The gap is not necessarily a loss — bills raised late in the month
          are due next month, and a first payment can land in a month the
          subscriber did not start in. What it is, is the number to watch: on
          this rail a subscriber has to remember to pay, so a persistent gap is
          the collection rate rather than a timing artefact.
        </p>
      ) : null}

      {overview.overdueCount > 0 ? (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
          <span className="font-semibold">
            {overview.overdueCount} bill
            {overview.overdueCount === 1 ? ' is' : 's are'} past their due date.
          </span>{' '}
          Those subscribers have already lost their benefits — that happens at
          the deadline, not when anybody notices. Paying within{' '}
          {RECOVERY_DAYS} days still restores the plan, so a transfer that has
          arrived and not been confirmed is worth finding today.
        </p>
      ) : null}

      <Panel
        title={`Bills to confirm (${overview.outstanding.length})`}
        description="Claimed transfers first, then by deadline. Unpaid and uncancelled only."
      >
        {overview.outstanding.length === 0 ? (
          <Empty>
            Nothing outstanding. A bill appears here a week before each period
            ends, and moves to the top when the subscriber says they have sent
            it.
          </Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {overview.outstanding.map((row) => (
              <li key={row.id} className="py-3 first:pt-0 last:pb-0">
                <InvoiceHeader row={row} />

                {/* The reference, big and monospaced, because the job is
                    comparing one string on this screen to one on another. */}
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg bg-surface-sunken px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                      We asked them to quote
                    </p>
                    <p className="font-mono text-sm font-bold tracking-wide">
                      {row.reference}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface-sunken px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                      Reference they sent
                    </p>
                    <p className="font-mono text-sm font-bold tracking-wide">
                      {row.submittedReference ?? '—'}
                    </p>
                    {row.submittedAt ? (
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        said {manilaTime(row.submittedAt)}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        they have not said they paid yet
                      </p>
                    )}
                  </div>
                </div>

                {row.attemptCount > 0 && row.lastFailureReason ? (
                  <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
                    Refused {row.attemptCount} time
                    {row.attemptCount === 1 ? '' : 's'}
                    {row.lastAttemptAt ? `, last ${manilaTime(row.lastAttemptAt)}` : ''}:{' '}
                    {row.lastFailureReason}
                  </p>
                ) : null}

                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  <ReasonForm
                    action={confirmSubscriptionInvoiceAction}
                    hidden={{ invoiceId: row.id }}
                    submitLabel="Confirm it arrived"
                    placeholder="Where you checked, e.g. app at 2:31pm"
                    extraFields={
                      <label className="block">
                        <span className="text-[11px] font-semibold text-ink-muted">
                          Reference you matched{' '}
                          <span className="font-normal text-ink-faint">
                            {row.submittedReference
                              ? '(blank keeps theirs)'
                              : '(required — they sent none)'}
                          </span>
                        </span>
                        <input
                          name="reference"
                          autoComplete="off"
                          placeholder={row.submittedReference ?? 'from the statement'}
                          className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </label>
                    }
                  >
                    <p className="text-[11px] leading-relaxed text-ink-muted">
                      {row.isFirstBill
                        ? 'This starts their plan and switches the benefits on.'
                        : 'This extends their plan by a month from its current end date.'}{' '}
                      The amount is fixed — a short transfer is not a partial
                      month, so refuse it and ask for the rest.
                    </p>
                  </ReasonForm>

                  <ReasonForm
                    action={refuseSubscriptionInvoiceAction}
                    hidden={{ invoiceId: row.id }}
                    submitLabel="Not in the account"
                    tone="danger"
                    placeholder="What they should do — they read this"
                  >
                    <p className="text-[11px] leading-relaxed text-ink-muted">
                      Does not cancel the bill: they keep their deadline and can
                      send a corrected reference.{' '}
                      <strong>Your reason goes to them verbatim</strong>, so
                      write what would help.
                    </p>
                  </ReasonForm>

                  <ReasonForm
                    action={voidSubscriptionInvoiceAction}
                    hidden={{ invoiceId: row.id }}
                    submitLabel="Cancel the bill"
                    tone="danger"
                    placeholder="Raised in error, comped instead, plan withdrawn"
                  >
                    <p className="text-[11px] leading-relaxed text-ink-muted">
                      Says the money is no longer owed. Use it for a bill raised
                      in error or a subscriber being comped — not for a transfer
                      you could not find, which is a refusal.
                    </p>
                  </ReasonForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Settled and cancelled"
        description="The last 50 bills that are no longer open, newest first."
      >
        {overview.recent.length === 0 ? (
          <Empty>Nothing has been confirmed or cancelled yet.</Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {overview.recent.map((row) => (
              <li key={row.id} className="py-3 first:pt-0 last:pb-0">
                <InvoiceHeader row={row} />
                <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                  {row.settledAt ? (
                    <>
                      Confirmed {manilaTime(row.settledAt)}
                      {row.settledByName ? ` by ${row.settledByName}` : ' by a provider'}{' '}
                      against{' '}
                      <span className="font-mono">{row.settledReference ?? '—'}</span>
                      {row.settledVia ? ` · ${row.settledVia}` : ''}
                    </>
                  ) : (
                    <>
                      Cancelled {row.voidedAt ? manilaTime(row.voidedAt) : ''} ·{' '}
                      {row.voidReason}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/** "12 Sep". Manila, like every other date anybody here reads. */
function monthDayLabel(at: Date): string {
  return formatDayIn(at);
}

/**
 * "12 Sep – 12 Oct": the month this bill buys.
 *
 * `periodEnd` is the exclusive boundary, so it is the day the NEXT period
 * starts. Shown as-is rather than as "11 Oct", because it is the same date the
 * subscriber's own screen calls their renewal day and two consoles disagreeing
 * by one day about when somebody's plan runs out is how a support call goes
 * wrong.
 */
function periodLabel(row: InvoiceRow): string {
  return `${monthDayLabel(row.periodStart)} – ${monthDayLabel(row.periodEnd)}`;
}

/**
 * Who owes what, for which month.
 *
 * The period is on the row rather than only the due date, because the question
 * a subscriber asks on the phone is "what was this ₱99 for" and the answer is
 * a month, not a deadline.
 */
function InvoiceHeader({ row }: { row: InvoiceRow }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">
          {row.subscriberName ?? 'Somebody'}{' '}
          <span className="font-normal tabular-nums text-ink-muted">
            {formatPhilippineMobile(row.subscriberPhone)}
          </span>
        </span>
        <span className="text-base font-bold tabular-nums">
          {formatCentavos(row.amountCentavos)}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-ink-muted">
        {row.planName} · {periodLabel(row)} ·{' '}
        <Pill
          tone={
            row.state === 'AWAITING_REVIEW'
              ? 'warn'
              : row.state === 'OVERDUE'
                ? 'bad'
                : row.state === 'SETTLED'
                  ? 'good'
                  : 'neutral'
          }
        >
          {INVOICE_STATE_CONSOLE_TEXT[row.state]}
        </Pill>
        {row.isFirstBill ? <> · first bill</> : null} · due{' '}
        {monthDayLabel(row.dueAt)}
      </p>
    </>
  );
}
