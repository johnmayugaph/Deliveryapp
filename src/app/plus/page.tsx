import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SubscriptionOrigin, SubscriptionStatus, type ServiceKey } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth/session';
import { getAllServices } from '@/lib/services/registry';
import {
  benefitScopeLabel,
  benefitTerms,
  getLaunchedPlan,
} from '@/lib/subscriptions/plans';
import {
  liveSubscription,
  monthToDateUsage,
  type BenefitUsageLine,
} from '@/lib/subscriptions/enrollment';
import { isPaidEnrollmentAvailable } from '@/lib/subscriptions/payment';
import { CancelPlanButton } from '@/components/subscriptions/CancelPlanButton';
import { formatCentavos } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * Deliveryapp Plus.
 *
 * The card is assembled from the plan's benefit ROWS — label, scope and terms
 * all come from the same columns the pricing engine reads, so this screen cannot
 * promise a benefit checkout will not apply. Adding a fourth benefit is an
 * insert, not a deploy.
 *
 * Three states, and the middle one is the honest part:
 *   - no plan launched      → nothing to see
 *   - launched, not enrolled → the plan, and why sign-up is closed
 *   - enrolled               → what the month has actually delivered
 */

const ORIGIN_LABELS: Readonly<Record<SubscriptionOrigin, string>> = {
  [SubscriptionOrigin.PAID]: 'Paid plan',
  [SubscriptionOrigin.COMPED]: 'Given by Deliveryapp',
  [SubscriptionOrigin.PROMOTIONAL]: 'From a promo',
};

const STATUS_LABELS: Readonly<Record<SubscriptionStatus, string>> = {
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

export default async function PlusPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login?next=%2Fplus');
  }

  const [plan, subscription, services] = await Promise.all([
    getLaunchedPlan(),
    liveSubscription(user.id),
    getAllServices(),
  ]);

  const displayNameByKey = new Map<ServiceKey, string>(
    services.map((service) => [service.key, service.displayName]),
  );

  // A grant survives the plan being pulled; the benefits do not, because the
  // pricing engine requires an active plan. Say so rather than showing a plan
  // that quietly does nothing.
  const benefitsPaused = subscription !== null && plan === null;
  const shown = subscription?.plan ?? plan;

  const usage: BenefitUsageLine[] = subscription
    ? await monthToDateUsage(subscription)
    : [];
  const usageByBenefitId = new Map(usage.map((line) => [line.benefit.id, line]));

  if (!shown) {
    return (
      <main className="px-4 py-6">
        <h1 className="text-xl font-bold">Deliveryapp Plus</h1>
        <p className="mt-2 max-w-prose text-sm text-ink-muted">
          No subscription plan is open yet. We will tell you when one is.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm font-semibold text-brand-700">
          ← Home
        </Link>
      </main>
    );
  }

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

      <section
        aria-labelledby="plus-benefits"
        className="mx-4 mt-4 rounded-xl bg-surface shadow-sm ring-1 ring-black/5"
      >
        <h2 id="plus-benefits" className="px-4 pt-4 text-[13px] font-semibold">
          What the plan includes
        </h2>
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
                    enforces — not a second tally that could disagree. */}
                {line ? (
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
              Started {formatDate(subscription.startedAt)}.{' '}
              {subscription.origin === SubscriptionOrigin.PAID
                ? `Renews on ${formatDate(subscription.renewsAt)}.`
                : `Ends on ${formatDate(subscription.renewsAt)} and does not auto-renew.`}
            </p>
            {subscription.grantNote ? (
              <p className="mt-1.5 text-ink-faint">Reason: {subscription.grantNote}</p>
            ) : null}
          </div>
          <CancelPlanButton />
        </section>
      ) : (
        /* Sign-up is closed, and the screen says why instead of offering a
           button that would fail. The app charges cash on delivery or credits,
           and credits are spendable on orders only — neither can bill a monthly
           fee, so a paid plan needs a gateway first. */
        <section className="mx-4 mt-4 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
          <p className="text-[13px] font-semibold">Sign-up is not open yet</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            {isPaidEnrollmentAvailable()
              ? 'Soon — watch for the announcement.'
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
