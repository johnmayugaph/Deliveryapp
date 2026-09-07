import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { getCurrentUser } from '@/lib/auth/session';
import { StatusPill } from '@/components/ui/StatusPill';
import { serviceGlyph } from '@/lib/services/presentation';
import { summariseDetails } from '@/lib/orders/details';
import { formatCentavos } from '@/lib/money';
import { unratedOrders } from '@/lib/ratings/reviews';

export const dynamic = 'force-dynamic';

/**
 * Unified order history: EVERY order across EVERY service, in one chronological
 * list.
 *
 * This is the screen that makes the app feel like one product rather than
 * several sharing a login, and it is only possible because there is one `Order`
 * table. One query, no per-service branches, and a vertical that launches next
 * year appears here automatically.
 */
export default async function OrdersPage() {
  const user = await getCurrentUser();

  const orders = user
    ? await prisma.order.findMany({
        where: { customerId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { service: true },
      })
    : [];

  // Asked for once, here, rather than per row: the prompt is about the most
  // recent unrated delivery, and a badge on every historic order would be
  // nagging rather than a nudge. It empties itself when the window closes.
  const unrated = user ? await unratedOrders(user.id) : [];

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <h1 className="text-xl font-bold">Orders</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          Every order you have made — food, parcels, rides — in one list.
        </p>
      </header>

      {unrated.length > 0 ? (
        <section aria-labelledby="rate-heading" className="mx-4 mt-4">
          <Link
            href={`/orders/${unrated[0]!.id}`}
            className="flex items-center justify-between gap-3 rounded-xl bg-brand-50 px-4 py-3"
          >
            <span>
              <span id="rate-heading" className="block text-sm font-semibold">
                How was {unrated[0]!.orderNumber}?
              </span>
              <span className="block text-[11px] text-ink-muted">
                {unrated.length === 1
                  ? 'Rate it and help the next person choose.'
                  : `${unrated.length} orders waiting for a rating.`}
              </span>
            </span>
            <span aria-hidden className="text-lg leading-none text-amber-500">
              ★★★★★
            </span>
          </Link>
        </section>
      ) : null}

      {orders.length === 0 ? (
        <p className="px-4 py-8 text-sm text-ink-muted">
          No orders yet. Start with{' '}
          <Link href="/" className="font-semibold text-brand-700 underline">
            home
          </Link>
          .
        </p>
      ) : (
        <ul className="divide-y divide-black/5">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`/orders/${order.id}`}
                className="flex items-start gap-3 bg-surface px-4 py-3.5 transition-colors hover:bg-brand-50/40"
              >
                <span aria-hidden className="mt-0.5 text-xl leading-none">
                  {serviceGlyph(order.service.icon)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">
                      {order.service.displayName}
                    </span>
                    <StatusPill status={order.status} />
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-ink-muted">
                    {summariseDetails(order.details, `Order ${order.orderNumber}`)}
                  </span>
                  <span className="mt-1 block text-[11px] text-ink-faint">
                    {order.createdAt.toLocaleDateString('en-PH', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}{' '}
                    · {order.orderNumber}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {formatCentavos(order.totalCentavos)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
