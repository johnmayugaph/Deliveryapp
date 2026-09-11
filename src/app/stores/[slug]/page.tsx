import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { getAllServices } from '@/lib/services/registry';
import { groupByCategory } from '@/lib/merchant/menu-policy';
import { menuImageHref } from '@/lib/media/image-bytes';
import { formatCentavos } from '@/lib/money';
import { findDeliveryFeeRule } from '@/lib/pricing/delivery-fee';
import { publicStoreReviews } from '@/lib/ratings/reviews';
import { AddToCartControls } from '@/components/cart/AddToCartControls';
import { RatingBadge } from '@/components/ui/RatingBadge';
import { DealRail } from '@/components/stores/DealRail';
import { ReviewRail } from '@/components/stores/ReviewRail';

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
 * name, branch), is it any good (rating, and what people said), what does it
 * cost to get here (the card), what is on offer (the deals), and what is on
 * the menu. The old version answered those in a paragraph of small grey text
 * under the name.
 *
 * The delivery terms come from the SAME fee rule checkout will apply, not from
 * copy typed here — `findDeliveryFeeRule` is the function that decides the real
 * fee. A store page quoting a number the checkout then disagrees with is the
 * fastest way to lose somebody's trust in the middle of ordering. The deals
 * come from the same `PromoCode` rows and the same label function the shop
 * list uses, for the same reason.
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

  const now = new Date();
  const [feeRule, reviews, deals] = await Promise.all([
    // The rule for this shop's first live vertical, so the card below quotes
    // what checkout will charge. Null when nothing is live here, which is the
    // same condition that hides the add buttons.
    liveServices[0]
      ? findDeliveryFeeRule(liveServices[0].key, store.cityId)
      : Promise.resolve(null),
    publicStoreReviews(store.id),
    prisma.promoCode.findMany({
      where: {
        isActive: true,
        storeId: store.id,
        startsAt: { lte: now },
        endsAt: { gte: now },
        OR: [{ cityIds: { isEmpty: true } }, { cityIds: { has: store.cityId } }],
      },
      orderBy: { minimumOrderCentavos: 'asc' },
      take: 6,
    }),
  ]);

  // Grouped by the same rule the merchant screen uses, so what a shop arranges
  // is what a customer sees.
  const groups = groupByCategory(store.menuItems);

  /** The card's one-line summary of getting this here. */
  const deliveryTerms = [
    `From ${store.preparationMinutes} mins`,
    feeRule ? `${formatCentavos(feeRule.baseFeeCentavos)} delivery` : null,
    feeRule?.freeAboveSubtotalCentavos != null
      ? `Free over ${formatCentavos(feeRule.freeAboveSubtotalCentavos)}`
      : null,
  ].filter((term): term is string => term !== null);

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
            className={`block h-44 w-full object-cover ${store.isOpen ? '' : 'opacity-70 grayscale'}`}
          />
        ) : (
          <div className="h-36 w-full bg-gradient-to-br from-brand-500 to-brand-700" />
        )}

        <Link
          href="/"
          aria-label="Back"
          className="absolute left-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-ink/45 text-base font-bold text-white backdrop-blur"
        >
          <span aria-hidden>←</span>
        </Link>
      </div>

      {/*
        * THE INFO CARD, overlapping the cover.
        *
        * One card rather than a centred name and a separate table of terms.
        * Everything a customer weighs before opening a menu is in it — who,
        * how good, how long, how much — and the overlap is what makes the
        * photograph read as this shop's rather than as a banner above it.
        */}
      <div className="relative -mt-8 px-4">
        <div className="card-warm flex items-start gap-3 p-3.5">
          {store.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={store.logoUrl}
              alt=""
              width={128}
              height={128}
              className="h-16 w-16 shrink-0 rounded-2xl object-cover ring-1 ring-ink/[0.06]"
            />
          ) : (
            <span
              aria-hidden
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-2xl font-extrabold text-brand-700 ring-1 ring-ink/[0.06]"
            >
              {store.name.slice(0, 1).toUpperCase()}
            </span>
          )}

          <div className="min-w-0 flex-1">
            <h1 className="text-[19px] font-extrabold leading-tight tracking-tight">
              {store.name}
            </h1>
            {/* The branch, the way the reference sets it: the shop's own
                street under its name, so two branches of one name are
                tellable apart before you have opened either. */}
            <p className="mt-0.5 truncate text-[12.5px] text-ink-muted">
              {store.addressLine}
            </p>
            <p className="mt-1 text-[13px] font-bold text-ink">
              <RatingBadge
                ratingAvg={store.ratingAvg}
                ratingCount={store.ratingCount}
                withCount
              />
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-ink-muted">
              {deliveryTerms.map((term, index) => (
                <span key={term} className="flex items-center gap-1.5">
                  {index > 0 ? <span aria-hidden>·</span> : null}
                  {term}
                </span>
              ))}
            </p>
          </div>
        </div>

        {feeRule?.smallOrderThresholdCentavos != null && feeRule.smallOrderFeeCentavos > 0 ? (
          /* The one term that is a surprise rather than a selling point, so it
             is said before the menu rather than discovered at the till. */
          <p className="mt-1.5 px-1 text-[11.5px] text-ink-faint">
            {formatCentavos(feeRule.smallOrderFeeCentavos)} small-order fee under{' '}
            {formatCentavos(feeRule.smallOrderThresholdCentavos)}.
          </p>
        ) : null}
      </div>

      <DealRail deals={deals} />

      {liveServices.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 px-4 pt-3">
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
        <p className="mx-4 mt-3 rounded-xl bg-surface-sunken px-3 py-2 text-[12px] text-ink-muted">
          This store is not available in the app yet.
        </p>
      )}

      {!store.isOpen ? (
        <p className="mx-4 mt-3 rounded-xl bg-brand-50 px-3 py-2 text-[13px] font-bold text-brand-800">
          Sarado right now — you can look, but not order.
        </p>
      ) : null}

      <div className="mt-4">
        <ReviewRail reviews={reviews} />
      </div>

      {/*
        * SECTION TABS. Anchor links, not a client-side tab control: they work
        * before JavaScript arrives, they survive being shared as a URL, and
        * the browser's own smooth scrolling is better than anything worth
        * writing here.
        *
        * CHIPS RATHER THAN THE REFERENCE'S DROPDOWN, deliberately. That app
        * has twenty sections on one menu and a dropdown is the only thing that
        * fits; a carinderia has three, and a select holding three options
        * costs a tap to open, a tap to choose, and the ability to see what the
        * choices are without doing either.
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
         * the rule below is already that a menu without photographs reads as
         * a plain list rather than a column of empty boxes. Shops upload
         * photos a section at a time, so this is the grain that matches how
         * the menu actually fills up.
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
              /*
               * THE GRID. The photograph is the card; the name and the price
               * sit under it on the page itself, and the + floats on the
               * picture's bottom corner.
               *
               * That is the reference's arrangement and it is not only
               * fashion: a white card around the text doubles every border on
               * a screen that is already a column of rectangles, and putting
               * the control ON the photo is what lets two columns of dishes
               * fit a phone without the button stealing a line from the name.
               */
              <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 px-4">
                {group.items.map((item) => (
                  <li key={item.id} id={`item-${item.id}`}>
                    <div className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={menuImageHref(item.image!.id)}
                        alt={item.name}
                        width={400}
                        height={400}
                        loading="lazy"
                        decoding="async"
                        className="block aspect-square w-full rounded-2xl object-cover ring-1 ring-ink/[0.06]"
                      />
                      {canOrder ? (
                        <div className="absolute bottom-2 right-2">
                          <AddToCartControls
                            variant="round"
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
                    <p className="mt-2 text-[13.5px] font-bold leading-tight">
                      {item.name}
                    </p>
                    <p className="mt-0.5 text-[13.5px] font-extrabold tabular-nums">
                      {item.optionGroups.length > 0 ? 'from ' : ''}
                      {formatCentavos(item.priceCentavos)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              /*
               * THE LIST. A photograph on the left where there is one, the
               * dish and its price in the middle, and the + on the right.
               *
               * Only where there is one: a menu with no photographs should
               * read as a plain list, not as a column of empty boxes.
               *
               * A plain `<img>` and not `next/image`, deliberately. The file
               * was already sized for this use when it was uploaded (800px,
               * ~80 KB) and is served with a year-long immutable cache, so an
               * optimizer would re-encode it into a cache directory this
               * container does not have, by fetching our own route from our
               * own server while it is answering a request. It would also make
               * the storefront's photographs depend on `sharp`, which is here
               * as a transitive dependency of Next rather than one this
               * project declares.
               */
              <ul className="mt-2 divide-y divide-ink/[0.06]">
                {group.items.map((item) => (
                  <li key={item.id} id={`item-${item.id}`} className="bg-surface px-4 py-3.5">
                    <div className="flex items-center gap-3">
                      {item.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={menuImageHref(item.image.id)}
                          alt={item.name}
                          width={112}
                          height={112}
                          loading="lazy"
                          decoding="async"
                          className="h-[4.5rem] w-[4.5rem] shrink-0 rounded-2xl object-cover ring-1 ring-ink/[0.06]"
                        />
                      ) : null}

                      <div className="min-w-0 flex-1">
                        <p className="text-[14.5px] font-bold leading-tight">{item.name}</p>
                        {item.description ? (
                          <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-ink-muted">
                            {item.description}
                          </p>
                        ) : null}
                        <p className="mt-1 text-[14px] font-extrabold tabular-nums">
                          {item.optionGroups.length > 0 ? 'from ' : ''}
                          {formatCentavos(item.priceCentavos)}
                        </p>
                      </div>

                      {canOrder ? (
                        <div className="shrink-0 self-end">
                          <AddToCartControls
                            variant="round"
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
            )}
          </section>
        );
      })}
    </main>
  );
}
