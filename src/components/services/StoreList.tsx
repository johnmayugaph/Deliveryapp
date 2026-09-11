import Link from 'next/link';
import { formatCentavos } from '@/lib/money';
import { promoOfferLabel } from '@/lib/promo/policy';
import type { StoreRow } from '@/lib/services/service-page-data';
import { RatingBadge } from '@/components/ui/RatingBadge';

/**
 * The shop list: a logo on the left, the shop's facts on the right, and that
 * shop's live deals as chips underneath.
 *
 * The deal chips are the reason this row is taller than the old one. They come
 * from `PromoCode` rows scoped to a single shop, so every chip on this screen
 * is a code that exists and will be honoured at checkout — a discount
 * advertised on a list and refused at the till is the most expensive kind of
 * thing this screen can print.
 *
 * `<img>` rather than `next/image` for the logos, as everywhere else: they are
 * merchant uploads from their own origin.
 */
export function StoreList({
  rows,
  freeDeliveryAboveCentavos,
}: {
  rows: StoreRow[];
  /**
   * The free-delivery threshold from the city's fee rule, where it has one.
   * Shown per row because it is the term a customer is weighing while they
   * pick a shop, and it comes from the same rule checkout applies.
   */
  freeDeliveryAboveCentavos: number | null;
}) {
  return (
    /*
     * A divided column on a phone, a card grid from `lg`.
     *
     * The dividers go with the single column deliberately: a full-width rule
     * between two rows separates them, but the same rule drawn under two cards
     * sitting side by side reads as a line through the middle of the page.
     */
    <ul className="divide-y divide-ink/[0.06] lg:grid lg:grid-cols-2 lg:gap-4 lg:divide-y-0 lg:px-0 xl:grid-cols-3">
      {rows.map(({ store, deals }) => (
        <li key={store.id} className="bg-surface lg:rounded-2xl lg:shadow-tile lg:ring-1 lg:ring-ink/[0.06]">
          <Link href={`/stores/${store.slug}`} className="press block px-4 py-3.5">
            <span className="flex items-start gap-3">
              {store.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={store.logoUrl}
                  alt=""
                  width={128}
                  height={128}
                  loading="lazy"
                  decoding="async"
                  className={`h-16 w-16 shrink-0 rounded-2xl object-cover ring-1 ring-ink/[0.06] ${
                    store.isOpen ? '' : 'opacity-60 grayscale'
                  }`}
                />
              ) : (
                <span
                  aria-hidden
                  className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-brand-100 text-[22px] font-extrabold text-brand-800 ring-1 ring-ink/[0.06]"
                >
                  {store.name.slice(0, 1).toUpperCase()}
                </span>
              )}

              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15.5px] font-extrabold leading-tight">
                  {store.name}
                </span>

                <span className="mt-1 flex items-center gap-1.5 text-[12.5px] text-ink-muted">
                  <span className="font-bold text-ink">
                    <RatingBadge
                      ratingAvg={store.ratingAvg}
                      ratingCount={store.ratingCount}
                      withCount
                    />
                  </span>
                  {store.description ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="truncate">{store.description}</span>
                    </>
                  ) : null}
                </span>

                {/* Wraps rather than shrinks. A closed shop carries a third
                    term, and without `flex-wrap` the browser squeezed "From 15
                    mins" onto two lines and left its separator dot stranded
                    beside it. */}
                <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-ink-muted">
                  <span aria-hidden>⚡</span>
                  <span>From {store.preparationMinutes} mins</span>
                  {freeDeliveryAboveCentavos !== null ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>Free over {formatCentavos(freeDeliveryAboveCentavos)}</span>
                    </>
                  ) : null}
                  {store.isOpen ? null : (
                    <>
                      <span aria-hidden>·</span>
                      <span className="font-bold text-brand-700">Sarado</span>
                    </>
                  )}
                </span>
              </span>
            </span>

            {deals.length > 0 ? (
              /* The deals, as their own row rather than squeezed beside the
                 name. Two of them fit a phone; the shop's page carries the
                 rest. */
              <span className="mt-2.5 flex gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                {deals.map((deal) => (
                  <span
                    key={deal.id}
                    className="min-w-0 shrink-0 rounded-xl bg-sun-100 px-3 py-1.5 ring-1 ring-sun-400/40"
                  >
                    <span className="block text-[12.5px] font-extrabold leading-tight text-sun-700">
                      {promoOfferLabel(deal)}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-tight text-ink-muted">
                      {deal.minimumOrderCentavos > 0
                        ? `Min. spend ${formatCentavos(deal.minimumOrderCentavos)}`
                        : deal.label}
                    </span>
                  </span>
                ))}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
