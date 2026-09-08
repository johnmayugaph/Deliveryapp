import type { ServiceKey } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { menuImageHref } from '@/lib/media/image-bytes';
import { getActiveServices, getMerchantBackedServiceKeys } from '@/lib/services/registry';

/**
 * Cross-service search.
 *
 * Searches across ACTIVE services only — there is nothing to find in a vertical
 * that has not launched, and offering results we cannot fulfil is worse than
 * offering none. Which services have a searchable catalogue is read from the
 * registry (`requiresMerchant`), so MART becomes searchable the moment it is
 * activated, with no change here.
 */

export interface SearchResult {
  kind: 'STORE' | 'MENU_ITEM';
  serviceType: ServiceKey;
  title: string;
  subtitle: string;
  href: string;
  imageUrl: string | null;
}

export interface GlobalSearchOptions {
  query: string;
  cityId: string;
  limit?: number;
}

export async function globalSearch(options: GlobalSearchOptions): Promise<SearchResult[]> {
  const query = options.query.trim();
  if (query.length < 2) {
    return [];
  }

  const limit = options.limit ?? 20;
  const activeServices = await getActiveServices();
  const searchableKeys = await getMerchantBackedServiceKeys();

  if (searchableKeys.length === 0) {
    return [];
  }

  // Only keys that are both active AND live in this city.
  const keysInCity = activeServices
    .filter(
      (service) =>
        searchableKeys.includes(service.key) &&
        service.availableCityIds.includes(options.cityId),
    )
    .map((service) => service.key);

  if (keysInCity.length === 0) {
    return [];
  }

  const [stores, menuItems] = await Promise.all([
    prisma.store.findMany({
      where: {
        isVisible: true,
        cityId: options.cityId,
        serviceKeys: { hasSome: keysInCity },
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }],
    }),
    prisma.menuItem.findMany({
      where: {
        isAvailable: true,
        name: { contains: query, mode: 'insensitive' },
        store: {
          isVisible: true,
          cityId: options.cityId,
          serviceKeys: { hasSome: keysInCity },
        },
      },
      take: limit,
      include: {
        store: { select: { name: true, slug: true, serviceKeys: true } },
        // The id and nothing else — never `image: true`, which would read
        // every photograph's bytes out of the database to render a list of
        // search results.
        image: { select: { id: true } },
      },
    }),
  ]);

  const results: SearchResult[] = [];

  for (const store of stores) {
    // A store may serve several verticals; attribute the result to the first
    // one that is actually live here.
    const serviceType = store.serviceKeys.find((key) => keysInCity.includes(key));
    if (!serviceType) continue;
    results.push({
      kind: 'STORE',
      serviceType,
      title: store.name,
      subtitle: store.description ?? 'Store',
      href: `/stores/${store.slug}`,
      imageUrl: store.logoUrl,
    });
  }

  for (const item of menuItems) {
    const serviceType = item.store.serviceKeys.find((key) => keysInCity.includes(key));
    if (!serviceType) continue;
    results.push({
      kind: 'MENU_ITEM',
      serviceType,
      title: item.name,
      subtitle: item.store.name,
      href: `/stores/${item.store.slug}#item-${item.id}`,
      imageUrl: item.image ? menuImageHref(item.image.id) : null,
    });
  }

  return results.slice(0, limit);
}
