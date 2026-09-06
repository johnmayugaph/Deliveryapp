import { redirect } from 'next/navigation';
import { OrderStatus } from '@prisma/client';
import { getFleetPartner, listPartnerHistory } from '@/lib/fleet/partner';
import { statusPresentation } from '@/lib/orders/status-presentation';
import { formatCentavos } from '@/lib/money';

export const dynamic = 'force-dynamic';

const TONE_CLASSES = {
  pending: 'bg-amber-50 text-amber-800',
  active: 'bg-brand-50 text-brand-800',
  done: 'bg-emerald-50 text-emerald-800',
  failed: 'bg-rose-50 text-rose-800',
} as const;

/** Finished jobs. A cancelled job shows ₱0 — it pays nothing, and saying
 *  otherwise would be a promise broken at payout. */
export default async function FleetHistoryPage() {
  const partner = await getFleetPartner();
  if (!partner) {
    redirect('/fleet/apply');
  }

  const history = await listPartnerHistory(partner.id);

  if (history.length === 0) {
    return (
      <main>
        <p className="px-4 py-10 text-center text-sm text-ink-muted">
          Wala pang tapos na job.
        </p>
      </main>
    );
  }

  return (
    <main className="pb-8">
      <ul className="divide-y divide-black/5">
        {history.map(({ order, service, earningsCentavos }) => {
          const { label, tone } = statusPresentation(order.status);
          return (
            <li key={order.id} className="bg-surface px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold tabular-nums">{order.orderNumber}</span>
                <span
                  className={`shrink-0 text-sm font-semibold tabular-nums ${
                    order.status === OrderStatus.COMPLETED ? '' : 'text-ink-faint'
                  }`}
                >
                  {formatCentavos(earningsCentavos)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[tone]}`}>
                  {label}
                </span>
                <span className="text-[11px] text-ink-faint">
                  {service.displayName} ·{' '}
                  {(order.completedAt ?? order.updatedAt).toLocaleString('en-PH', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              {order.cancellationReason ? (
                <p className="mt-1 text-[11px] text-rose-700">{order.cancellationReason}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
