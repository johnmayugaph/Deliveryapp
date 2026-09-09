import { cache } from 'react';
import { prisma } from '@/lib/prisma';
import { findDeliveryFeeRule } from '@/lib/pricing/delivery-fee';
import { getAllServices, isOrderableIn } from '@/lib/services/registry';
import {
  storefrontState,
  type StorefrontServiceFacts,
  type StorefrontState,
} from '@/lib/merchant/storefront-policy';

/**
 * Gathers what `storefront-policy.ts` needs to answer "can a customer order
 * from this shop right now".
 *
 * Every fact here is read from the same place the customer's own path reads
 * it: the store row, the registry, `findDeliveryFeeRule` and the availability
 * flag on the menu. Nothing is restated — a copy of any of these rules is a
 * copy that can tell a shop it is open for business when it is not.
 *
 * Cached per request, and keyed on the id rather than taking a `Store` row for
 * that reason: the merchant shell and the page inside it both want this, and
 * `requireStoreAccess` is not itself cached, so two different row objects for
 * the same store would have missed the cache and paid for every query twice on
 * every merchant screen.
 */
export const loadStorefront = cache(async function loadStorefront(
  storeId: string,
): Promise<StorefrontState> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  const [city, availableMenuItems, allServices] = await Promise.all([
    prisma.city.findUnique({
      where: { id: store.cityId },
      select: { name: true },
    }),
    prisma.menuItem.count({ where: { storeId: store.id, isAvailable: true } }),
    getAllServices(),
  ]);

  // Registry order, restricted to the keys this store is attached to. Reading
  // the registry rather than the enum is what makes a newly launched vertical
  // appear here without a deploy.
  const attached = allServices.filter((service) =>
    store.serviceKeys.includes(service.key),
  );

  const services: StorefrontServiceFacts[] = await Promise.all(
    attached.map(async (service) => {
      const liveInThisCity = isOrderableIn(service, store.cityId);
      // Only asked when it could matter. A service that has not launched here
      // has no reason to have pricing yet, and reporting its absence would be
      // a second, more confusing way of saying the same thing.
      const rule = liveInThisCity
        ? await findDeliveryFeeRule(service.key, store.cityId)
        : null;
      return {
        key: service.key,
        displayName: service.displayName,
        isActive: service.isActive,
        liveInThisCity,
        hasDeliveryPricing: rule !== null,
      };
    }),
  );

  return storefrontState({
    isVisible: store.isVisible,
    isOpen: store.isOpen,
    cityName: city?.name ?? 'your city',
    services,
    availableMenuItems,
  });
});
