import { redirect } from 'next/navigation';
import {
  getFleetPartner,
  getOfferTallies,
  getPartnerEarnings,
  listVerifications,
} from '@/lib/fleet/partner';
import { computeAcceptanceRate } from '@/lib/fleet/offer-policy';
import {
  VERIFICATION_STATUS_CLASSES,
  VERIFICATION_STATUS_LABEL,
} from '@/lib/fleet/verification-policy';
import { getAllServices } from '@/lib/services/registry';
import { ApplyForServiceButton } from '@/components/fleet/ApplyForServiceButton';
import { BusyAlertsToggle } from '@/components/fleet/BusyAlertsToggle';
import { formatCentavos } from '@/lib/money';
import { partnerReviews } from '@/lib/ratings/reviews';
import { ReviewPanel } from '@/components/ui/ReviewPanel';

export const dynamic = 'force-dynamic';

/* The labels and the pill colours live in `fleet/verification-policy.ts`
 * rather than here, because the console shows the same rows: a rider reading
 * "Pending" and an administrator deciding on it must be looking at the same
 * word. */

/**
 * The partner's own record.
 *
 * The per-service approval list is the point of this screen: it makes visible
 * that being approved for one vertical says nothing about another, which is
 * otherwise a surprise the first time an offer does not arrive.
 */
export default async function FleetProfilePage() {
  const partner = await getFleetPartner();
  if (!partner) {
    redirect('/fleet/apply');
  }

  const [verifications, earnings, tallies, services, reviews] = await Promise.all([
    listVerifications(partner.id),
    getPartnerEarnings(partner),
    getOfferTallies(partner.id),
    getAllServices(),
    partnerReviews(partner.id),
  ]);

  const applied = new Set(verifications.map((row) => row.serviceType));
  const notYetApplied = services.filter(
    (service) => service.requiresRider && !applied.has(service.key),
  );

  const decided = tallies.accepted + tallies.declined + tallies.expired;
  const acceptanceRate = computeAcceptanceRate(tallies);

  return (
    <main className="space-y-4 px-4 py-4">
      <section
        aria-labelledby="approvals-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="approvals-heading" className="text-[13px] font-semibold">
          Approvals
        </h2>
        <p className="mt-0.5 text-[11px] text-ink-muted">
          Each service is a separate decision.
        </p>
        <ul className="mt-2 space-y-1.5">
          {verifications.map((row) => (
            <li key={row.serviceType} className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-xs font-medium">
                  {row.serviceName}
                  {row.isActiveService ? null : (
                    <span className="ml-1.5 text-[10px] text-ink-faint">coming soon</span>
                  )}
                </span>
                {row.rejectionReason ? (
                  <span className="mt-0.5 block text-[11px] text-rose-700">
                    {row.rejectionReason}
                  </span>
                ) : null}
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${VERIFICATION_STATUS_CLASSES[row.status]}`}
              >
                {VERIFICATION_STATUS_LABEL[row.status]}
              </span>
            </li>
          ))}
        </ul>

        {notYetApplied.length > 0 ? (
          <div className="mt-3 border-t border-black/5 pt-3">
            <p className="text-[11px] font-semibold text-ink-muted">Mag-apply pa</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {notYetApplied.map((service) => (
                <ApplyForServiceButton
                  key={service.key}
                  serviceKey={service.key}
                  label={service.displayName}
                />
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section
        aria-labelledby="stats-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="stats-heading" className="text-[13px] font-semibold">
          Record
        </h2>
        <dl className="mt-2 space-y-1.5 text-xs">
          <Row label="Earned this week" value={formatCentavos(earnings.weekCentavos)} />
          <Row label="Jobs this week" value={String(earnings.weekJobs)} />
          <Row label="Jobs all time" value={String(earnings.lifetimeJobs)} />
          <Row
            label="Acceptance rate"
            value={
              acceptanceRate === null
                ? 'No offers yet'
                : `${Math.round(acceptanceRate * 100)}% (${tallies.accepted}/${decided})`
            }
          />
          <Row
            label="Rating"
            value={
              earnings.ratingCount === 0
                ? 'No ratings yet'
                : `${earnings.ratingAvg.toFixed(1)} (${earnings.ratingCount})`
            }
          />
        </dl>
        {tallies.superseded > 0 ? (
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            {tallies.superseded} offers were taken by somebody closer. Those do
            not count against you.
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="vehicle-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="vehicle-heading" className="text-[13px] font-semibold">
          Vehicle
        </h2>
        <p className="mt-1 text-xs capitalize text-ink-muted">
          {partner.vehicleType.toLowerCase().replace(/_/g, ' ')}
          {partner.vehiclePlate ? ` · ${partner.vehiclePlate}` : ''}
        </p>
        <p className="mt-2 text-[11px] text-ink-faint">
          Contact support to change vehicles.
        </p>
      </section>

      <BusyAlertsToggle enabled={partner.wantsBusyAlerts} />

      {/* Their own numbers, in full — the customer-facing threshold does not
          apply to somebody looking at their own record. */}
      <section className="mt-4 px-4 pb-8">
        <ReviewPanel
          summary={reviews}
          heading="What customers said"
          emptyNote="No ratings yet. Customers can rate a delivery for two weeks afterwards."
        />
      </section>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="shrink-0 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
