import { requireStoreAccess } from '@/lib/merchant/access';
import { loadMerchantHistory } from '@/lib/merchant/queue';
import { summariseDetails } from '@/lib/orders/details';
import { statusPresentation } from '@/lib/orders/status-presentation';
import { formatCentavos } from '@/lib/money';

export const dynamic = 'force-dynamic';

const TONE_CLASSES = {
  pending: 'bg-amber-50 text-amber-800',
  active: 'bg-brand-50 text-brand-800',
  done: 'bg-emerald-50 text-emerald-800',
  failed: 'bg-rose-50 text-rose-800',
} as const;

/** Finished orders. Cancellations show their reason — usually the merchant's own. */
export default async function MerchantHistoryPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await requireStoreAccess(storeId);
  const history = await loadMerchantHistory(access.store.id);

  if (history.length === 0) {
    return (
      <main>
        <p className="px-4 py-10 text-center text-sm text-ink-muted">
          No finished orders yet.
        </p>
      </main>
    );
  }

  return (
    <main className="pb-8">
      <ul className="divide-y divide-black/5">
        {history.map(({ order, service }) => {
          const { label, tone } = statusPresentation(order.status);
          return (
            <li key={order.id} className="bg-surface px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold tabular-nums">{order.orderNumber}</span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {formatCentavos(order.subtotalCentavos)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[tone]}`}
                >
                  {label}
                </span>
                <span className="text-[11px] text-ink-faint">
                  {order.createdAt.toLocaleString('en-PH', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-ink-muted">
                {summariseDetails(order.details, service.displayName)}
              </p>
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
