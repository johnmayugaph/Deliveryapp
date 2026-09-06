import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveJob, getFleetPartner } from '@/lib/fleet/partner';
import { JobActions } from '@/components/fleet/JobActions';
import { statusPresentation } from '@/lib/orders/status-presentation';
import { formatCentavos } from '@/lib/money';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { OrderLiveRefresh } from '@/components/orders/OrderLiveRefresh';

export const dynamic = 'force-dynamic';

/**
 * The active job.
 *
 * Deliberately sparse: somebody reading this is on a motorcycle. The two
 * addresses, the contact numbers, what they earn, and one big button for the
 * next step — which the lifecycle map chose, not this screen.
 */
export default async function FleetJobPage() {
  const partner = await getFleetPartner();
  if (!partner) {
    redirect('/fleet/apply');
  }

  const job = await getActiveJob(partner.id);

  if (!job) {
    return (
      <main className="px-4 py-10 text-center">
        <p className="text-sm text-ink-muted">Wala kang hawak na order ngayon.</p>
        <Link href="/fleet" className="mt-3 inline-block text-sm font-semibold text-brand-700">
          Tingnan ang offers
        </Link>
      </main>
    );
  }

  const { label, tone } = statusPresentation(job.order.status);

  return (
    <main className="space-y-3 px-4 py-4">
      <OrderLiveRefresh isActive intervalMs={20_000} />

      <section className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              tone === 'done'
                ? 'bg-emerald-50 text-emerald-800'
                : tone === 'failed'
                  ? 'bg-rose-50 text-rose-800'
                  : 'bg-brand-50 text-brand-800'
            }`}
          >
            {label}
          </span>
          <span className="text-sm font-bold tabular-nums">
            {formatCentavos(job.earningsCentavos)}
          </span>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint tabular-nums">
          {job.order.orderNumber} · {job.service.displayName}
          {job.itemSummary ? ` · ${job.itemSummary}` : ''}
        </p>
      </section>

      <section
        aria-labelledby="pickup-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="pickup-heading" className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Pickup
        </h2>
        <p className="mt-1 text-sm font-semibold">{job.pickup.label ?? job.pickup.line1}</p>
        <p className="text-xs text-ink-muted">
          {[job.pickup.line1, job.pickup.barangay, job.pickup.cityName].filter(Boolean).join(', ')}
        </p>
        {job.pickup.contactPhone ? (
          <a
            href={`tel:${job.pickup.contactPhone}`}
            className="mt-2 inline-block text-xs font-semibold text-brand-700 tabular-nums"
          >
            {formatPhilippineMobile(job.pickup.contactPhone)}
          </a>
        ) : null}
      </section>

      <section
        aria-labelledby="dropoff-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="dropoff-heading" className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Dropoff
        </h2>
        <p className="mt-1 text-sm font-semibold">
          {job.dropoff.contactName ?? job.dropoff.label ?? 'Customer'}
        </p>
        <p className="text-xs text-ink-muted">
          {[job.dropoff.line1, job.dropoff.barangay, job.dropoff.cityName]
            .filter(Boolean)
            .join(', ')}
        </p>
        {job.dropoff.deliveryNotes ? (
          <p className="mt-2 rounded-lg bg-surface-sunken px-2 py-1.5 text-xs text-ink-muted">
            {job.dropoff.deliveryNotes}
          </p>
        ) : null}
        {job.dropoff.contactPhone ? (
          <a
            href={`tel:${job.dropoff.contactPhone}`}
            className="mt-2 inline-block text-xs font-semibold text-brand-700 tabular-nums"
          >
            {formatPhilippineMobile(job.dropoff.contactPhone)}
          </a>
        ) : null}
      </section>

      <JobActions orderId={job.order.id} nextActions={job.nextActions} />
    </main>
  );
}
