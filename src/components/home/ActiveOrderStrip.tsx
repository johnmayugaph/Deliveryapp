import Link from 'next/link';
import type { ActiveOrderSummary } from '@/lib/home/home-data';
import { StatusPill } from '@/components/ui/StatusPill';
import { serviceGlyph } from '@/lib/services/presentation';
import { summariseDetails } from '@/lib/orders/details';

/**
 * The active-order strip: anything in progress, in any vertical, with a
 * tap-through to tracking.
 *
 * The summary line comes from `summariseDetails`, which reads the details
 * container generically. A parcel in progress renders here the day PARCEL
 * launches, with no change to this component.
 */
export function ActiveOrderStrip({ orders }: { orders: ActiveOrderSummary[] }) {
  if (orders.length === 0) {
    return null;
  }

  return (
    <section aria-label="Orders in progress" className="px-4 pb-1">
      <ul className="space-y-2">
        {orders.map(({ order, service }) => (
          <li key={order.id}>
            <Link
              href={`/orders/${order.id}`}
              className="flex items-center gap-3 rounded-xl bg-surface p-3 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-brand-50/40"
            >
              <span aria-hidden className="text-xl leading-none">
                {serviceGlyph(service.icon)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    {service.displayName}
                  </span>
                  <StatusPill status={order.status} />
                </span>
                <span className="mt-0.5 block truncate text-xs text-ink-muted">
                  {summariseDetails(order.details, `Order ${order.orderNumber}`)}
                </span>
              </span>
              <span aria-hidden className="text-xs text-ink-faint">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
