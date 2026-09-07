import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { getAllServices } from '@/lib/services/registry';
import { formatCentavos } from '@/lib/money';
import { AddToCartControls } from '@/components/cart/AddToCartControls';
import { RatingBadge } from '@/components/ui/RatingBadge';

export const dynamic = 'force-dynamic';

/**
 * A store and its catalogue.
 *
 * A store declares which verticals it serves via `serviceKeys`; this page shows
 * the ones that are actually live. The same route serves a MART store the day
 * that vertical activates.
 */
export default async function StorePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const [store, services] = await Promise.all([
    prisma.store.findUnique({
      where: { slug },
      include: {
        city: true,
        menuItems: {
          where: { isAvailable: true },
          orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
        },
      },
    }),
    getAllServices(),
  ]);

  if (!store || !store.isVisible) {
    notFound();
  }

  const liveServices = services.filter(
    (service) => service.isActive && store.serviceKeys.includes(service.key),
  );

  // No add buttons on a closed store or one whose services are not live here —
  // a cart nobody can check out with is a worse experience than no cart.
  const canOrder = store.isOpen && liveServices.length > 0;

  // Group the menu by its own category strings — data, not a fixed list.
  const byCategory = new Map<string, typeof store.menuItems>();
  for (const item of store.menuItems) {
    const existing = byCategory.get(item.category);
    if (existing) {
      existing.push(item);
    } else {
      byCategory.set(item.category, [item]);
    }
  }

  return (
    <main>
      <header className="bg-surface px-4 pb-4 pt-5">
        <Link href="/" className="text-xs font-semibold text-brand-700">
          ← Home
        </Link>
        <h1 className="mt-2 text-xl font-bold">{store.name}</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          <RatingBadge
            ratingAvg={store.ratingAvg}
            ratingCount={store.ratingCount}
            withCount
          />{' '}
          · {store.preparationMinutes} min prep · {store.city.name}
        </p>
        {store.description ? (
          <p className="mt-2 text-xs text-ink-muted">{store.description}</p>
        ) : null}
        {liveServices.length > 0 ? (
          <ul className="mt-2 flex gap-1.5">
            {liveServices.map((service) => (
              <li
                key={service.key}
                className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-800"
              >
                {service.displayName}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 rounded-lg bg-surface-sunken px-2 py-1.5 text-[11px] text-ink-muted">
            This store is not available in the app yet.
          </p>
        )}
        {!store.isOpen ? (
          <p className="mt-2 text-xs font-semibold text-rose-700">Closed right now</p>
        ) : null}
      </header>

      {Array.from(byCategory.entries()).map(([category, items]) => (
        <section key={category} aria-labelledby={`cat-${category}`} className="mt-4">
          <h2
            id={`cat-${category}`}
            className="px-4 text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
          >
            {category}
          </h2>
          <ul className="mt-2 divide-y divide-black/5">
            {items.map((item) => (
              <li
                key={item.id}
                id={`item-${item.id}`}
                className="flex items-start justify-between gap-3 bg-surface px-4 py-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.name}</span>
                  {item.description ? (
                    <span className="mt-0.5 block text-xs text-ink-muted">
                      {item.description}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1.5">
                  <span className="text-sm font-semibold tabular-nums">
                    {formatCentavos(item.priceCentavos)}
                  </span>
                  {canOrder ? (
                    <AddToCartControls
                      store={{ id: store.id, name: store.name, slug: store.slug }}
                      menuItemId={item.id}
                      itemName={item.name}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
