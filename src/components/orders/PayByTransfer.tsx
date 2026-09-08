'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PaymentStatus } from '@prisma/client';
import { submitPaymentReferenceAction } from '@/lib/actions/payment-actions';
import { formatCentavos } from '@/lib/money';
import { MAX_REFERENCE_LENGTH, describePaymentWait } from '@/lib/payments/policy';

export interface TransferDetails {
  label: string;
  accountName: string;
  accountNumber: string;
  amountCentavos: number;
  ourReference: string;
}

/**
 * How a customer pays, and what they see while they wait.
 *
 * Three states, and the middle one is the one worth designing for. Before they
 * pay, this is instructions plus a box. After they submit a reference it is a
 * waiting message, because a person who has just sent ₱324 into the void wants
 * confirmation that we know about it, and a form still sitting there asking for
 * a reference reads as "that did not work". After confirmation it is gone —
 * replaced by the tracking panel that appears when the order moves on.
 *
 * The amount is shown as one copyable number and repeated in the instruction,
 * because sending the wrong amount is the single most common way this rail
 * goes wrong and it costs somebody a phone call to fix.
 */
export function PayByTransfer({
  orderId,
  status,
  details,
  refusalNote,
}: {
  orderId: string;
  status: PaymentStatus;
  details: TransferDetails;
  /**
   * Why the last attempt was refused, in the words of whoever refused it.
   * Shown here rather than only in the inbox: this is the screen with the
   * field they have to correct.
   */
  refusalNote: string | null;
}) {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [result, action, pending] = useActionState(submitPaymentReferenceAction, null);

  useEffect(() => setHydrated(true), []);

  // The server copy is what decides whether the form is still needed, so a
  // successful submit has to go back and ask. Same fix as every other console
  // control: a server action called from a client function is not a
  // navigation, so nothing revalidates on its own.
  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);

  const claimed = status === PaymentStatus.CLAIMED;

  return (
    <section
      aria-labelledby="pay-heading"
      className="overflow-hidden rounded-xl bg-surface shadow-sm ring-1 ring-black/5"
    >
      <div className="border-b border-black/5 bg-brand-50 px-4 py-2.5">
        <h2 id="pay-heading" className="text-[13px] font-semibold text-brand-900">
          {claimed ? 'Checking your payment' : `Pay with ${details.label}`}
        </h2>
        <p className="mt-0.5 text-[11px] leading-snug text-brand-900/80">
          {describePaymentWait(status)}
        </p>
      </div>

      {refusalNote && status === PaymentStatus.FAILED ? (
        <p
          role="alert"
          className="border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-[12px] leading-relaxed text-rose-900"
        >
          {refusalNote}
        </p>
      ) : null}

      {claimed ? null : (
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
                {details.accountName}
              </span>
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-2">
            <dt className="text-ink-muted">Put in the note</dt>
            <dd className="font-semibold tabular-nums">{details.ourReference}</dd>
          </div>
        </dl>
      )}

      <form action={action} className="space-y-2 px-4 pb-3.5 pt-3">
        <input type="hidden" name="orderId" value={orderId} />

        {claimed ? (
          <p className="text-[11px] leading-relaxed text-ink-muted">
            Sent the wrong amount, or the wrong reference? Enter the correct
            reference number below and we will check that one instead.
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
            maxLength={MAX_REFERENCE_LENGTH}
            placeholder="e.g. 1234567890123"
            className="mt-0.5 w-full rounded-lg bg-surface-sunken px-2.5 py-2 text-[13px] tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <span className="mt-0.5 block text-[11px] text-ink-faint">
            It is on the receipt in your {details.label} app. Spaces and dashes
            are fine.
          </span>
        </label>

        <button
          type="submit"
          disabled={!hydrated || pending}
          className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-[13px] font-semibold text-white disabled:bg-ink-faint"
        >
          {pending ? 'Sending…' : claimed ? 'Use this reference instead' : 'I have sent it'}
        </button>

        <noscript>
          <p className="text-[11px] leading-relaxed text-rose-700">
            This needs JavaScript. Your order is safe and still waiting — open
            it again once scripts are enabled, or message us from Help with your
            reference number.
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
    </section>
  );
}
