import { requireStoreAccess } from '@/lib/merchant/access';
import { loadMerchantQueue, loadMerchantSummary } from '@/lib/merchant/queue';
import { tierNamesForCustomers } from '@/lib/merchant/tier-customers';
import { readFoodDetails } from '@/lib/orders/details';
import { prisma } from '@/lib/prisma';
import { formatCentavos } from '@/lib/money';
import { OrderCard, type QueueCardOrder } from '@/components/merchant/OrderCard';
import { OrderLiveRefresh } from '@/components/orders/OrderLiveRefresh';

export const dynamic = 'force-dynamic';

/**
 * The live queue.
 *
 * This is the screen that unblocks the whole product: until something could
 * accept an order, every order placed was cancelled by the timeout sweep eight
 * minutes later.
 *
 * Stages come from `MERCHANT_STAGES`; the buttons on each card come from the
 * lifecycle map. Neither is decided here.
 */
export default async function MerchantQueuePage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await requireStoreAccess(storeId);

  const [queue, summary] = await Promise.all([
    loadMerchantQueue(access.store.id),
    loadMerchantSummary(access.store.id),
  ]);

  // Dropoff area, for a kitchen deciding what to cook first. One query for the
  // page rather than one per card.
  const orderIds = queue.stages.flatMap((entry) => entry.orders.map((o) => o.order.id));
  const dropoffs = orderIds.length
    ? await prisma.orderAddress.findMany({
        where: { orderId: { in: orderIds }, role: 'DROPOFF' },
        select: { orderId: true, barangay: true, cityName: true },
      })
    : [];
  const areaByOrderId = new Map(
    dropoffs.map((row) => [row.orderId, row.barangay ?? row.cityName]),
  );

  /* Which of the people waiting are regulars. One lookup for the page — and it
     short-circuits to an empty map when no programme is running, which is
     every deployment until somebody creates one. */
  const liveOrders = queue.stages.flatMap((entry) => entry.orders);
  const tierByCustomer = await tierNamesForCustomers(
    liveOrders.map((entry) => entry.order.customerId),
  );
  const tierByOrderId = new Map(
    liveOrders.map((entry) => [
      entry.order.id,
      tierByCustomer.get(entry.order.customerId) ?? null,
    ]),
  );

  return (
    <main>
      {/* Somebody else may accept an order from another device; a stale queue
          is how two people cook the same thing. */}
      <OrderLiveRefresh isActive intervalMs={20_000} />

      <section aria-label="Today" className="grid grid-cols-3 gap-2 px-4 py-3">
        <Stat label="Done today" value={String(summary.completedToday)} />
        <Stat label="Cancelled" value={String(summary.cancelledToday)} />
        <Stat label="Sales" value={formatCentavos(summary.revenueTodayCentavos)} />
      </section>

      {!access.store.isOpen ? (
        <p className="mx-4 mb-2 rounded-xl bg-rose-50 px-3 py-2.5 text-xs text-rose-800">
          The store is closed. No new orders arrive until you open it.
        </p>
      ) : null}

      {queue.totalLive === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-ink-muted">
          No orders right now.
        </p>
      ) : (
        <div className="space-y-5 px-4 pb-8">
          {queue.stages
            .filter((entry) => entry.orders.length > 0)
            .map(({ stage, orders }) => (
              <section key={stage.key} aria-labelledby={`stage-${stage.key}`}>
                <h2
                  id={`stage-${stage.key}`}
                  className="flex items-baseline gap-2 text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
                >
                  {stage.title}
                  <span className="rounded-full bg-surface px-1.5 text-[11px] font-bold tabular-nums ring-1 ring-black/5">
                    {orders.length}
                  </span>
                </h2>
                <p className="mt-0.5 text-[11px] text-ink-faint">{stage.blurb}</p>

                <ul className="mt-2 space-y-2">
                  {orders.map((entry) => (
                    <OrderCard
                      key={entry.order.id}
                      isUrgent={stage.isUrgent}
                      order={toCardOrder(
                        entry,
                        areaByOrderId.get(entry.order.id) ?? null,
                        tierByOrderId.get(entry.order.id) ?? null,
                      )}
                    />
                  ))}
                </ul>
              </section>
            ))}
        </div>
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

/**
 * Flattens a queued order into what the card needs.
 *
 * The details container is read through `readFoodDetails`, which validates the
 * shape. A malformed payload yields an empty item list rather than taking the
 * whole queue down — one bad order must not stop a kitchen working.
 */
function toCardOrder(
  entry: Awaited<ReturnType<typeof loadMerchantQueue>>['stages'][number]['orders'][number],
  dropoffArea: string | null,
  customerTierName: string | null,
): QueueCardOrder {
  const { order } = entry;

  let items: QueueCardOrder['items'] = [];
  let merchantNotes: string | null = null;
  let includeCutlery = false;
  try {
    const details = readFoodDetails(order.serviceType, order.details);
    items = details.items;
    merchantNotes = details.merchantNotes ?? null;
    includeCutlery = details.includeCutlery;
  } catch {
    // Logged by the reader; the card degrades to its shared fields.
  }

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    subtotalCentavos: order.subtotalCentavos,
    waitingSeconds: entry.waitingSeconds,
    etaAt: order.etaAt?.toISOString() ?? null,
    merchantActions: entry.merchantActions,
    items,
    merchantNotes,
    includeCutlery,
    dropoffArea,
    customerTierName,
  };
}
