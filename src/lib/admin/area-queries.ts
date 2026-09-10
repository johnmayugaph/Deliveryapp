import { prisma } from '@/lib/prisma';
import {
  cityStanding,
  type CityStanding,
} from '@/lib/admin/service-areas';

/**
 * What the serving-area screen needs, in three queries.
 *
 * The interesting part is `standing`, which is NOT a column: a city is
 * orderable only when an active service names it AND something prices delivery
 * to it. Both halves live in different tables — `Service.availableCityIds` and
 * `DeliveryFeeRule` — so the screen would otherwise have to join them by eye,
 * which is how a console comes to show a green pill on a city where checkout
 * fails.
 */

export interface AreaCityRow {
  id: string;
  name: string;
  province: string;
  region: string;
  isActive: boolean;
  centroidLat: number | null;
  centroidLng: number | null;
  standing: CityStanding;
  /** Display names of active services launched here. */
  launchedServices: string[];
  /** Launched here but with nothing pricing delivery — the actionable gap. */
  unpricedServices: string[];
  addressCount: number;
  storeCount: number;
}

export interface AreaFeeRuleRow {
  id: string;
  serviceType: string;
  serviceName: string;
  /** Null for the fallback rule that covers every city. */
  cityId: string | null;
  cityName: string | null;
  baseFeeCentavos: number;
  perKilometreCentavos: number;
  includedMeters: number;
  minimumFeeCentavos: number;
  maximumFeeCentavos: number | null;
  freeAboveSubtotalCentavos: number | null;
  smallOrderThresholdCentavos: number | null;
  smallOrderFeeCentavos: number;
  serviceFeeCentavos: number;
  isActive: boolean;
}

export interface ServiceAreaOverview {
  cities: AreaCityRow[];
  rules: AreaFeeRuleRow[];
  services: { key: string; displayName: string; isActive: boolean }[];
  /** Service keys with no fallback rule — the hole a new city falls into. */
  servicesWithoutFallback: string[];
}

export async function serviceAreaOverview(): Promise<ServiceAreaOverview> {
  const [cities, services, rules, addressCounts, storeCounts] = await Promise.all([
    prisma.city.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
    prisma.service.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { key: true, displayName: true, isActive: true, availableCityIds: true },
    }),
    prisma.deliveryFeeRule.findMany({
      orderBy: [{ serviceType: 'asc' }, { cityId: 'asc' }],
      include: { service: { select: { displayName: true } } },
    }),
    prisma.address.groupBy({
      by: ['cityId'],
      where: { archivedAt: null },
      _count: { _all: true },
    }),
    prisma.store.groupBy({ by: ['cityId'], _count: { _all: true } }),
  ]);

  const addressesBy = new Map(addressCounts.map((row) => [row.cityId, row._count._all]));
  const storesBy = new Map(storeCounts.map((row) => [row.cityId, row._count._all]));

  /* A service is "priced" for a city when it has that city's own rule OR a
     fallback. `DeliveryFeeRule` says a city rule wins over the fallback, so
     for the question "can this be ordered at all" either is enough. */
  const activeRules = rules.filter((rule) => rule.isActive);
  const fallbackServices = new Set(
    activeRules.filter((rule) => rule.cityId === null).map((rule) => rule.serviceType),
  );
  const cityRules = new Set(
    activeRules
      .filter((rule) => rule.cityId !== null)
      .map((rule) => `${rule.serviceType}:${rule.cityId}`),
  );

  const cityRows: AreaCityRow[] = cities.map((city) => {
    const launched = services.filter(
      (service) => service.isActive && service.availableCityIds.includes(city.id),
    );
    const priced = launched.filter(
      (service) =>
        fallbackServices.has(service.key) ||
        cityRules.has(`${service.key}:${city.id}`),
    );

    return {
      id: city.id,
      name: city.name,
      province: city.province,
      region: city.region,
      isActive: city.isActive,
      centroidLat: city.centroidLat,
      centroidLng: city.centroidLng,
      standing: cityStanding({
        isActive: city.isActive,
        launchedServiceKeys: launched.map((service) => service.key),
        pricedServiceKeys: priced.map((service) => service.key),
      }),
      launchedServices: launched.map((service) => service.displayName),
      unpricedServices: launched
        .filter((service) => !priced.includes(service))
        .map((service) => service.displayName),
      addressCount: addressesBy.get(city.id) ?? 0,
      storeCount: storesBy.get(city.id) ?? 0,
    };
  });

  return {
    cities: cityRows,
    rules: rules.map((rule) => ({
      id: rule.id,
      serviceType: rule.serviceType,
      serviceName: rule.service.displayName,
      cityId: rule.cityId,
      cityName: rule.cityId
        ? cities.find((city) => city.id === rule.cityId)?.name ?? rule.cityId
        : null,
      baseFeeCentavos: rule.baseFeeCentavos,
      perKilometreCentavos: rule.perKilometreCentavos,
      includedMeters: rule.includedMeters,
      minimumFeeCentavos: rule.minimumFeeCentavos,
      maximumFeeCentavos: rule.maximumFeeCentavos,
      freeAboveSubtotalCentavos: rule.freeAboveSubtotalCentavos,
      smallOrderThresholdCentavos: rule.smallOrderThresholdCentavos,
      smallOrderFeeCentavos: rule.smallOrderFeeCentavos,
      serviceFeeCentavos: rule.serviceFeeCentavos,
      isActive: rule.isActive,
    })),
    services: services.map((service) => ({
      key: service.key,
      displayName: service.displayName,
      isActive: service.isActive,
    })),
    /* Only ACTIVE services are worth reporting: a coming-soon vertical with no
       fallback rule is not a gap, it is a vertical nobody can order from
       anyway. */
    servicesWithoutFallback: services
      .filter((service) => service.isActive && !fallbackServices.has(service.key))
      .map((service) => service.key),
  };
}
