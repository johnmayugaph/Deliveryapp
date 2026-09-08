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
        <p className="text-sm text-ink-muted">You are not holding an order right now.</p>
        <Link href="/fleet" className="mt-3 inline-block text-sm font-semibold text-brand-700">
          See the offers
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

      {/* The money question, before the addresses.
          A rider reads this screen at a kerb with a helmet on, and the one
          thing that costs somebody money if it is missed is whether to ask for
          cash. So it is a band of colour above everything else and it says the
          amount, not just "paid" — a rider holding out a hand for ₱324 needs
          the number, and a rider on a prepaid order needs to not ask at all. */}
      {job.cashToCollectCentavos > 0 ? (
        <section
          aria-label="Payment"
          className="rounded-xl bg-amber-100 p-4 ring-1 ring-amber-300"
        >
          <p className="text-[11px] font-bold uppercase tracking-wide text-amber-900">
            Collect at the door
          </p>
          <p className="mt-0.5 text-2xl font-extrabold tabular-nums text-amber-950">
            {formatCentavos(job.cashToCollectCentavos)}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-amber-900">
            Cash. Count it before you hand the order over.
          </p>
        </section>
      ) : (
        <section
          aria-label="Payment"
          className="rounded-xl bg-emerald-50 p-4 ring-1 ring-emerald-200"
        >
          <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-900">
            Already paid
          </p>
          <p className="mt-0.5 text-sm font-semibold text-emerald-950">
            Collect nothing. Do not ask for money.
          </p>
        </section>
      )}

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
