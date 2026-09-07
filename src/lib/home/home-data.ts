import type { Order, Promotion, Service, Store } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getActiveServiceKeys, getServicesByIntentGroup, type ServiceGroup } from '@/lib/services/registry';
import { servicesAskedFor } from '@/lib/services/interest';
import { ALL_IN_PROGRESS_STATUSES } from '@/lib/orders/transitions';

/**
 * Everything the home screen needs, in one place.
 *
 * Every query here is service-agnostic: the active-order strip asks for
 * in-progress orders across all verticals, promotions are filtered by the
 * service keys they declare, and the tile grid comes straight from the
 * registry. None of it names a vertical.
 */

export interface ActiveOrderSummary {
  order: Order;
  service: Service;
}

export interface HomeData {
  serviceGroups: ServiceGroup[];
  activeOrders: ActiveOrderSummary[];
  promotions: Promotion[];
  recentStores: Store[];
  /** Null when the visitor has no saved address yet. */
  currentAddressLabel: string | null;
  currentCityName: string;
  /**
   * Coming-soon services this person has already asked for, here. Empty for a
   * visitor who is not signed in — there is nothing to look them up by, so
   * their tile remembers on their own device instead.
   */
  askedFor: string[];
}

export async function loadHomeData(input: {
  userId: string | null;
  cityId: string;
}): Promise<HomeData> {
  const [serviceGroups, activeServiceKeys, city] = await Promise.all([
    getServicesByIntentGroup({ cityId: input.cityId }),
    getActiveServiceKeys(),
    prisma.city.findUnique({ where: { id: input.cityId }, select: { name: true } }),
  ]);

  const [activeOrders, promotions, recentStores, askedFor, defaultAddress] = await Promise.all([
    loadActiveOrders(input.userId),
    loadPromotions(input.cityId, activeServiceKeys),
    loadRecentStores(input.userId, input.cityId, activeServiceKeys),
    input.userId
      ? servicesAskedFor({ userId: input.userId, cityId: input.cityId })
      : Promise.resolve(new Set<string>()),
    input.userId
      ? prisma.address.findFirst({
          where: { userId: input.userId, archivedAt: null },
          orderBy: [
            { isDefault: 'desc' },
            { lastUsedAt: { sort: 'desc', nulls: 'last' } },
            { usageCount: 'desc' },
          ],
        })
      : Promise.resolve(null),
  ]);

  return {
    serviceGroups,
    activeOrders,
    promotions,
    recentStores,
    currentAddressLabel: defaultAddress
      ? [defaultAddress.label, defaultAddress.line1].filter(Boolean).join(' · ')
      : null,
    currentCityName: city?.name ?? 'Manila',
    askedFor: [...askedFor],
  };
}

/**
 * In-progress orders across EVERY vertical. `ALL_IN_PROGRESS_STATUSES` is
 * derived from the lifecycle map, so a new vertical's states are included as
 * soon as its lifecycle is registered.
 */
async function loadActiveOrders(userId: string | null): Promise<ActiveOrderSummary[]> {
  if (!userId) {
    return [];
  }
  const orders = await prisma.order.findMany({
    where: {
      customerId: userId,
      status: { in: [...ALL_IN_PROGRESS_STATUSES] },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { service: true },
  });

  return orders.map(({ service, ...order }) => ({ order: order as Order, service }));
}

async function loadPromotions(
  cityId: string,
  activeServiceKeys: readonly string[],
): Promise<Promotion[]> {
  const now = new Date();
  const promotions = await prisma.promotion.findMany({
    where: {
      isActive: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        { OR: [{ cityIds: { isEmpty: true } }, { cityIds: { has: cityId } }] },
      ],
    },
    orderBy: { sortOrder: 'asc' },
    take: 8,
  });

  // Drop promos whose only services are not live yet — advertising a vertical
  // the customer cannot use is how a home screen loses trust.
  return promotions.filter(
    (promotion) =>
      promotion.serviceKeys.length === 0 ||
      promotion.serviceKeys.some((key) => activeServiceKeys.includes(key)),
  );
}

/**
 * Reorder shortcuts: stores this person has actually ordered from, newest
 * first, falling back to well-rated local stores for a first-time visitor.
 */
async function loadRecentStores(
  userId: string | null,
  cityId: string,
  activeServiceKeys: readonly string[],
): Promise<Store[]> {
  const keys = activeServiceKeys as never[];

  if (userId) {
    const recentOrders = await prisma.order.findMany({
      where: { customerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { details: true },
    });

    // `storeId` lives in the vertical-specific details container. Read it
    // defensively: not every vertical has one, and that is fine.
    const storeIds = Array.from(
      new Set(
        recentOrders.flatMap((order) => {
          const details = order.details;
          if (details === null || typeof details !== 'object') return [];
          const storeId = (details as Record<string, unknown>).storeId;
          return typeof storeId === 'string' ? [storeId] : [];
        }),
      ),
    ).slice(0, 6);

    if (storeIds.length > 0) {
      const stores = await prisma.store.findMany({
        where: { id: { in: storeIds }, isVisible: true },
      });
      // Preserve recency order, which findMany does not guarantee.
      const byId = new Map(stores.map((store) => [store.id, store]));
      const ordered = storeIds.flatMap((id) => {
        const store = byId.get(id);
        return store ? [store] : [];
      });
      if (ordered.length > 0) {
        return ordered;
      }
    }
  }

  return prisma.store.findMany({
    where: {
      isVisible: true,
      cityId,
      ...(keys.length > 0 ? { serviceKeys: { hasSome: keys } } : {}),
    },
    orderBy: [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }],
    take: 6,
  });
}
