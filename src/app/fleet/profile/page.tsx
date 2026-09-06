import { redirect } from 'next/navigation';
import { VerificationStatus } from '@prisma/client';
import {
  getFleetPartner,
  getOfferTallies,
  getPartnerEarnings,
  listVerifications,
} from '@/lib/fleet/partner';
import { getAllServices } from '@/lib/services/registry';
import { ApplyForServiceButton } from '@/components/fleet/ApplyForServiceButton';
import { formatCentavos } from '@/lib/money';

export const dynamic = 'force-dynamic';

const STATUS_LABELS: Record<VerificationStatus, string> = {
  [VerificationStatus.NOT_SUBMITTED]: 'Hindi pa nag-apply',
  [VerificationStatus.PENDING]: 'Hinihintay',
  [VerificationStatus.APPROVED]: 'Approved',
  [VerificationStatus.REJECTED]: 'Tinanggihan',
  [VerificationStatus.SUSPENDED]: 'Suspendido',
};

const STATUS_CLASSES: Record<VerificationStatus, string> = {
  [VerificationStatus.NOT_SUBMITTED]: 'bg-surface-sunken text-ink-faint',
  [VerificationStatus.PENDING]: 'bg-amber-50 text-amber-800',
  [VerificationStatus.APPROVED]: 'bg-emerald-50 text-emerald-800',
  [VerificationStatus.REJECTED]: 'bg-rose-50 text-rose-800',
  [VerificationStatus.SUSPENDED]: 'bg-rose-50 text-rose-800',
};

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

  const [verifications, earnings, tallies, services] = await Promise.all([
    listVerifications(partner.id),
    getPartnerEarnings(partner),
    getOfferTallies(partner.id),
    getAllServices(),
  ]);

  const applied = new Set(verifications.map((row) => row.serviceType));
  const notYetApplied = services.filter(
    (service) => service.requiresRider && !applied.has(service.key),
  );

  const decided = tallies.accepted + tallies.declined + tallies.expired;

  return (
    <main className="space-y-4 px-4 py-4">
      <section
        aria-labelledby="approvals-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="approvals-heading" className="text-[13px] font-semibold">
          Mga approval
        </h2>
        <p className="mt-0.5 text-[11px] text-ink-muted">
          Bawat service ay hiwalay na desisyon.
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
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_CLASSES[row.status]}`}
              >
                {STATUS_LABELS[row.status]}
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
          <Row label="Kita ngayong linggo" value={formatCentavos(earnings.weekCentavos)} />
          <Row label="Jobs ngayong linggo" value={String(earnings.weekJobs)} />
          <Row label="Lahat ng tapos" value={String(earnings.lifetimeJobs)} />
          <Row
            label="Acceptance rate"
            value={
              decided === 0
                ? 'Wala pang offer'
                : `${Math.round(earnings.acceptanceRate * 100)}% (${tallies.accepted}/${decided})`
            }
          />
          <Row
            label="Rating"
            value={
              earnings.ratingCount === 0
                ? 'Wala pang rating'
                : `${earnings.ratingAvg.toFixed(1)} (${earnings.ratingCount})`
            }
          />
        </dl>
        {tallies.superseded > 0 ? (
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            {tallies.superseded} offer ang nauna nang nakuha ng iba. Hindi ito
            binibilang laban sa iyo.
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="vehicle-heading"
        className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <h2 id="vehicle-heading" className="text-[13px] font-semibold">
          Sasakyan
        </h2>
        <p className="mt-1 text-xs capitalize text-ink-muted">
          {partner.vehicleType.toLowerCase().replace(/_/g, ' ')}
          {partner.vehiclePlate ? ` · ${partner.vehiclePlate}` : ''}
        </p>
        <p className="mt-2 text-[11px] text-ink-faint">
          Kontakin ang support para magpalit ng sasakyan.
        </p>
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
