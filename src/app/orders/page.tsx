import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { requireScreen } from '@/lib/auth/access';
import { StatusPill } from '@/components/ui/StatusPill';
import { serviceGlyph } from '@/lib/services/presentation';
import { summariseDetails } from '@/lib/orders/details';
import { formatCentavos } from '@/lib/money';
import { unratedOrders } from '@/lib/ratings/reviews';
import { fetchCount, pageOf, readCursor } from '@/lib/pagination/pages';
import { OlderPager, StrandedPage } from '@/components/ui/OlderPager';
import { formatFullDayIn } from '@/lib/time/manila';

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
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /* Not a nullable read. This screen's empty state says "No orders yet", and
     with no user it said that to somebody whose session had ended rather than
     to somebody who had never ordered — the two are indistinguishable from
     here and only one of them is true. */
  const user = await requireScreen('orders');

  /* One page, newest first, walked backwards by the id of the last row shown.
     It used to be a bare `take: 50` with nothing said about the cap and no
     way past it, so a customer's own history became unreachable at order
     fifty-one.

     `createdAt` then `id`, because that is a total order — two orders placed
     in the same millisecond would otherwise straddle the page boundary
     unpredictably, showing one twice and the other never. */
  const cursor = readCursor((await searchParams).before);
  const fetched = await prisma.order.findMany({
    where: { customerId: user.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: fetchCount(),
    ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
    include: { service: true },
  });
  const { rows: orders, olderCursor, strandedPage } = pageOf(fetched, cursor);

  /* Asked for once, here, rather than per row: a badge on every historic
     order would be nagging rather than a nudge, and it empties itself when
     the rating window closes. First page only — the prompt is about the most
     recent unrated delivery, and a customer three pages into last year's
     orders is not being nudged about it. */
  const unrated = cursor === null ? await unratedOrders(user.id) : [];

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

      {strandedPage ? (
        /* Not the empty state. "No orders yet" is a claim about the customer;
           a cursor past the end of the list is a claim about the link. */
        <StrandedPage basePath="/orders" label="orders" />
      ) : orders.length === 0 ? (
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
                    {formatFullDayIn(order.createdAt)}{' '}
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

      {strandedPage ? null : (
        <OlderPager
          basePath="/orders"
          olderCursor={olderCursor}
          onFirstPage={cursor === null}
          label="orders"
        />
      )}
    </main>
  );
}
