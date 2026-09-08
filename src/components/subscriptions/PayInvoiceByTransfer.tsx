'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { submitInvoiceReferenceAction } from '@/lib/actions/subscription-actions';
import { formatCentavos } from '@/lib/money';
import type { InvoiceState } from '@/lib/subscriptions/billing-policy';

export interface InvoiceTransferDetails {
  label: string;
  accountName: string;
  accountNumber: string;
  amountCentavos: number;
  /** The invoice reference, which is what goes in the transfer note. */
  ourReference: string;
}

/**
 * What the subscriber owes, where to send it, and the box for the reference.
 *
 * Deliberately the same furniture as `PayByTransfer` for an order: the same
 * account, the same three rows, the same "I have sent it". A customer should
 * not have to learn two ways to pay us, and the differences that do exist are
 * the ones that matter.
 *
 * ### The sentence at the bottom is the point of this component
 *
 * It says this is a transfer somebody makes by hand every month, and not a
 * card on file. That is the single most important thing on the screen, because
 * every subscription anybody has ever had works the other way: they authorise
 * once and forget. A customer who assumes that here will lose their benefits
 * on a month they believed was covered — and they will be right to be annoyed,
 * because nothing told them otherwise.
 *
 * Saying it plainly costs some sign-ups. It costs fewer than a lapse nobody
 * saw coming.
 */
export function PayInvoiceByTransfer({
  invoiceId,
  state,
  details,
  dueLabel,
  refusalNote,
  isFirstBill,
}: {
  invoiceId: string;
  state: InvoiceState;
  details: InvoiceTransferDetails;
  /** "12 September". Rendered on the server, in Manila time. */
  dueLabel: string;
  /**
   * Why the last reference was refused, in the words of whoever refused it.
   * Shown here rather than only in the inbox, because this is the screen with
   * the field they have to correct.
   */
  refusalNote: string | null;
  /** A first bill buys the plan; a renewal keeps it. Different sentences. */
  isFirstBill: boolean;
}) {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [result, action, pending] = useActionState(submitInvoiceReferenceAction, null);

  useEffect(() => setHydrated(true), []);

  // The server copy decides whether this panel is still needed, and a server
  // action called from a client function is not a navigation — so ask.
  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);

  const claimed = state === 'AWAITING_REVIEW';

  return (
    <section
      aria-labelledby="invoice-heading"
      className="overflow-hidden rounded-xl bg-surface shadow-sm ring-1 ring-black/5"
    >
      <div
        className={`border-b px-4 py-2.5 ${
          state === 'OVERDUE'
            ? 'border-rose-200 bg-rose-50'
            : 'border-black/5 bg-brand-50'
        }`}
      >
        <h2
          id="invoice-heading"
          className={`text-[13px] font-semibold ${
            state === 'OVERDUE' ? 'text-rose-900' : 'text-brand-900'
          }`}
        >
          {claimed
            ? 'Checking your transfer'
            : state === 'OVERDUE'
              ? `Overdue since ${dueLabel}`
              : isFirstBill
                ? 'One transfer to start your plan'
                : `Due ${dueLabel}`}
        </h2>
        <p
          className={`mt-0.5 text-[11px] leading-snug ${
            state === 'OVERDUE' ? 'text-rose-900/80' : 'text-brand-900/80'
          }`}
        >
          {claimed
            ? 'Somebody is matching it against the account. Your benefits switch on as soon as it is confirmed.'
            : state === 'OVERDUE'
              ? 'Your benefits have stopped. Paying now puts them straight back.'
              : isFirstBill
                ? `Send it by ${dueLabel} or the sign-up is let go — nothing is owed if you change your mind.`
                : 'Pay before this date and your benefits carry on without a gap.'}
        </p>
      </div>

      {refusalNote ? (
        <p
          role="alert"
          className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] leading-relaxed text-amber-900"
        >
          {refusalNote}
        </p>
      ) : null}

      <dl className="divide-y divide-black/5 px-4 text-[12px]">
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="text-ink-muted">Send exactly</dt>
          <dd className="text-base font-bold tabular-nums">
            {formatCentavos(details.amountCentavos)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="text-ink-muted">To</dt>
          <dd className="text-right font-semibold tabular-nums">
            {details.accountNumber}
            <span className="block text-[11px] font-normal text-ink-muted">
              {details.accountName} · {details.label}
            </span>
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="text-ink-muted">Put in the note</dt>
          <dd className="font-semibold tracking-wide">{details.ourReference}</dd>
        </div>
      </dl>

      <form action={action} className="space-y-2 px-4 pb-3.5 pt-3">
        <input type="hidden" name="invoiceId" value={invoiceId} />

        {claimed ? (
          <p className="text-[11px] leading-relaxed text-ink-muted">
            Sent the wrong amount, or mistyped the reference? Enter the correct
            one and we will check that instead.
          </p>
        ) : null}

        <label className="block">
          <span className="text-[11px] font-semibold text-ink-muted">
            Reference number
          </span>
          <input
            name="reference"
            inputMode="numeric"
            autoComplete="off"
            maxLength={120}
            placeholder="e.g. 1234567890123"
            className="mt-0.5 w-full rounded-lg bg-surface-sunken px-2.5 py-2 text-[13px] tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <span className="mt-0.5 block text-[11px] text-ink-faint">
            It is on the receipt in your {details.label} app.
          </span>
        </label>

        <button
          type="submit"
          disabled={!hydrated || pending}
          className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-[13px] font-semibold text-white disabled:bg-ink-faint"
        >
          {pending
            ? 'Sending…'
            : claimed
              ? 'Use this reference instead'
              : 'I have sent it'}
        </button>

        <noscript>
          <p className="text-[11px] leading-relaxed text-rose-700">
            This needs JavaScript. Nothing is lost — the bill is still open, so
            open this page again once scripts are enabled, or message us from
            Help with your reference number.
          </p>
        </noscript>

        {result ? (
          <p
            role={result.ok ? 'status' : 'alert'}
            className={`text-[11px] leading-relaxed ${
              result.ok ? 'text-emerald-800' : 'text-rose-700'
            }`}
          >
            {result.message}
          </p>
        ) : null}
      </form>

      <p className="border-t border-black/5 bg-surface-sunken px-4 py-3 text-[11px] leading-relaxed text-ink-muted">
        <strong className="font-semibold text-ink">
          This is a transfer you make each month, not a card on file.
        </strong>{' '}
        We cannot charge you and we do not hold anything to charge — so nothing
        happens automatically, in either direction. We will bill you a week
        before each month ends and send a reminder; if a transfer does not
        arrive, the benefits simply stop and nothing is owed.
      </p>
    </section>
  );
}
