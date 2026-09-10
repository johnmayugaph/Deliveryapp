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
      <h2 id="recent-heading" className="eyebrow">
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
                    className={`block h-40 w-full object-cover ${
                      store.isOpen ? '' : 'opacity-60 grayscale'
                    }`}
                  />
                  {/*
                    * The rating rides on the photograph, which is where the
                    * eye already is. White pill rather than the green every
                    * competitor uses: green is a status colour everywhere else
                    * in this application, and a rating is not a status.
                    */}
                  <span className="absolute right-3 top-3 rounded-full bg-surface/95 px-2.5 py-1 text-[12px] font-bold text-ink shadow-tile">
                    <RatingBadge
                      ratingAvg={store.ratingAvg}
                      ratingCount={store.ratingCount}
                    />
                  </span>
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
                  <span className="block truncate text-[15px] font-bold leading-tight">
                    {store.name}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-muted">
                    {/* On a photo card the rating is already on the image, so
                        the meta line does not repeat it. */}
                    {store.coverUrl ? null : (
                      <>
                        <span className="font-semibold text-ink">
                          <RatingBadge
                            ratingAvg={store.ratingAvg}
                            ratingCount={store.ratingCount}
                          />
                        </span>
                        <span aria-hidden>·</span>
                      </>
                    )}
                    <span>{store.preparationMinutes} min prep</span>
                    {store.isOpen || store.coverUrl ? null : (
                      <>
                        <span aria-hidden>·</span>
                        <span className="font-semibold text-ink">Sarado</span>
                      </>
                    )}
                  </span>
                </span>

                <span aria-hidden className="text-sm font-bold text-brand-700">
                  →
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
