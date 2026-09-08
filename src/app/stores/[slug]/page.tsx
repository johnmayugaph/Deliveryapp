import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { getAllServices } from '@/lib/services/registry';
import { groupByCategory } from '@/lib/merchant/menu-policy';
import { menuImageHref } from '@/lib/media/image-bytes';
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
          // The photo's id and shape only. `image: true` would read every
          // photograph's bytes to render a menu — see `MenuItemImage`.
          include: {
            image: { select: { id: true, width: true, height: true } },
            // The choices, in the shop's own order. Unavailable answers are
            // included rather than filtered: a customer should see that Large
            // exists and has run out, not wonder where it went.
            optionGroups: {
              orderBy: { sortOrder: 'asc' },
              include: { options: { orderBy: { sortOrder: 'asc' } } },
            },
          },
          // The shop's own order — `sortOrder` is a position in one list and a
          // section is a contiguous run in it (see `merchant/menu-policy.ts`).
          // Ordering by category first is what used to put "Add-ons" above
          // "Rice meals" on every menu.
          orderBy: [{ sortOrder: 'asc' }, { category: 'asc' }, { name: 'asc' }],
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

  // Grouped by the same rule the merchant screen uses, so what a shop arranges
  // is what a customer sees.
  const groups = groupByCategory(store.menuItems);

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

      {groups.map((group) => (
        <section
          key={group.category}
          aria-labelledby={`cat-${group.category}`}
          className="mt-4"
        >
          <h2
            id={`cat-${group.category}`}
            className="px-4 text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
          >
            {group.category}
          </h2>
          <ul className="mt-2 divide-y divide-black/5">
            {group.items.map((item) => (
              <li key={item.id} id={`item-${item.id}`} className="bg-surface px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                {/* Only where there is one. A menu with no photographs should
                    read as a plain list, not as a column of empty boxes.
                    
                    A plain `<img>` and not `next/image`, deliberately. The
                    file was already sized for this use when it was uploaded
                    (800px, ~80 KB) and is served with a year-long immutable
                    cache, so an optimizer would re-encode it into a cache
                    directory this container does not have, by fetching our own
                    route from our own server while it is answering a request.
                    It would also make the storefront's photographs depend on
                    `sharp`, which is here as a transitive dependency of Next
                    rather than one this project declares. */}
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={menuImageHref(item.image.id)}
                    alt={item.name}
                    width={72}
                    height={72}
                    loading="lazy"
                    decoding="async"
                    className="h-18 w-18 shrink-0 rounded-xl object-cover ring-1 ring-black/5"
                    style={{ height: '4.5rem', width: '4.5rem' }}
                  />
                ) : null}

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
                  {/* A dish that asks nothing keeps its control here, beside
                      the price, where it has always been. A dish with choices
                      puts it in the full-width row below: a chooser squeezed
                      into the price column leaves the dish name wrapping to
                      three lines on a 360px phone. */}
                  {canOrder && item.optionGroups.length === 0 ? (
                    <AddToCartControls
                      store={{ id: store.id, name: store.name, slug: store.slug }}
                      menuItemId={item.id}
                      itemName={item.name}
                      basePriceCentavos={item.priceCentavos}
                      groups={[]}
                    />
                  ) : null}
                </span>
                </div>

                {canOrder && item.optionGroups.length > 0 ? (
                  <div className="mt-2">
                    <AddToCartControls
                      store={{ id: store.id, name: store.name, slug: store.slug }}
                      menuItemId={item.id}
                      itemName={item.name}
                      basePriceCentavos={item.priceCentavos}
                      groups={item.optionGroups.map((group) => ({
                        id: group.id,
                        name: group.name,
                        minChoices: group.minChoices,
                        maxChoices: group.maxChoices,
                        options: group.options.map((option) => ({
                          id: option.id,
                          name: option.name,
                          priceDeltaCentavos: option.priceDeltaCentavos,
                          isAvailable: option.isAvailable,
                        })),
                      }))}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
