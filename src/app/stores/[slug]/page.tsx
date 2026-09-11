import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { getAllServices } from '@/lib/services/registry';
import { groupByCategory } from '@/lib/merchant/menu-policy';
import { menuImageHref } from '@/lib/media/image-bytes';
import { formatCentavos } from '@/lib/money';
import { findDeliveryFeeRule } from '@/lib/pricing/delivery-fee';
import { AddToCartControls } from '@/components/cart/AddToCartControls';
import { RatingBadge } from '@/components/ui/RatingBadge';

export const dynamic = 'force-dynamic';

/** A section anchor that survives a category name with spaces or punctuation. */
function categoryId(category: string): string {
  return `cat-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
}

/**
 * A store and its catalogue.
 *
 * A store declares which verticals it serves via `serviceKeys`; this page shows
 * the ones that are actually live. The same route serves a MART store the day
 * that vertical activates.
 *
 * THE SHAPE IS THE ONE EVERY DELIVERY APP USES, and each part of it answers a
 * question a customer asks before they can order: what is this place (cover,
 * name), is it any good (rating), how long and how much (the delivery card),
 * and what is on the menu (tabs, then the menu itself). The old version
 * answered those in a paragraph of small grey text under the name.
 *
 * The delivery card is built from the SAME fee rule checkout will apply, not
 * from copy typed here — `findDeliveryFeeRule` is the function that decides
 * the real fee. A store page quoting a number the checkout then disagrees with
 * is the fastest way to lose somebody's trust in the middle of ordering.
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

  // The rule for this shop's first live vertical, so the card below quotes
  // what checkout will charge. Null when nothing is live here, which is the
  // same condition that hides the add buttons.
  const feeRule = liveServices[0]
    ? await findDeliveryFeeRule(liveServices[0].key, store.cityId)
    : null;

  // Grouped by the same rule the merchant screen uses, so what a shop arranges
  // is what a customer sees.
  const groups = groupByCategory(store.menuItems);

  return (
    <main className="pb-4">
      {/*
        * THE HERO. The cover where the shop has uploaded one; its own colour
        * block where it has not. Never a grey rectangle: on a new deployment
        * no shop has a cover, and an empty frame is what a launch would look
        * like.
        */}
      <div className="relative">
        {store.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={store.coverUrl}
            alt=""
            width={1200}
            height={600}
            className={`block h-48 w-full object-cover ${store.isOpen ? '' : 'opacity-70 grayscale'}`}
          />
        ) : (
          <div className="h-40 w-full bg-gradient-to-br from-brand-500 to-brand-700" />
        )}

        <Link
          href="/"
          aria-label="Back"
          className="absolute left-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-surface/95 text-base font-bold shadow-tile backdrop-blur"
        >
          <span aria-hidden>←</span>
        </Link>

        {/* The shop's own mark, straddling the edge of the cover — the device
            that makes a hero read as a shop's page rather than a banner. */}
        <div className="absolute inset-x-0 -bottom-8 flex justify-center">
          {store.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={store.logoUrl}
              alt=""
              width={128}
              height={128}
              className="h-16 w-16 rounded-2xl bg-surface object-cover shadow-lifted ring-4 ring-surface"
            />
          ) : (
            <span
              aria-hidden
              className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-2xl font-extrabold text-brand-700 shadow-lifted ring-4 ring-surface"
            >
              {store.name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
      </div>

      <header className="bg-surface px-4 pb-4 pt-11 text-center">
        <h1 className="text-[21px] font-extrabold tracking-tight">{store.name}</h1>
        <p className="mt-1 text-[13px] font-bold text-ink">
          <RatingBadge
            ratingAvg={store.ratingAvg}
            ratingCount={store.ratingCount}
            withCount
          />
        </p>
        {store.description ? (
          <p className="mt-1.5 text-[13px] text-ink-muted">{store.description}</p>
        ) : null}

        {liveServices.length > 0 ? (
          <ul className="mt-3 flex flex-wrap justify-center gap-1.5">
            {liveServices.map((service) => (
              <li
                key={service.key}
                className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand-800"
              >
                {service.displayName}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-xl bg-surface-sunken px-3 py-2 text-[12px] text-ink-muted">
            This store is not available in the app yet.
          </p>
        )}

        {!store.isOpen ? (
          <p className="mt-3 rounded-xl bg-brand-50 px-3 py-2 text-[13px] font-bold text-brand-800">
            Sarado right now — you can look, but not order.
          </p>
        ) : null}
      </header>

      {/*
        * THE DELIVERY CARD. Time from the shop's own quoted prep, money from
        * the fee rule checkout will use. The free-delivery and small-order
        * lines appear only when the rule sets them, because a card that lists
        * every possible term reads as fine print rather than as an answer.
        */}
      {feeRule ? (
        <div className="px-4">
          {/* A two-column grid, not a wrapping row. With four terms a wrapping
              row puts two on the first line and one on each of the next two at
              360px — the same four facts, read as three ragged rows. */}
          <dl className="card-warm grid grid-cols-2 gap-x-4 gap-y-3 p-3.5 text-left">
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">
                Delivery
              </dt>
              <dd className="mt-0.5 text-[14px] font-bold">
                from {store.preparationMinutes} min
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">
                Delivery fee
              </dt>
              <dd className="mt-0.5 text-[14px] font-bold tabular-nums">
                from {formatCentavos(feeRule.baseFeeCentavos)}
              </dd>
            </div>
            {feeRule.freeAboveSubtotalCentavos !== null ? (
              <div>
                <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">
                  Free delivery
                </dt>
                <dd className="mt-0.5 text-[14px] font-bold tabular-nums text-brand-700">
                  over {formatCentavos(feeRule.freeAboveSubtotalCentavos)}
                </dd>
              </div>
            ) : null}
            {feeRule.smallOrderThresholdCentavos !== null &&
            feeRule.smallOrderFeeCentavos > 0 ? (
              <div>
                <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">
                  Small order fee
                </dt>
                <dd className="mt-0.5 text-[14px] font-bold tabular-nums">
                  {formatCentavos(feeRule.smallOrderFeeCentavos)} under{' '}
                  {formatCentavos(feeRule.smallOrderThresholdCentavos)}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}

      {/*
        * SECTION TABS. Anchor links, not a client-side tab control: they work
        * before JavaScript arrives, they survive being shared as a URL, and
        * the browser's own smooth scrolling is better than anything worth
        * writing here. Sticky, because the point of them is reaching a section
        * from halfway down a long menu.
        */}
      {groups.length > 1 ? (
        <nav
          aria-label="Menu sections"
          className="sticky top-0 z-20 mt-4 border-b border-ink/[0.06] bg-surface/95 backdrop-blur"
        >
          <ul
            className="flex gap-1 overflow-x-auto px-4 py-2.5"
            style={{ scrollbarWidth: 'none' }}
          >
            {groups.map((group) => (
              <li key={group.category} className="shrink-0">
                <Link
                  href={`#${categoryId(group.category)}`}
                  className="block rounded-full bg-surface-sunken px-3.5 py-1.5 text-[13px] font-bold text-ink-muted hover:text-ink"
                >
                  {group.category}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {groups.map((group) => {
        /*
         * A section goes to the photo grid only when EVERY item in it has a
         * photograph. One missing photo in a two-column grid is a hole, and
         * the storefront's rule is already that a menu without photographs
         * reads as a plain list rather than a column of empty boxes. Shops
         * upload photos a section at a time, so this is the grain that
         * matches how the menu actually fills up.
         */
        const hasEveryPhoto = group.items.every((item) => item.image !== null);

        return (
          <section
            key={group.category}
            id={categoryId(group.category)}
            aria-labelledby={`heading-${categoryId(group.category)}`}
            className="mt-5 scroll-mt-14"
          >
            <h2
              id={`heading-${categoryId(group.category)}`}
              className="px-4 text-[19px] font-extrabold tracking-tight"
            >
              {group.category}
            </h2>

            {hasEveryPhoto ? (
              <ul className="mt-3 grid grid-cols-2 gap-3 px-4">
                {group.items.map((item) => (
                  <li
                    key={item.id}
                    id={`item-${item.id}`}
                    className="card-warm flex flex-col overflow-hidden"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={menuImageHref(item.image!.id)}
                      alt={item.name}
                      width={400}
                      height={400}
                      loading="lazy"
                      decoding="async"
                      className="block aspect-square w-full object-cover"
                    />
                    {/* A column with the control at its foot. Two cards in a
                        row are the same height whatever their names do, and
                        `mt-auto` is what puts their buttons on one line rather
                        than wherever each name stopped wrapping. */}
                    <div className="flex flex-1 flex-col p-3">
                      <p className="text-[13.5px] font-bold leading-tight">{item.name}</p>
                      <p className="mt-1 text-[13px] font-bold tabular-nums text-ink">
                        {item.optionGroups.length > 0 ? 'from ' : ''}
                        {formatCentavos(item.priceCentavos)}
                      </p>
                      {canOrder ? (
                        <div className="mt-auto pt-2">
                          <AddToCartControls
                            store={{ id: store.id, name: store.name, slug: store.slug }}
                            menuItemId={item.id}
                            itemName={item.name}
                            basePriceCentavos={item.priceCentavos}
                            groups={item.optionGroups.map((optionGroup) => ({
                              id: optionGroup.id,
                              name: optionGroup.name,
                              minChoices: optionGroup.minChoices,
                              maxChoices: optionGroup.maxChoices,
                              options: optionGroup.options.map((option) => ({
                                id: option.id,
                                name: option.name,
                                priceDeltaCentavos: option.priceDeltaCentavos,
                                isAvailable: option.isAvailable,
                              })),
                            }))}
                          />
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="mt-2 divide-y divide-ink/[0.06]">
                {group.items.map((item) => (
                  <li key={item.id} id={`item-${item.id}`} className="bg-surface px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      {/* Only where there is one. A menu with no photographs
                          should read as a plain list, not as a column of empty
                          boxes.

                          A plain `<img>` and not `next/image`, deliberately.
                          The file was already sized for this use when it was
                          uploaded (800px, ~80 KB) and is served with a
                          year-long immutable cache, so an optimizer would
                          re-encode it into a cache directory this container
                          does not have, by fetching our own route from our own
                          server while it is answering a request. It would also
                          make the storefront's photographs depend on `sharp`,
                          which is here as a transitive dependency of Next
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
                          className="shrink-0 rounded-xl object-cover ring-1 ring-ink/[0.06]"
                          style={{ height: '4.5rem', width: '4.5rem' }}
                        />
                      ) : null}

                      <span className="min-w-0 flex-1">
                        <span className="block text-[14.5px] font-bold leading-tight">
                          {item.name}
                        </span>
                        {item.description ? (
                          <span className="mt-1 block text-[12.5px] text-ink-muted">
                            {item.description}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1.5">
                        <span className="text-[14px] font-bold tabular-nums">
                          {formatCentavos(item.priceCentavos)}
                        </span>
                        {/* A dish that asks nothing keeps its control here,
                            beside the price, where it has always been. A dish
                            with choices puts it in the full-width row below: a
                            chooser squeezed into the price column leaves the
                            dish name wrapping to three lines on a 360px
                            phone. */}
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
                          groups={item.optionGroups.map((optionGroup) => ({
                            id: optionGroup.id,
                            name: optionGroup.name,
                            minChoices: optionGroup.minChoices,
                            maxChoices: optionGroup.maxChoices,
                            options: optionGroup.options.map((option) => ({
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
            )}
          </section>
        );
      })}
    </main>
  );
}
