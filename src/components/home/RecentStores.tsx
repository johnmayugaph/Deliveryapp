import Link from 'next/link';
import type { Store } from '@prisma/client';
import { RatingBadge } from '@/components/ui/RatingBadge';

/**
 * Recent stores / reorder shortcuts. Populated from the customer's own order
 * history where there is one, and from well-rated local stores where there is
 * not.
 *
 * TWO CARDS, DECIDED BY WHETHER THERE IS A PHOTOGRAPH. A shop that has
 * uploaded a cover gets the big photo-led card every delivery app uses,
 * because the photograph is the most useful thing on the row: it says what
 * kind of place this is faster than its name does. A shop that has not gets a
 * compact row instead.
 *
 * It would have been less code to render one card with a grey rectangle where
 * the photo goes. That is the mistake the menu list on the storefront already
 * refuses to make — "a menu with no photographs should read as a plain list,
 * not as a column of empty boxes" — and it matters more here, because on a new
 * deployment NO shop has a cover yet. The empty-frame version of this screen
 * is what a launch actually looks like, and it looks broken.
 *
 * `<img>` rather than `next/image`, following the storefront: the covers are
 * merchant uploads served straight from their own origin, and the optimizer
 * would re-encode them into a cache directory this container does not have.
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
    <section aria-labelledby="recent-heading" className="px-4 py-4">
      {/* Sentence case, and big. A delivery app's home screen is a stack of
          sections and the heading is the only thing separating them; a small
          uppercase eyebrow reads as a label on a form. */}
      <h2 id="recent-heading" className="text-[19px] font-extrabold tracking-tight">
        {hasOrderHistory ? 'Order again' : 'Popular near you'}
      </h2>
      <ul className="mt-3 space-y-3.5">
        {stores.map((store) => (
          <li key={store.id}>
            <Link
              href={`/stores/${store.slug}`}
              className="card-warm press block overflow-hidden"
            >
              {store.coverUrl ? (
                <span className="relative block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={store.coverUrl}
                    alt=""
                    width={800}
                    height={400}
                    loading="lazy"
                    decoding="async"
                    className={`block h-44 w-full object-cover ${
                      store.isOpen ? '' : 'opacity-60 grayscale'
                    }`}
                  />
                  {!store.isOpen ? (
                    <span className="absolute left-3 top-3 rounded-full bg-ink/85 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-surface">
                      Sarado
                    </span>
                  ) : null}
                </span>
              ) : null}

              <span className="flex items-center gap-3 p-3.5">
                {/* The compact card keeps a mark on the left. The shop's own
                    logo where it has one, and its initial where it does not —
                    an initial is at least the shop's, which a shop-front emoji
                    never was. */}
                {!store.coverUrl ? (
                  store.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={store.logoUrl}
                      alt=""
                      width={96}
                      height={96}
                      loading="lazy"
                      decoding="async"
                      className="h-12 w-12 shrink-0 rounded-2xl object-cover ring-1 ring-ink/[0.06]"
                    />
                  ) : (
                    <span
                      aria-hidden
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-100 text-[17px] font-extrabold text-brand-800 ring-1 ring-ink/[0.06]"
                    >
                      {store.name.slice(0, 1).toUpperCase()}
                    </span>
                  )
                ) : null}

                <span className="min-w-0 flex-1">
                  {/*
                    * Name and rating on one line, the way every delivery app
                    * sets a shop row: the name takes the space it needs and the
                    * rating is pinned right, so a column of cards has its
                    * ratings in a column too rather than wherever each name
                    * happened to end.
                    */}
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[15.5px] font-extrabold leading-tight">
                      {store.name}
                    </span>
                    <span className="shrink-0 text-[13px] font-bold text-ink">
                      <span aria-hidden className="text-sun-500">
                        ★
                      </span>{' '}
                      <RatingBadge
                        ratingAvg={store.ratingAvg}
                        ratingCount={store.ratingCount}
                        withCount
                      />
                    </span>
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[12.5px] text-ink-muted">
                    <span>From {store.preparationMinutes} min</span>
                    <span aria-hidden>·</span>
                    {/* The shop's own line about itself where it has one, and
                        its street where it does not. Never the city id, which
                        is what a first pass at this reached for — every row
                        would have said the same word, in lower case. */}
                    <span className="truncate">{store.description ?? store.addressLine}</span>
                    {store.isOpen ? null : (
                      <>
                        <span aria-hidden>·</span>
                        <span className="font-bold text-brand-700">Sarado</span>
                      </>
                    )}
                  </span>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
