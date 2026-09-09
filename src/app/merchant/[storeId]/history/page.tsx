import { requireStoreAccess } from '@/lib/merchant/access';
import { storeReviews } from '@/lib/ratings/reviews';
import { ReviewPanel } from '@/components/ui/ReviewPanel';
import { loadMerchantHistory } from '@/lib/merchant/queue';
import { summariseDetails } from '@/lib/orders/details';
import { statusPresentation } from '@/lib/orders/status-presentation';
import { formatCentavos } from '@/lib/money';
import { orderBenefitView } from '@/lib/merchant/order-benefits';
import {
  absorbedCountsFor,
  cappedNote,
  windowNote,
} from '@/lib/merchant/reporting';
import {
  AbsorbedTotalNote,
  OrderBenefitNote,
} from '@/components/merchant/OrderBenefitNote';

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
  const [history, reviews] = await Promise.all([
    loadMerchantHistory(access.store.id),
    storeReviews(access.store.id),
  ]);

  /*
    One view per order for the rows; the TOTALS come from the loader.
    
    They used to be summed from these rows, with a comment saying that made the
    total "the sum of exactly the rows above it". That was true and was the
    problem: the rows are capped at fifty and were unbounded in time, so the
    figure read as a period total while meaning "the recent fifty" — and it
    counted cancelled orders, on which TARA absorbed nothing at all.
  */
  const rows = history.rows.map((entry) => ({
    ...entry,
    view: orderBenefitView(entry.order, entry.benefits),
    wasSettled: absorbedCountsFor(entry.order.status),
  }));
  const period = windowNote(history.windowDays);
  const capped = cappedNote(rows.length, history.totalInWindow);

  const ratings = (
    <div className="px-4 pt-4">
      <ReviewPanel
        summary={reviews}
        heading="What customers said"
        emptyNote="No ratings yet. Customers can rate an order for two weeks after it is delivered."
      />
    </div>
  );

  if (rows.length === 0) {
    return (
      <main>
        {ratings}
        <p className="px-4 py-10 text-center text-sm text-ink-muted">
          No finished orders in {period}.
        </p>
      </main>
    );
  }

  return (
    <main className="pb-8">
      {ratings}
      <h2 className="px-4 pb-1 pt-5 text-[13px] font-semibold">
        Finished orders
      </h2>
      {/* The period, always, and the cap only when it bites. A list that
          silently stops at fifty rows is a list whose numbers mean something
          different from what they look like they mean. */}
      <p className="px-4 pb-1 text-[11px] text-ink-faint">
        {period.charAt(0).toUpperCase() + period.slice(1)}
        {capped ? ` · ${capped}` : ''}
      </p>
      <ul className="divide-y divide-black/5">
        {rows.map(({ order, service, view, wasSettled }) => {
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
              <OrderBenefitNote view={view} wasSettled={wasSettled} />
            </li>
          );
        })}
      </ul>
      <AbsorbedTotalNote
        absorbedCentavos={history.absorbedCentavos}
        orderCount={history.discountedCount}
        windowNote={period}
      />
    </main>
  );
}
