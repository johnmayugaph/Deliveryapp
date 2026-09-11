import type { Promotion, PromoCode, ServiceKey, Store } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Everything a service's landing screen needs.
 *
 * Kept out of the page for the same reason `home-data.ts` is: the screen is a
 * list with filters on it, and a list with filters is where a query quietly
 * grows a fourth branch nobody can see from the JSX.
 *
 * Nothing here names a vertical. The categories are read from whatever the
 * shops in this city actually sell, the promotions from what each declares,
 * and the deals from the codes marketing has running — so MART's landing
 * screen is this same code the day a grocery signs up.
 */

/** One circle on the category rail. */
export interface CategoryTile {
  /** The category as the shops spell it — the value that filters the list. */
  name: string;
  /** How many shops here sell something in it. */
  storeCount: number;
  /**
   * A photograph from one of those items, where any of them has one. Real
   * merchant uploads rather than stock art: a rail of pictures nobody in this
   * city took is the kind of thing a customer notices exactly once.
   */
  imageId: string | null;
}

/** A store, with the things the row shows beside its name. */
export interface StoreRow {
  store: Store;
  /** Live codes for this shop, for the chips under the row. */
  deals: PromoCode[];
}

export interface ServicePageData {
  promotions: Promotion[];
  categories: CategoryTile[];
  rows: StoreRow[];
  /** Stores matching everything EXCEPT the filters, so "nothing matched" can
   *  tell the difference between a quiet city and a narrow filter. */
  totalInCity: number;
}

export type StoreSort = 'recommended' | 'rating' | 'fastest';

export interface ServicePageFilters {
  sort: StoreSort;
  /** Shops that are open right now. */
  openNow: boolean;
  /** Shops quoting 30 minutes or less. */
  fast: boolean;
  /** Shops with a live promo code. */
  deals: boolean;
  /** A menu category from the rail, or null for everything. */
  category: string | null;
}

export const DEFAULT_FILTERS: ServicePageFilters = {
  sort: 'recommended',
  openNow: false,
  fast: false,
  deals: false,
  category: null,
};

/** Thirty minutes, the threshold the `fast` chip promises. */
export const FAST_PREP_MINUTES = 30;

/**
 * Read the filters out of a URL.
 *
 * Every unknown value falls back to the default rather than erroring: these
 * arrive from a link somebody may have edited or kept in a bookmark since
 * before a chip existed, and a 500 on a stale bookmark is a worse answer than
 * an unfiltered list.
 */
export function parseFilters(
  params: Record<string, string | string[] | undefined>,
): ServicePageFilters {
  const one = (key: string): string | null => {
    const value = params[key];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };

  const sort = one('sort');
  const category = one('category');

  return {
    sort: sort === 'rating' || sort === 'fastest' ? sort : 'recommended',
    openNow: one('open') === '1',
    fast: one('fast') === '1',
    deals: one('deals') === '1',
    category: category !== null && category.trim() !== '' ? category : null,
  };
}

/** The filters back as a query string, for building the chip links. */
export function filtersToQuery(filters: ServicePageFilters): string {
  const params = new URLSearchParams();
  if (filters.sort !== 'recommended') params.set('sort', filters.sort);
  if (filters.openNow) params.set('open', '1');
  if (filters.fast) params.set('fast', '1');
  if (filters.deals) params.set('deals', '1');
  if (filters.category !== null) params.set('category', filters.category);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export async function loadServicePageData(input: {
  serviceKey: ServiceKey;
  cityId: string;
  activeServiceKeys: readonly string[];
  filters: ServicePageFilters;
}): Promise<ServicePageData> {
  const now = new Date();

  const [promotions, allStores] = await Promise.all([
    loadPromotions(input.serviceKey, input.cityId, now),
    prisma.store.findMany({
      where: {
        isVisible: true,
        cityId: input.cityId,
        serviceKeys: { has: input.serviceKey },
      },
      take: 120,
    }),
  ]);

  if (allStores.length === 0) {
    return { promotions, categories: [], rows: [], totalInCity: 0 };
  }

  const storeIds = allStores.map((store) => store.id);

  const [categories, dealsByStore, storeIdsByCategory] = await Promise.all([
    loadCategories(storeIds),
    loadDeals(storeIds, input.serviceKey, input.cityId, now),
    input.filters.category !== null
      ? storeIdsSelling(storeIds, input.filters.category)
      : Promise.resolve(null),
  ]);

  const filtered = allStores.filter((store) => {
    if (input.filters.openNow && !store.isOpen) return false;
    if (input.filters.fast && store.preparationMinutes > FAST_PREP_MINUTES) return false;
    if (input.filters.deals && (dealsByStore.get(store.id) ?? []).length === 0) return false;
    if (storeIdsByCategory !== null && !storeIdsByCategory.has(store.id)) return false;
    return true;
  });

  /*
   * Sorted in memory rather than by the database.
   *
   * The list is capped at 120 shops in one city, and `recommended` is a
   * two-key sort that puts an open shop above a closed one whatever its
   * rating — which is the ordering a customer wants and NOT the one
   * `orderBy: [{ isOpen: 'desc' }, ...]` produces once a category filter has
   * already removed rows. Doing it here keeps the three orderings in one
   * readable place instead of three query shapes.
   */
  const sorted = [...filtered].sort((a, b) => {
    if (input.filters.sort === 'fastest') {
      return (
        a.preparationMinutes - b.preparationMinutes ||
        Number(b.isOpen) - Number(a.isOpen) ||
        b.ratingAvg - a.ratingAvg
      );
    }
    if (input.filters.sort === 'rating') {
      return (
        b.ratingAvg - a.ratingAvg ||
        b.ratingCount - a.ratingCount ||
        Number(b.isOpen) - Number(a.isOpen)
      );
    }
    return (
      Number(b.isOpen) - Number(a.isOpen) ||
      b.ratingAvg - a.ratingAvg ||
      b.ratingCount - a.ratingCount
    );
  });

  return {
    promotions,
    categories,
    rows: sorted.map((store) => ({
      store,
      deals: dealsByStore.get(store.id) ?? [],
    })),
    totalInCity: allStores.length,
  };
}

/**
 * Promotions for THIS vertical.
 *
 * Stricter than the home screen's, deliberately: a promotion with no service
 * keys is house-wide and belongs on every landing screen, but one that names
 * three other verticals does not belong on this one just because it is live.
 */
async function loadPromotions(
  serviceKey: ServiceKey,
  cityId: string,
  now: Date,
): Promise<Promotion[]> {
  const promotions = await prisma.promotion.findMany({
    where: {
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        { OR: [{ cityIds: { isEmpty: true } }, { cityIds: { has: cityId } }] },
        { OR: [{ serviceKeys: { isEmpty: true } }, { serviceKeys: { has: serviceKey } }] },
      ],
    },
    orderBy: { sortOrder: 'asc' },
    take: 8,
  });
  return promotions;
}

/**
 * The category rail, derived from what the shops in this city actually sell.
 *
 * There is no cuisine column on `Store`, and this is the honest substitute
 * rather than a second place to type one: a merchant already names their menu
 * sections, and those names are the words their customers read. It also means
 * the rail cannot go stale — a shop that stops selling halo-halo drops out of
 * that circle on its next menu edit.
 *
 * Grouped case-insensitively, keeping the spelling the largest run uses, so
 * "Rice Meals" and "rice meals" are one circle rather than two.
 */
async function loadCategories(storeIds: string[]): Promise<CategoryTile[]> {
  const items = await prisma.menuItem.findMany({
    where: { storeId: { in: storeIds }, isAvailable: true },
    select: {
      category: true,
      storeId: true,
      image: { select: { id: true } },
    },
  });

  const byKey = new Map<
    string,
    { spellings: Map<string, number>; stores: Set<string>; imageId: string | null }
  >();

  for (const item of items) {
    const key = item.category.trim().toLowerCase();
    if (key === '') continue;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { spellings: new Map(), stores: new Set(), imageId: null };
      byKey.set(key, entry);
    }
    entry.spellings.set(item.category, (entry.spellings.get(item.category) ?? 0) + 1);
    entry.stores.add(item.storeId);
    if (entry.imageId === null && item.image !== null) {
      entry.imageId = item.image.id;
    }
  }

  return [...byKey.values()]
    .map((entry) => ({
      name: [...entry.spellings.entries()].sort((a, b) => b[1] - a[1])[0]![0],
      storeCount: entry.stores.size,
      imageId: entry.imageId,
    }))
    // Most-stocked first: the rail scrolls, and the first four circles are the
    // only ones most people will ever see.
    .sort((a, b) => b.storeCount - a.storeCount || a.name.localeCompare(b.name))
    .slice(0, 12);
}

/** Which of these shops sell something in a category, matched the same
 *  case-insensitive way the rail groups them. */
async function storeIdsSelling(
  storeIds: string[],
  category: string,
): Promise<Set<string>> {
  const items = await prisma.menuItem.findMany({
    where: {
      storeId: { in: storeIds },
      isAvailable: true,
      category: { equals: category, mode: 'insensitive' },
    },
    select: { storeId: true },
  });
  return new Set(items.map((item) => item.storeId));
}

/**
 * Live promo codes, per shop.
 *
 * Only codes scoped to one store: a house-wide code applies at every shop on
 * the list, so a chip for it under each row is the same sentence printed
 * twenty times. Those belong in the promotions rail at the top, which is
 * where marketing already puts them.
 */
async function loadDeals(
  storeIds: string[],
  serviceKey: ServiceKey,
  cityId: string,
  now: Date,
): Promise<Map<string, PromoCode[]>> {
  const codes = await prisma.promoCode.findMany({
    where: {
      isActive: true,
      storeId: { in: storeIds },
      startsAt: { lte: now },
      endsAt: { gte: now },
      AND: [
        { OR: [{ cityIds: { isEmpty: true } }, { cityIds: { has: cityId } }] },
        { OR: [{ serviceTypes: { isEmpty: true } }, { serviceTypes: { has: serviceKey } }] },
      ],
    },
    orderBy: { minimumOrderCentavos: 'asc' },
  });

  const byStore = new Map<string, PromoCode[]>();
  for (const code of codes) {
    if (code.storeId === null) continue;
    const list = byStore.get(code.storeId);
    // Two is the most a row can show without the shop's own name losing the
    // line. The rest are on the shop's page, where there is room for them.
    if (list) {
      if (list.length < 2) list.push(code);
    } else {
      byStore.set(code.storeId, [code]);
    }
  }
  return byStore;
}
