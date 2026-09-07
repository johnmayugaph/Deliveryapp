import Link from 'next/link';
import type { Store } from '@prisma/client';
import { RatingBadge } from '@/components/ui/RatingBadge';

/**
 * Recent stores / reorder shortcuts. Populated from the customer's own order
 * history where there is one, and from well-rated local stores where there is
 * not.
 */
export function RecentStores({
  stores,
  hasOrderHistory,
}: {
  stores: Store[];
  hasOrderHistory: boolean;
}) {
  if (stores.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="recent-heading" className="px-4 py-3">
      <h2
        id="recent-heading"
        className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
      >
        {hasOrderHistory ? 'Order again' : 'Popular near you'}
      </h2>
      <ul className="mt-2.5 space-y-2">
        {stores.map((store) => (
          <li key={store.id}>
            <Link
              href={`/stores/${store.slug}`}
              className="flex items-center gap-3 rounded-xl bg-surface p-3 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-brand-50/40"
            >
              <span
                aria-hidden
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-lg"
              >
                🏪
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{store.name}</span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  <RatingBadge
                    ratingAvg={store.ratingAvg}
                    ratingCount={store.ratingCount}
                  />{' '}
                  · {store.preparationMinutes} min prep
                  {store.isOpen ? '' : ' · Sarado'}
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
