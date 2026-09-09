import Link from 'next/link';
import {
  SubscriptionOrigin,
  SubscriptionStatus,
  type ServiceKey,
  type SubscriptionInvoice,
} from '@prisma/client';
import { requireScreen } from '@/lib/auth/access';
import { getAllServices } from '@/lib/services/registry';
import {
  benefitScopeLabel,
  benefitTerms,
  getLaunchedPlan,
} from '@/lib/subscriptions/plans';
import {
  BENEFIT_CONFERRING_STATUSES,
  liveSubscription,
  monthToDateUsage,
  type BenefitUsageLine,
} from '@/lib/subscriptions/enrollment';
import { outstandingInvoiceFor } from '@/lib/subscriptions/billing';
import {
  RECOVERY_DAYS,
  invoiceState,
  manilaDateLabel,
} from '@/lib/subscriptions/billing-policy';
import {
  SubscriptionRailNotReadyError,
  isPaidEnrollmentAvailable,
  resolveSubscriptionRail,
  type PaymentRequest,
} from '@/lib/subscriptions/rails';
import { CancelPlanButton } from '@/components/subscriptions/CancelPlanButton';
import { SubscribeButton } from '@/components/subscriptions/SubscribeButton';
import { PayInvoiceByTransfer } from '@/components/subscriptions/PayInvoiceByTransfer';
import { formatCentavos } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * TARA Plus.
 *
 * The card is assembled from the plan's benefit ROWS — label, scope and terms
 * all come from the same columns the pricing engine reads, so this screen cannot
 * promise a benefit checkout will not apply. Adding a fourth benefit is an
 * insert, not a deploy.
 *
 * ### What this screen has to get right now that the plan can be bought
 *
 * It used to have three states and the middle one said sign-up was closed,
 * because it was: credits are spendable on orders only and cash on delivery
 * cannot bill a monthly fee, so there was nothing to collect with. A transfer
 * rail exists now, so the states are:
 *
 *   - no plan launched            → nothing to see
 *   - launched, nowhere to pay    → the plan, and why sign-up is closed
 *   - launched, not enrolled      → the plan, and a Subscribe button
 *   - enrolled, something owed    → what to send, where, and by when
 *   - enrolled and paid           → what the month has actually delivered
 *
 * Two of those are about honesty rather than layout, and they are the reason
 * this file is longer than it was:
 *
 * **A PENDING_PAYMENT enrolment confers nothing.** The pricing engine requires
 * `status = ACTIVE`, so a customer who has signed up and not paid has no
 * benefits at all. The status pill says "Waiting for payment" and the benefit
 * list says it is not on yet, because the alternative is somebody arriving at
 * checkout expecting free delivery and finding out from the total.
 *
 * **The bill panel says this is a manual transfer, not a card on file.** Every
 * subscription anybody has held works the other way round. See
 * `PayInvoiceByTransfer` for why that sentence is worth the sign-ups it costs.
 */

const ORIGIN_LABELS: Readonly<Record<SubscriptionOrigin, string>> = {
  [SubscriptionOrigin.PAID]: 'Paid plan',
  [SubscriptionOrigin.COMPED]: 'Given by TARA',
  [SubscriptionOrigin.PROMOTIONAL]: 'From a promo',
};

const STATUS_LABELS: Readonly<Record<SubscriptionStatus, string>> = {
  // Enrolled and not yet paid for. Deliberately not "Active" — the customer
  // has no benefits yet and telling them otherwise would send them to
  // checkout expecting free delivery.
  [SubscriptionStatus.PENDING_PAYMENT]: 'Waiting for payment',
  [SubscriptionStatus.ACTIVE]: 'Active',
  [SubscriptionStatus.PAST_DUE]: 'Unpaid',
  [SubscriptionStatus.CANCELLED]: 'Cancelled',
  [SubscriptionStatus.EXPIRED]: 'Ended',
};

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-PH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Where to send the money, or null when the rail cannot say.
 *
 * Both failures are handled rather than thrown: a misconfigured provider key
 * makes `resolveSubscriptionRail` throw on purpose so a deployment notices,
 * and a rail that cannot produce instructions raises
 * `SubscriptionRailNotReadyError`. Neither should turn a subscriber's own
 * screen into an error page — the bill is real either way, and the screen can
 * still say what is owed while an operator fixes the configuration.
 */
async function transferDetailsFor(
  invoice: SubscriptionInvoice,
): Promise<PaymentRequest | null> {
  let rail;
  try {
    rail = resolveSubscriptionRail();
  } catch {
    return null;
  }
  if (!rail) return null;

  try {
    return await rail.request({
      id: invoice.id,
      reference: invoice.reference,
      amountCentavos: invoice.amountCentavos,
      dueAt: invoice.dueAt,
    });
  } catch (error) {
    if (error instanceof SubscriptionRailNotReadyError) return null;
    throw error;
  }
}

export default async function PlusPage() {
  const user = await requireScreen('plus');

  const now = new Date();

  const [plan, subscription, services, invoice] = await Promise.all([
    getLaunchedPlan(),
    liveSubscription(user.id),
    getAllServices(),
    outstandingInvoiceFor(user.id, now),
  ]);

  const displayNameByKey = new Map<ServiceKey, string>(
    services.map((service) => [service.key, service.displayName]),
  );

  // A grant survives the plan being pulled; the benefits do not, because the
  // pricing engine requires an active plan. Say so rather than showing a plan
  // that quietly does nothing.
  const benefitsPaused = subscription !== null && plan === null;
  const shown = subscription?.plan ?? plan;

  // ACTIVE and nothing else. Read from the same constant the pricing engine
  // filters on, so this screen cannot claim benefits are on when checkout
  // would refuse them.
  const benefitsOn =
    subscription !== null &&
    !benefitsPaused &&
    BENEFIT_CONFERRING_STATUSES.includes(subscription.status);

  const usage: BenefitUsageLine[] = subscription
    ? await monthToDateUsage(subscription)
    : [];
  const usageByBenefitId = new Map(usage.map((line) => [line.benefit.id, line]));

  const details = invoice ? await transferDetailsFor(invoice) : null;

  if (!shown) {
    return (
      <main className="px-4 py-6">
        <h1 className="text-xl font-bold">TARA Plus</h1>
        <p className="mt-2 max-w-prose text-sm text-ink-muted">
          No subscription plan is open yet. We will tell you when one is.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm font-semibold text-brand-700">
          ← Home
        </Link>
      </main>
    );
  }

  const canSubscribe =
    subscription === null &&
    plan !== null &&
    plan.monthlyPriceCentavos > 0 &&
    isPaidEnrollmentAvailable();

  return (
    <main className="pb-4">
      <header className="bg-gradient-to-br from-brand-700 to-brand-900 px-4 pb-6 pt-6 text-white">
        <p className="text-sm font-semibold uppercase tracking-wide text-white/75">
          {shown.name}
        </p>
        <p className="mt-1 text-3xl font-bold tabular-nums">
          {formatCentavos(shown.monthlyPriceCentavos)}
          <span className="ml-1 align-middle text-sm font-medium text-white/80">
            /month
          </span>
        </p>
        {shown.tagline ? (
          <p className="mt-2 text-xs leading-relaxed text-white/80">{shown.tagline}</p>
        ) : null}

        {subscription ? (
          <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold">
            {STATUS_LABELS[subscription.status]} · {ORIGIN_LABELS[subscription.origin]}
          </p>
        ) : null}
      </header>

      {benefitsPaused ? (
        <p
          role="status"
          className="mx-4 mt-4 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200"
        >
          This plan is paused, so no benefits apply at checkout for now. Your
          subscription stays as it is, and you are not being charged.
        </p>
      ) : null}

      {/* The bill, above the benefit list. What somebody owes is the reason
          they opened this screen, and burying it under a feature list is how
          a subscription lapses with the answer two scrolls down. */}
      {invoice && details ? (
        <div className="mx-4 mt-4">
          <PayInvoiceByTransfer
            invoiceId={invoice.id}
            state={invoiceState(invoice, now)}
            details={{
              label: details.label,
              accountName: details.accountName,
              accountNumber: details.accountNumber,
              amountCentavos: details.amountCentavos,
              ourReference: details.ourReference,
            }}
            dueLabel={manilaDateLabel(invoice.dueAt)}
            refusalNote={invoice.lastFailureReason}
            isFirstBill={subscription?.status === SubscriptionStatus.PENDING_PAYMENT}
          />
        </div>
      ) : invoice ? (
        /* There is a bill and the rail cannot say where to send it. Rare and
           worth its own message: somebody has switched the transfer account
           off while a subscriber owes money, and telling them to pay without
           saying where would be worse than admitting it. */
        <p
          role="alert"
          className="mx-4 mt-4 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200"
        >
          You have {formatCentavos(invoice.amountCentavos)} due on{' '}
          {manilaDateLabel(invoice.dueAt)}, but we cannot show you where to send
          it right now. Nothing is charged and nothing lapses while this is our
          fault — message us from Help and we will sort it.
        </p>
      ) : null}

      <section
        aria-labelledby="plus-benefits"
        className="mx-4 mt-4 rounded-xl bg-surface shadow-sm ring-1 ring-black/5"
      >
        <h2 id="plus-benefits" className="px-4 pt-4 text-[13px] font-semibold">
          What the plan includes
        </h2>

        {/* Enrolled but not conferring. The benefit list below is a promise
            about a future month, and a customer reading it as today's is one
            who finds out at checkout. */}
        {subscription && !benefitsOn && !benefitsPaused ? (
          <p className="mx-4 mt-2 rounded-lg bg-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
            {subscription.status === SubscriptionStatus.PENDING_PAYMENT
              ? 'None of this is on yet — it starts when your first transfer is confirmed.'
              : `Your benefits have stopped because the last bill went unpaid. Paying within ${RECOVERY_DAYS} days puts them straight back.`}
          </p>
        ) : null}

        <ul className="mt-1 divide-y divide-black/5">
          {shown.benefits.map((benefit) => {
            const line = usageByBenefitId.get(benefit.id);
            return (
              <li key={benefit.id} className="px-4 py-3">
                <p className="text-sm font-medium">{benefit.displayLabel}</p>
                <p className="mt-0.5 text-[11px] text-ink-faint">
                  {[
                    benefitScopeLabel(benefit, displayNameByKey),
                    ...benefitTerms(benefit),
                  ].join(' · ')}
                </p>

                {/* Month-to-date, read from the same usage rows checkout
                    enforces — not a second tally that could disagree. Hidden
                    while the benefits are off: "8 left" on a plan that confers
                    nothing is a promise, and the banner above having just said
                    otherwise does not unsay it. */}
                {line && benefitsOn ? (
                  <p className="mt-1.5 text-xs font-medium text-ink-muted tabular-nums">
                    {line.remainingUses !== null
                      ? `This month: ${line.usageCount} used, ${line.remainingUses} left`
                      : null}
                    {line.remainingCreditCentavos !== null
                      ? `This month: ${formatCentavos(line.creditedCentavos)} in credits, ` +
                        `${formatCentavos(line.remainingCreditCentavos)} left`
                      : null}
                    {line.remainingUses === null && line.remainingCreditCentavos === null
                      ? `This month: ${formatCentavos(line.discountedCentavos)} saved`
                      : null}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {subscription ? (
        <section className="mx-4 mt-4 space-y-3">
          <div className="rounded-xl bg-surface p-4 text-xs shadow-sm ring-1 ring-black/5">
            <p className="text-ink-muted">
              {subscription.status === SubscriptionStatus.PENDING_PAYMENT
                ? `Signed up ${formatDate(subscription.startedAt)}. Your first month starts when the transfer is confirmed.`
                : subscription.origin === SubscriptionOrigin.PAID
                  ? `Started ${formatDate(subscription.startedAt)}. Paid up to ${formatDate(subscription.renewsAt)}, and we will bill you a week before that.`
                  : `Started ${formatDate(subscription.startedAt)}. Ends on ${formatDate(subscription.renewsAt)} and does not auto-renew.`}
            </p>
            {subscription.grantNote ? (
              <p className="mt-1.5 text-ink-faint">Reason: {subscription.grantNote}</p>
            ) : null}
          </div>
          <CancelPlanButton />
        </section>
      ) : canSubscribe && plan ? (
        <section className="mx-4 mt-4 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
          <SubscribeButton priceLabel={formatCentavos(plan.monthlyPriceCentavos)} />
        </section>
      ) : (
        /* Sign-up is closed, and the screen says why instead of offering a
           button that would fail. Two different reasons, and the second one is
           a misconfigured plan rather than a missing rail. */
        <section className="mx-4 mt-4 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
          <p className="text-[13px] font-semibold">Sign-up is not open yet</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            {plan && plan.monthlyPriceCentavos <= 0
              ? 'This plan has no price set, so there is nothing to sign up to yet.'
              : 'We have no way to collect a monthly fee yet. Credits are for orders only, so they cannot pay for a plan.'}
          </p>
          <p className="mt-2 text-[11px] text-ink-faint">
            Already have access? Your plan is on your Profile.
          </p>
        </section>
      )}
    </main>
  );
}
