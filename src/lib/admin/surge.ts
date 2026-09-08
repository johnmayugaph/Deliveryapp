import type { ServiceKey } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  firstDescendingStep,
  ladderFor,
  selectBand,
  type SurgeBandFacts,
  type SurgeCharge,
} from '@/lib/pricing/surge-policy';
import {
  measureMarket,
  ordersWaitingByCity,
  ridersAvailableByCity,
  marketKey,
  currentSurge,
} from '@/lib/pricing/surge';

/**
 * The console's view of the market.
 *
 * Two things an operator needs, and they are deliberately different queries.
 *
 * The LIVE picture — orders waiting, riders free, right now — answers "should
 * I be surging here?" and is measured on the spot, because a screen is allowed
 * to move and nobody is billed from it.
 *
 * The CHARGE — what a customer placing an order this second would actually pay
 * — comes from the newest snapshot, the same read a quote does. Showing the
 * live ratio next to the charge is the point: when they disagree, the reason is
 * always one of "the cron has stopped" or "the market just moved", and both are
 * things somebody needs to see.
 */

export interface CityMarket {
  serviceType: ServiceKey;
  cityId: string;
  cityName: string;
  /** Measured now, for the screen. */
  ordersWaiting: number;
  ridersAvailable: number;
  ratio: number;
  /** What a quote would add right now, from the snapshot. */
  charging: SurgeCharge;
  /** What the ladder says the live ratio has earned, snapshot aside. */
  wouldCharge: number;
  ladder: SurgeBandFacts[];
  /** A step below the one under it — a ladder that reads wrong. */
  misorderedStep: SurgeBandFacts | null;
}

/**
 * Every service and city an operator could care about — which is wider than
 * what the cron measures.
 *
 * The cron only snapshots where a ladder exists (a pair with no bands can never
 * surge, so a row for it would be a zero written every minute). But an operator
 * deciding WHERE to add bands needs to see the markets that have none, which is
 * why this expands from `Service.availableCityIds` rather than from the bands.
 */
export async function cityMarkets(now: Date = new Date()): Promise<CityMarket[]> {
  const [services, cities, bands, waiting, available] = await Promise.all([
    prisma.service.findMany({
      where: { isActive: true, requiresRider: true },
      select: { key: true, availableCityIds: true },
    }),
    prisma.city.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.surgeBand.findMany({ orderBy: { minOrdersPerRider: 'asc' } }),
    ordersWaitingByCity(),
    ridersAvailableByCity(),
  ]);

  const cityNames = new Map(cities.map((city) => [city.id, city.name]));
  const bandsByService = new Map<ServiceKey, SurgeBandFacts[]>();
  for (const band of bands) {
    const rows = bandsByService.get(band.serviceType) ?? [];
    rows.push(band);
    bandsByService.set(band.serviceType, rows);
  }

  const markets: CityMarket[] = [];
  for (const service of services) {
    for (const cityId of service.availableCityIds) {
      const cityName = cityNames.get(cityId);
      // A city switched off is not taking orders, so its market is not a
      // decision anybody has to make today.
      if (!cityName) continue;

      const key = marketKey(service.key, cityId);
      const ordersWaiting = waiting.get(key) ?? 0;
      const ridersAvailable = available.get(key) ?? 0;
      const ratio =
        ordersWaiting === 0
          ? 0
          : ridersAvailable === 0
            ? ordersWaiting
            : ordersWaiting / ridersAvailable;

      const ladder = ladderFor(bandsByService.get(service.key) ?? [], cityId);
      markets.push({
        serviceType: service.key,
        cityId,
        cityName,
        ordersWaiting,
        ridersAvailable,
        ratio,
        charging: await currentSurge(service.key, cityId, now),
        wouldCharge: selectBand(ladder, ratio)?.surgeCentavos ?? 0,
        ladder,
        misorderedStep: firstDescendingStep(ladder),
      });
    }
  }
  return markets;
}

/** Every step, for the editing table. Inactive ones included — they are edited. */
export async function allSurgeBands() {
  return prisma.surgeBand.findMany({
    include: { city: { select: { name: true } } },
    orderBy: [
      { serviceType: 'asc' },
      { cityId: 'asc' },
      { minOrdersPerRider: 'asc' },
    ],
  });
}

/**
 * The last few snapshots for a market, so a spike can be seen after the fact.
 *
 * The screen shows one number; a complaint two hours later is about a different
 * one. These rows are how "was it busy at 6pm?" gets answered.
 */
export async function recentSnapshots(
  serviceType: ServiceKey,
  cityId: string,
  take = 12,
) {
  return prisma.surgeSnapshot.findMany({
    where: { serviceType, cityId },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

/** For the cron-health line: when anything was last measured at all. */
export async function lastMeasuredAt(): Promise<Date | null> {
  const newest = await prisma.surgeSnapshot.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return newest?.createdAt ?? null;
}

export { measureMarket };
