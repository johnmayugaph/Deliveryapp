import { formatCentavos } from '@/lib/money';
import { menuImageHref } from '@/lib/media/image-bytes';
import { savingCentavos, type MenuItemWithImage } from '@/lib/stores/store-page-data';
import { AddToCartControls } from '@/components/cart/AddToCartControls';

/**
 * The option groups in the shape the cart control wants.
 *
 * Extracted because the same fifteen lines had appeared in four places by the
 * time the storefront had a grid, a list, an offer rail and a For You band —
 * and four copies of a mapping is four places to forget a field the day one is
 * added.
 */
export function toCartGroups(item: MenuItemWithImage) {
  return item.optionGroups.map((group) => ({
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
  }));
}

/**
 * A dish's price, with what it used to cost when it is on sale.
 *
 * The was-price is struck through and comes SECOND. Leading with it, as some
 * apps do, means the first number a customer reads is one they are not being
 * charged.
 */
export function MenuItemPrice({
  item,
  className = '',
}: {
  item: MenuItemWithImage;
  className?: string;
}) {
  const saving = savingCentavos(item);
  return (
    <p className={`tabular-nums ${className}`}>
      {/* `whitespace-nowrap` on the price itself: "from" and the figure are
          one fact, and in a narrow card the browser was happy to leave "from"
          alone on a line above it. The was-price may wrap to its own line — it
          is a second fact and reads fine underneath. */}
      <span className={`whitespace-nowrap ${saving === null ? '' : 'text-brand-700'}`}>
        {item.optionGroups.length > 0 ? 'from ' : ''}
        {formatCentavos(item.priceCentavos)}
      </span>
      {saving !== null ? (
        <span className="ml-1.5 font-normal text-ink-faint line-through">
          {formatCentavos(item.compareAtPriceCentavos!)}
        </span>
      ) : null}
    </p>
  );
}

/**
 * One dish as a photo card: the picture is the card, the name and price sit
 * under it on the page, and the + floats on the picture's corner.
 *
 * Used by the menu's photographed sections and by both merchandising bands,
 * so a dish looks the same wherever it is met.
 *
 * `<img>` rather than `next/image`: these are merchant uploads served from our
 * own route with a year-long immutable cache, and the optimizer would re-encode
 * them into a cache directory this container does not have.
 */
export function MenuItemCard({
  item,
  store,
  canOrder,
  badge,
}: {
  item: MenuItemWithImage;
  store: { id: string; name: string; slug: string };
  canOrder: boolean;
  /** "Most ordered", or a saving. Null for none. */
  badge?: string | null;
}) {
  return (
    <div>
      <div className="relative">
        {item.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={menuImageHref(item.image.id)}
            alt={item.name}
            width={400}
            height={400}
            loading="lazy"
            decoding="async"
            className="block aspect-square w-full rounded-2xl object-cover ring-1 ring-ink/[0.06]"
          />
        ) : (
          /* No photograph. A tinted square with the dish's initial rather than
             a grey box — the same rule the rest of the storefront follows,
             because on a new deployment nothing has a photo. */
          <div
            aria-hidden
            className="flex aspect-square w-full items-center justify-center rounded-2xl bg-brand-50 text-3xl font-extrabold text-brand-700 ring-1 ring-ink/[0.06]"
          >
            {item.name.slice(0, 1).toUpperCase()}
          </div>
        )}

        {badge ? (
          <span className="absolute left-2 top-2 rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-bold text-white shadow-tile">
            {badge}
          </span>
        ) : null}

        {canOrder ? (
          <div className="absolute bottom-2 right-2">
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

      <p className="mt-2 text-[13.5px] font-bold leading-tight">{item.name}</p>
      <MenuItemPrice item={item} className="mt-0.5 text-[13.5px] font-extrabold" />
    </div>
  );
}

/**
 * The same dish as a compact card with its photograph, or its initial, on the
 * left — for a band whose items are not all photographed.
 *
 * The mixed-grid problem is the reason this exists. A band ranked by
 * popularity gets whatever the shop sells most, photographed or not, and two
 * pictures beside two letter tiles reads as two images failing to load. A row
 * carries a letter tile without the same claim, because the picture is not the
 * card.
 */
export function MenuItemRow({
  item,
  store,
  canOrder,
  badge,
}: {
  item: MenuItemWithImage;
  store: { id: string; name: string; slug: string };
  canOrder: boolean;
  badge?: string | null;
}) {
  return (
    <div className="h-full rounded-2xl bg-surface p-3 shadow-tile ring-1 ring-ink/[0.06]">
      <div className="flex items-start gap-2.5">
        {item.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={menuImageHref(item.image.id)}
            alt={item.name}
            width={112}
            height={112}
            loading="lazy"
            decoding="async"
            className="h-12 w-12 shrink-0 rounded-xl object-cover ring-1 ring-ink/[0.06]"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-lg font-extrabold text-brand-700 ring-1 ring-ink/[0.06]"
          >
            {item.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {badge ? (
            <span className="mb-1 inline-block rounded-full bg-brand-50 px-2 py-0.5 text-[10.5px] font-bold text-brand-700">
              {badge}
            </span>
          ) : null}
          <p className="line-clamp-2 text-[13px] font-bold leading-tight">{item.name}</p>
          <MenuItemPrice item={item} className="mt-1 text-[13px] font-extrabold" />
        </div>
      </div>

      {canOrder ? (
        <div className="mt-2 flex justify-end">
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
  );
}
