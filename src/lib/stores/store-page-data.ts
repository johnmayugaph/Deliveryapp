import type { MenuItem, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * The three merchandising bands on a store page: today's offer, for you, and
 * the promotion banner's companions.
 *
 * Kept out of the page because all three are COUNTS over order history, and a
 * count written inline in JSX is a count nobody revisits when it gets slow.
 *
 * None of it invents anything. A dish is "on sale" because a merchant typed a
 * was-price into their own menu screen; a dish is "most ordered" because it
 * appears in more completed orders than the others; and "for you" is the
 * customer's own history at this shop before it is anybody's idea of a
 * recommendation.
 */

/** A dish plus the photo id the storefront needs, and nothing else. */
export type MenuItemWithImage = MenuItem & {
  image: { id: string; width: number; height: number } | null;
  optionGroups: {
    id: string;
    name: string;
    minChoices: number;
    maxChoices: number;
    options: {
      id: string;
      name: string;
      priceDeltaCentavos: number;
      isAvailable: boolean;
    }[];
  }[];
};

export interface StoreMerchandising {
  /** Dishes with a was-price, cheapest saving last. Empty when none are on sale. */
  offers: MenuItemWithImage[];
  /**
   * What to put under "For You": this customer's own past dishes here, or the
   * shop's most-ordered when they have no history (or no account).
   */
  forYou: MenuItemWithImage[];
  /** True when `forYou` is this person's own history rather than the shop's. */
  forYouIsPersonal: boolean;
  /** Item ids ordered often enough here to wear the badge. */
  mostOrderedIds: ReadonlySet<string>;
}

/**
 * How many of the shop's recent orders a dish must appear in to be called
 * "most ordered".
 *
 * Two, not one. On a shop with three orders in its history, a threshold of one
 * puts the badge on everything anybody has ever bought — which is a label that
 * means "we have sold this once" while looking like a recommendation.
 */
export const MOST_ORDERED_MIN_ORDERS = 2;

/** How many orders back to count. Recent enough to be about this menu. */
const HISTORY_DEPTH = 200;

export async function loadStoreMerchandising(input: {
  storeId: string;
  userId: string | null;
  items: MenuItemWithImage[];
}): Promise<StoreMerchandising> {
  const byId = new Map(input.items.map((item) => [item.id, item]));

  const offers = input.items
    .filter((item) => item.compareAtPriceCentavos !== null)
    // Biggest saving first: a rail is read left to right and stops being read
    // quite quickly.
    .sort(
      (a, b) =>
        b.compareAtPriceCentavos! - b.priceCentavos -
        (a.compareAtPriceCentavos! - a.priceCentavos),
    );

  const [storeCounts, mine] = await Promise.all([
    countItems(await ordersForStore(input.storeId, null)),
    input.userId === null
      ? Promise.resolve(new Map<string, number>())
      : countItems(await ordersForStore(input.storeId, input.userId)),
  ]);

  const mostOrderedIds = new Set(
    [...storeCounts.entries()]
      .filter(([id, count]) => count >= MOST_ORDERED_MIN_ORDERS && byId.has(id))
      .map(([id]) => id),
  );

  const rank = (counts: Map<string, number>) =>
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .flatMap(([id]) => {
        const item = byId.get(id);
        return item ? [item] : [];
      })
      .slice(0, 6);

  const personal = rank(mine);

  return {
    offers,
    forYou: personal.length > 0 ? personal : rank(storeCounts),
    forYouIsPersonal: personal.length > 0,
    mostOrderedIds,
  };
}

/**
 * The order details for one shop, optionally for one customer.
 *
 * `storeId` lives inside the vertical's own details container rather than in a
 * column, so this filters in SQL on the JSON path and reads only `details` —
 * see `orders/details.ts`. Doing it in SQL rather than reading every order and
 * filtering in memory is what keeps a popular shop's page from loading the
 * whole order table.
 */
async function ordersForStore(
  storeId: string,
  userId: string | null,
): Promise<Prisma.JsonValue[]> {
  const rows = await prisma.order.findMany({
    where: {
      details: { path: ['storeId'], equals: storeId },
      ...(userId === null ? {} : { customerId: userId }),
    },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_DEPTH,
    select: { details: true },
  });
  return rows.map((row) => row.details);
}

/**
 * How many ORDERS each dish appears in — not how many portions were sold.
 *
 * Counting portions would let one party tray of forty drinks decide what a
 * shop is known for. What the badge is claiming is that a lot of different
 * orders included this, which is a claim about popularity rather than volume.
 */
function countItems(detailRows: Prisma.JsonValue[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const details of detailRows) {
    if (details === null || typeof details !== 'object' || Array.isArray(details)) continue;
    const items = (details as Record<string, unknown>).items;
    if (!Array.isArray(items)) continue;

    const seen = new Set<string>();
    for (const entry of items) {
      if (entry === null || typeof entry !== 'object') continue;
      const menuItemId = (entry as Record<string, unknown>).menuItemId;
      if (typeof menuItemId !== 'string' || menuItemId === '') continue;
      seen.add(menuItemId);
    }
    for (const id of seen) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** What this dish saves, in centavos, or null when it is not on sale. */
export function savingCentavos(
  item: Pick<MenuItem, 'priceCentavos' | 'compareAtPriceCentavos'>,
): number | null {
  if (item.compareAtPriceCentavos === null) return null;
  const saving = item.compareAtPriceCentavos - item.priceCentavos;
  // The database CHECK makes this positive, so a zero or negative here means
  // the row came from somewhere that bypassed it. Showing "save ₱0.00" would
  // be worse than showing nothing.
  return saving > 0 ? saving : null;
}
