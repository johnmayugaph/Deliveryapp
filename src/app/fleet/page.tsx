import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  getActiveJob,
  getFleetPartner,
  getOfferTallies,
  getPartnerEarnings,
} from '@/lib/fleet/partner';
import { listPartnerOffers } from '@/lib/fleet/dispatch-offers';
import { computeAcceptanceRate } from '@/lib/fleet/offer-policy';
import { OfferCard } from '@/components/fleet/OfferCard';
import { OrderLiveRefresh } from '@/components/orders/OrderLiveRefresh';
import { formatCentavos } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * The offers board.
 *
 * Only offers made to THIS partner, and only for services they are approved
 * for — that filtering happens in `findDispatchCandidates`, which reads
 * `enabledServices`, so a partner approved for food is never shown a passenger
 * trip. Nothing on this screen needs to know what any vertical is.
 */
export default async function FleetOffersPage() {
  const partner = await getFleetPartner();
  if (!partner) {
    redirect('/fleet/apply');
  }

  const [offers, activeJob, earnings, tallies] = await Promise.all([
    listPartnerOffers(partner.id),
    getActiveJob(partner.id),
    getPartnerEarnings(partner),
    getOfferTallies(partner.id),
  ]);

  // Computed from the offer records, not from the stored ranking figure: that
  // one defaults to 1 so a new partner is not buried in the candidate list,
  // and showing it here would put a 100% next to no offers at all.
  const acceptanceRate = computeAcceptanceRate(tallies);

  return (
    <main>
      {/* Offers arrive from a cron-driven dispatch loop, so the board polls.
          A short interval, because an offer only lives 60 seconds. */}
      <OrderLiveRefresh isActive={partner.isOnline && !activeJob} intervalMs={10_000} />

      <section aria-label="Earnings" className="grid grid-cols-3 gap-2 px-4 py-3">
        <Stat label="Kita ngayon" value={formatCentavos(earnings.todayCentavos)} />
        <Stat label="Jobs ngayon" value={String(earnings.todayJobs)} />
        <Stat
          label="Acceptance"
          value={acceptanceRate === null ? '—' : `${Math.round(acceptanceRate * 100)}%`}
        />
      </section>

      {activeJob ? (
        <Link
          href="/fleet/job"
          className="mx-4 mb-3 flex items-center justify-between rounded-xl bg-brand-700 px-4 py-3 text-white shadow-sm"
        >
          <span className="min-w-0">
            <span className="block text-sm font-bold">May hawak kang order</span>
            <span className="mt-0.5 block text-[11px] text-white/85">
              {activeJob.order.orderNumber} · {activeJob.service.displayName}
            </span>
          </span>
          <span aria-hidden className="text-sm">→</span>
        </Link>
      ) : null}

      {partner.isSuspended ? (
        <p className="mx-4 rounded-xl bg-rose-50 px-3 py-2.5 text-xs text-rose-800">
          Suspendido ang account mo. Kontakin ang support.
        </p>
      ) : partner.enabledServices.length === 0 ? (
        <div className="mx-4 rounded-xl bg-amber-50 px-3 py-3 text-xs text-amber-900">
          <p className="font-semibold">Hinihintay pa ang approval mo.</p>
          <p className="mt-1 leading-relaxed">
            Walang offer na darating hangga&apos;t wala kang approved na service.{' '}
            <Link href="/fleet/profile" className="font-semibold underline">
              Tingnan ang status
            </Link>
            .
          </p>
        </div>
      ) : !partner.isOnline ? (
        <p className="px-4 py-10 text-center text-sm text-ink-muted">
          Offline ka. Mag-online para makatanggap ng offers.
        </p>
      ) : activeJob ? (
        <p className="px-4 py-8 text-center text-sm text-ink-muted">
          Walang bagong offer habang may hawak kang order.
        </p>
      ) : offers.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-ink-muted">
          Walang offer sa ngayon. Manatiling online.
        </p>
      ) : (
        <ul className="space-y-2 px-4 pb-6">
          {offers.map((entry) => (
            <OfferCard
              key={entry.offer.id}
              offer={{
                offerId: entry.offer.id,
                orderNumber: entry.order.orderNumber,
                serviceName: entry.service.displayName,
                pickupLabel: entry.pickup.label ?? entry.pickup.line1,
                pickupArea: [entry.pickup.barangay, entry.pickup.cityName]
                  .filter(Boolean)
                  .join(', '),
                dropoffArea: [entry.dropoff.barangay, entry.dropoff.cityName]
                  .filter(Boolean)
                  .join(', '),
                distanceMeters: entry.offer.distanceMeters,
                earningsCentavos: entry.earningsCentavos,
                secondsRemaining: entry.secondsRemaining,
              }}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface px-3 py-2.5 shadow-sm ring-1 ring-black/5">
      <p className="text-sm font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
    </div>
  );
}
