import { requireAdmin } from '@/lib/admin/access';
import { paymentsToCheck, refundsOwed } from '@/lib/admin/payments';
import { paymentRailStatus } from '@/lib/payments/rails';
import { formatCentavos } from '@/lib/money';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  confirmPaymentAction,
  recordRefundSentAction,
  refusePaymentAction,
} from '@/lib/actions/admin-actions';
import {
  Empty,
  Panel,
  Pill,
  Stat,
  humaniseEnum,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/** "4 min", "2 h". Rendered here because it is only ever read here. */
function describeWait(seconds: number): string {
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/**
 * Money.
 *
 * Two queues, and the order of the page is the order of the priorities. At the
 * top are people who have paid and are waiting on a human to look at an
 * account — their food is not being cooked until somebody here acts, so the
 * wait is shown in minutes and the longest is first. Below is money we are
 * holding on orders that fell through, which nobody is blocked on but which
 * turns into a complaint if it sits.
 *
 * The screen exists because the rail it serves is deliberately manual. Nothing
 * here talks to a payment provider: a customer sends a transfer in their own
 * app, and somebody with access to the receiving account decides whether it
 * arrived. That is slower than a webhook and it is honest about what it is —
 * and it works today, with no provider account, which a webhook does not.
 */
export default async function AdminPaymentsPage() {
  await requireAdmin();

  const [waiting, owed] = await Promise.all([paymentsToCheck(), refundsOwed()]);
  const rail = paymentRailStatus();

  const heldCentavos = owed.reduce((sum, row) => sum + row.amountCentavos, 0);
  const longestWait = waiting[0]?.waitingSeconds ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Payments</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          A customer sends the money in their own wallet app and gives us the
          reference. Check it against the receiving account, then confirm — the
          order does not reach the store until you do. Every decision is
          recorded with who made it and why.
        </p>
      </div>

      {rail.configured ? null : (
        <Panel title="No prepaid rail is configured">
          <p className="text-xs leading-relaxed text-ink-muted">
            Customers can only pay cash on delivery right now, so nothing will
            appear in these queues. Set all three of{' '}
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
            to switch it on. Missing:{' '}
            <strong>{rail.missing.join(', ')}</strong>.
          </p>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Waiting on us" value={String(waiting.length)} />
        <Stat label="Longest wait" value={describeWait(longestWait)} />
        <Stat label="Refunds to send" value={String(owed.length)} />
        <Stat label="Money held" value={formatCentavos(heldCentavos)} />
      </div>

      <Panel title={`Claimed payments to check (${waiting.length})`}>
        {waiting.length === 0 ? (
          <Empty>
            Nobody is waiting. A customer who says they have paid appears here
            within seconds.
          </Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {waiting.map((row) => (
              <li key={row.orderId} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold tabular-nums">
                    {row.orderNumber}
                  </span>
                  <span className="text-base font-bold tabular-nums">
                    {formatCentavos(row.totalCentavos)}
                  </span>
                </div>

                <p className="mt-0.5 text-[11px] text-ink-muted">
                  {row.customerName} ·{' '}
                  <span className="tabular-nums">
                    {formatPhilippineMobile(row.customerPhone)}
                  </span>
                  {row.storeName ? ` · ${row.storeName}` : ''} ·{' '}
                  <Pill tone={row.waitingSeconds > 600 ? 'warn' : 'neutral'}>
                    waiting {describeWait(row.waitingSeconds)}
                  </Pill>
                </p>

                {/* The reference, big and monospaced, because the job is
                    comparing this string to one on another screen. */}
                <div className="mt-2 rounded-lg bg-surface-sunken px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                    Look for this reference
                  </p>
                  <p className="font-mono text-sm font-bold tracking-wide">
                    {row.reference ?? '—'}
                  </p>
                  {row.allReferences.length > 1 ? (
                    <p className="mt-1 text-[11px] leading-snug text-ink-muted">
                      They also sent:{' '}
                      <span className="font-mono">
                        {row.allReferences.slice(1).join(', ')}
                      </span>
                      . Any of these arriving counts — check them all before
                      refusing.
                    </p>
                  ) : null}
                </div>

                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <ReasonForm
                    action={confirmPaymentAction}
                    hidden={{ orderId: row.orderId }}
                    submitLabel="Confirm it arrived"
                    placeholder="Where you checked, e.g. GCash app 2:31pm"
                    extraFields={
                      <label className="block">
                        <span className="text-[11px] font-semibold text-ink-muted">
                          Amount that arrived{' '}
                          <span className="font-normal text-ink-faint">
                            (leave blank for {formatCentavos(row.totalCentavos)})
                          </span>
                        </span>
                        <input
                          name="amount"
                          inputMode="decimal"
                          placeholder={(row.totalCentavos / 100).toFixed(2)}
                          className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </label>
                    }
                  >
                    <p className="text-[11px] leading-relaxed text-ink-muted">
                      This sends the order to the store. If they sent less than
                      the total, put the real amount in — the order keeps
                      waiting and the customer is told what is missing.
                    </p>
                  </ReasonForm>

                  <ReasonForm
                    action={refusePaymentAction}
                    hidden={{ orderId: row.orderId }}
                    submitLabel="Not in the account"
                    tone="danger"
                    placeholder="What the customer should do — they read this"
                  >
                    <p className="text-[11px] leading-relaxed text-ink-muted">
                      Does not cancel the order: a mistyped digit is the likely
                      answer and they keep their slot until the payment window
                      runs out. <strong>Your reason goes to them verbatim</strong>,
                      so write what would help.
                    </p>
                  </ReasonForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`Refunds to send (${owed.length})`}>
        {owed.length === 0 ? (
          <Empty>
            Nothing held on an order that fell through. This clears itself as
            soon as a refund is recorded — it is computed from the ledger, not
            from a flag somebody has to remember to set.
          </Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {owed.map((row) => (
              <li key={row.orderId} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold tabular-nums">
                    {row.orderNumber}
                  </span>
                  <span className="text-base font-bold tabular-nums text-amber-800">
                    {formatCentavos(row.amountCentavos)}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  {row.customerName} ·{' '}
                  <span className="tabular-nums">
                    {formatPhilippineMobile(row.customerPhone)}
                  </span>{' '}
                  · <Pill tone="warn">{humaniseEnum(row.status)}</Pill>
                </p>

                <div className="mt-2 max-w-md">
                  <ReasonForm
                    action={recordRefundSentAction}
                    hidden={{ orderId: row.orderId }}
                    submitLabel="Record it as sent"
                    placeholder="Your reference for the transfer back"
                    extraFields={
                      <label className="block">
                        <span className="text-[11px] font-semibold text-ink-muted">
                          Amount you sent
                        </span>
                        <input
                          name="amount"
                          inputMode="decimal"
                          defaultValue={(row.amountCentavos / 100).toFixed(2)}
                          className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                        />
                      </label>
                    }
                  >
                    <p className="text-[11px] leading-relaxed text-ink-muted">
                      <strong>Send the money first.</strong> This records that
                      you did it, with your name against it — nothing here can
                      move money into somebody&rsquo;s wallet.
                    </p>
                  </ReasonForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
