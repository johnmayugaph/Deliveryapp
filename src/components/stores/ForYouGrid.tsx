import type { MenuItemWithImage } from '@/lib/stores/store-page-data';
import { MenuItemCard, MenuItemRow } from '@/components/stores/MenuItemCard';

/**
 * "For You" — this customer's own dishes from this shop, or the shop's most
 * ordered when they have no history here.
 *
 * THE HEADING CHANGES WITH THE SOURCE, and that is the point. "For you" over a
 * list of the shop's bestsellers is a small lie that every delivery app tells;
 * a first-time visitor is being shown what other people order, and saying so
 * is both true and more persuasive than implying we know them already.
 *
 * The badge is a real count: `MOST_ORDERED_MIN_ORDERS` separate orders here
 * included this dish. It is not applied to somebody's personal list, where it
 * would be telling them their own habit back to them.
 */
export function ForYouGrid({
  items,
  isPersonal,
  mostOrderedIds,
  store,
  canOrder,
}: {
  items: MenuItemWithImage[];
  isPersonal: boolean;
  mostOrderedIds: ReadonlySet<string>;
  store: { id: string; name: string; slug: string };
  canOrder: boolean;
}) {
  if (items.length === 0) {
    // A shop nobody has ordered from yet. Nothing, rather than an empty band
    // announcing it — which is what a launch would look like on every page.
    return null;
  }

  return (
    <section aria-labelledby="for-you-heading" className="pt-5">
      <h2 id="for-you-heading" className="px-4 text-[19px] font-extrabold tracking-tight">
        {isPersonal ? 'Order again' : 'Most ordered here'}
      </h2>
      {/*
        * A grid only when EVERY dish here has a photograph — the same rule the
        * menu below follows, for the same reason. This band is ranked by
        * popularity, not by whether a shop has got round to photographing
        * things, so a mixed grid is the normal case rather than the edge one:
        * two pictures and two letter tiles side by side reads as two of them
        * failing to load.
        */}
      {items.every((item) => item.image !== null) ? (
        <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 px-4 lg:grid-cols-4 lg:gap-5 lg:px-0">
          {items.map((item) => (
            <li key={item.id}>
              <MenuItemCard
                item={item}
                store={store}
                canOrder={canOrder}
                badge={!isPersonal && mostOrderedIds.has(item.id) ? 'Most ordered' : null}
              />
            </li>
          ))}
        </ul>
      ) : (
        <ul
          className="mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1"
          style={{ scrollbarWidth: 'none' }}
        >
          {items.map((item) => (
            <li key={item.id} className="w-[13rem] shrink-0 snap-start">
              <MenuItemRow
                item={item}
                store={store}
                canOrder={canOrder}
                badge={!isPersonal && mostOrderedIds.has(item.id) ? 'Most ordered' : null}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
