import type { PromoCode } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
import { promoOfferLabel } from '@/lib/promo/policy';
import { menuImageHref } from '@/lib/media/image-bytes';
import { savingCentavos, type MenuItemWithImage } from '@/lib/stores/store-page-data';
import { AddToCartControls } from '@/components/cart/AddToCartControls';
import { toCartGroups } from '@/components/stores/MenuItemCard';

/**
 * "Today's Offer" — the shop's sale-priced dishes, in a rail.
 *
 * A wide card rather than the square one the grid uses: an offer is a sentence
 * ("this, normally that much, now this much") and it needs a line of text more
 * than the menu does.
 *
 * WHERE THE SALE PRICE COMES FROM: a merchant typed it into the "Was" box on
 * their own menu screen. Nothing here derives a discount, and nothing here is
 * read by checkout — `quoteCheckout` prices every line from `priceCentavos`,
 * which is why a wrong was-price can flatter a dish but cannot charge anybody
 * more than the menu says.
 *
 * WHEN NOTHING IS ON SALE the rail falls back to the shop's live promo codes,
 * because a shop running a code IS running an offer even though no single dish
 * is discounted. Two sources, one band, and the card shape says which is which:
 * a dish has a photograph and an add button, a code has neither.
 */
export function OfferRail({
  offers,
  codes,
  store,
  canOrder,
}: {
  offers: MenuItemWithImage[];
  codes: PromoCode[];
  store: { id: string; name: string; slug: string };
  canOrder: boolean;
}) {
  const showCodes = offers.length === 0;
  if (offers.length === 0 && codes.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="offer-heading" className="pt-4">
      <h2 id="offer-heading" className="px-4 text-[19px] font-extrabold tracking-tight">
        Today&rsquo;s offer
      </h2>

      <ul
        className="mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1"
        style={{ scrollbarWidth: 'none' }}
      >
        {showCodes
          ? codes.map((code) => (
              <li
                key={code.id}
                className="w-[15rem] shrink-0 snap-start rounded-2xl bg-sun-100 p-3.5 ring-1 ring-sun-400/40"
              >
                <p className="text-[15px] font-extrabold leading-tight text-sun-700">
                  {promoOfferLabel(code)}
                </p>
                <p className="mt-1 text-[12.5px] leading-snug text-ink-muted">
                  {code.label}
                </p>
                <p className="mt-2 text-[12px] font-bold">
                  Code {code.code}
                  {code.minimumOrderCentavos > 0
                    ? ` · min ${formatCentavos(code.minimumOrderCentavos)}`
                    : ''}
                </p>
              </li>
            ))
          : offers.map((item) => {
              const saving = savingCentavos(item);
              return (
                <li
                  key={item.id}
                  className="w-[19.5rem] shrink-0 snap-start rounded-2xl bg-surface p-3 shadow-tile ring-1 ring-ink/[0.06]"
                >
                  <div className="flex items-start gap-3">
                    {item.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={menuImageHref(item.image.id)}
                        alt={item.name}
                        width={160}
                        height={160}
                        loading="lazy"
                        decoding="async"
                        className="h-20 w-20 shrink-0 rounded-xl object-cover ring-1 ring-ink/[0.06]"
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-2xl font-extrabold text-brand-700 ring-1 ring-ink/[0.06]"
                      >
                        {item.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-bold leading-tight">
                        {item.name}
                      </p>
                      {item.description ? (
                        <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-muted">
                          {item.description}
                        </p>
                      ) : null}
                      {/* `whitespace-nowrap`: the "from" prefix and the two
                          figures are one fact, and a card narrow enough to
                          break them apart put "from" on a line of its own. */}
                      <p className="mt-1 whitespace-nowrap text-[14px] font-extrabold tabular-nums text-brand-700">
                        {item.optionGroups.length > 0 ? 'from ' : ''}
                        {formatCentavos(item.priceCentavos)}
                        <span className="ml-1.5 font-normal text-ink-faint line-through">
                          {formatCentavos(item.compareAtPriceCentavos!)}
                        </span>
                      </p>
                      {saving !== null ? (
                        <p className="mt-0.5 text-[11.5px] font-bold text-sun-700">
                          Save {formatCentavos(saving)}
                        </p>
                      ) : null}
                    </div>

                    {canOrder ? (
                      <div className="shrink-0 self-end">
                        <AddToCartControls
                          variant="round"
                          store={store}
                          menuItemId={item.id}
                          itemName={item.name}
                          basePriceCentavos={item.priceCentavos}
                          groups={toCartGroups(item)}
                        />
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
      </ul>
    </section>
  );
}
