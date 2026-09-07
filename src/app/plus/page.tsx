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
  [SubscriptionOrigin.PAID]: 'Bayad na plan',
  [SubscriptionOrigin.COMPED]: 'Bigay ng Deliveryapp',
  [SubscriptionOrigin.PROMOTIONAL]: 'Galing sa promo',
};

const STATUS_LABELS: Readonly<Record<SubscriptionStatus, string>> = {
  [SubscriptionStatus.ACTIVE]: 'Aktibo',
  [SubscriptionStatus.PAST_DUE]: 'Hindi pa bayad',
  [SubscriptionStatus.CANCELLED]: 'Itinigil',
  [SubscriptionStatus.EXPIRED]: 'Tapos na',
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
          Wala pang subscription plan na bukas. Sasabihan ka namin kapag mayroon na.
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
            /buwan
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
          Naka-pause ang plan na ito, kaya wala munang benefits sa checkout.
          Nananatili ang subscription mo at hindi ka binabayaran.
        </p>
      ) : null}

      <section
        aria-labelledby="plus-benefits"
        className="mx-4 mt-4 rounded-xl bg-surface shadow-sm ring-1 ring-black/5"
      >
        <h2 id="plus-benefits" className="px-4 pt-4 text-[13px] font-semibold">
          Kasama sa plan
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
                      ? `Ngayong buwan: ${line.usageCount} nagamit, ${line.remainingUses} pa`
                      : null}
                    {line.remainingCreditCentavos !== null
                      ? `Ngayong buwan: ${formatCentavos(line.creditedCentavos)} na credits, ` +
                        `${formatCentavos(line.remainingCreditCentavos)} pa`
                      : null}
                    {line.remainingUses === null && line.remainingCreditCentavos === null
                      ? `Ngayong buwan: ${formatCentavos(line.discountedCentavos)} na natipid`
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
              Nagsimula {formatDate(subscription.startedAt)}.{' '}
              {subscription.origin === SubscriptionOrigin.PAID
                ? `Mag-renew sa ${formatDate(subscription.renewsAt)}.`
                : `Tatapos sa ${formatDate(subscription.renewsAt)} at hindi mag-auto-renew.`}
            </p>
            {subscription.grantNote ? (
              <p className="mt-1.5 text-ink-faint">Dahilan: {subscription.grantNote}</p>
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
          <p className="text-[13px] font-semibold">Hindi pa bukas ang sign-up</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            {isPaidEnrollmentAvailable()
              ? 'Malapit na — hintayin lang ang abiso.'
              : 'Wala pa kaming paraan para kolektahin ang buwanang bayad. Ang Credits ay pang-order lang, kaya hindi puwedeng pambayad ng plan.'}
          </p>
          <p className="mt-2 text-[11px] text-ink-faint">
            May access ka na? Nasa Profile ang plan mo.
          </p>
        </section>
      )}
    </main>
  );
}
