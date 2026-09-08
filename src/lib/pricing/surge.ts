import { OrderStatus, type ServiceKey } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { ACTIVE_JOB_STATUSES } from '@/lib/fleet/job-policy';
import {
  ladderFor,
  surgeForMarket,
  surgeFromSnapshot,
  type SurgeBandFacts,
  type SurgeCharge,
} from '@/lib/pricing/surge-policy';

/**
 * Measuring the market, and writing down what was measured.
 *
 * The rule lives next door in `surge-policy.ts` with no database and no clock.
 * This is the half that counts rows: how many orders are waiting for a rider,
 * how many riders could take one, per service and per city.
 *
 * Two definitions are worth stating because they are choices, not facts.
 *
 * **An order's city is its PICKUP city.** Not the customer's, not the
 * dropoff's. A rider is drawn to a job by where the job STARTS, and the
 * delivery fee rule that surge is added to is already keyed on the store's city
 * (`place-order.ts` passes `store.cityId`). Grouping the queue any other way
 * would price a Manila pickup off Quezon City's ladder.
 *
 * **A rider's city is their HOME city.** Which is a compromise, and the
 * compromise dispatch already makes when it is given a city to filter on: a
 * rider's live coordinates say where they are this minute, but a rider between
 * jobs may be anywhere and a rider with no fix at all would vanish from the
 * count entirely — and a count that omits available riders overstates the
 * pressure and overcharges the customer. Home city is stable and errs towards
 * counting riders in, which errs towards charging less.
 */

/** Riders online, approved for the service, not suspended, not on a job. */
export interface MarketReading {
  serviceType: ServiceKey;
  cityId: string;
  ordersWaiting: number;
  ridersAvailable: number;
}

/**
 * How many orders are sitting in the dispatch queue, by service and pickup city.
 *
 * `AWAITING_RIDER_ASSIGNMENT` only. An order still with the merchant is not
 * competing for a rider yet, and an order already assigned has stopped
 * competing — counting either would inflate the ratio with orders no rider is
 * needed for.
 */
export async function ordersWaitingByCity(
  client?: PrismaTransactionClient,
): Promise<Map<string, number>> {
  const db = client ?? prisma;

  const rows = await db.order.findMany({
    where: { status: OrderStatus.AWAITING_RIDER_ASSIGNMENT },
    select: {
      serviceType: true,
      addresses: { where: { role: 'PICKUP' }, select: { cityId: true } },
    },
  });

  const waiting = new Map<string, number>();
  for (const row of rows) {
    const pickup = row.addresses[0];
    // An order with no pickup address cannot be attributed to a city, and
    // attributing it to a guess would raise a price in a city it is not in.
    if (!pickup) continue;
    const key = marketKey(row.serviceType, pickup.cityId);
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
  }
  return waiting;
}

/**
 * How many riders could take a job right now, by service and home city.
 *
 * "Could take one" excludes riders already carrying an order — the count that
 * matters is who is free, not who is logged in. A rider holding two orders
 * still counts once as unavailable, which is why this is a set of ids rather
 * than a subtraction.
 */
export async function ridersAvailableByCity(
  client?: PrismaTransactionClient,
): Promise<Map<string, number>> {
  const db = client ?? prisma;

  const [partners, busy] = await Promise.all([
    db.fleetPartner.findMany({
      where: { isOnline: true, isSuspended: false, homeCityId: { not: null } },
      select: { id: true, homeCityId: true, enabledServices: true },
    }),
    db.order.findMany({
      where: {
        status: { in: [...ACTIVE_JOB_STATUSES] },
        assignedRiderId: { not: null },
      },
      select: { assignedRiderId: true },
    }),
  ]);

  const onAJob = new Set(busy.map((order) => order.assignedRiderId));

  const available = new Map<string, number>();
  for (const partner of partners) {
    if (partner.homeCityId === null) continue;
    if (onAJob.has(partner.id)) continue;
    // A rider approved for three services counts as available in all three,
    // because they are: they will take whichever job reaches them first. It
    // does mean the same rider relieves pressure in more than one queue, which
    // is the optimistic reading — and the optimistic reading charges less.
    for (const service of partner.enabledServices) {
      const key = marketKey(service, partner.homeCityId);
      available.set(key, (available.get(key) ?? 0) + 1);
    }
  }
  return available;
}

/** `serviceType|cityId`, the key both counts are grouped under. */
export function marketKey(serviceType: ServiceKey, cityId: string): string {
  return `${serviceType}|${cityId}`;
}

/**
 * The service and city pairs the cron has any reason to measure.
 *
 * Only where a ladder exists. A pair with no bands can never surge, so a
 * snapshot for it would be a row written every minute to record a zero — and
 * deleting a city's bands would leave the cron measuring it forever. The
 * console reads the market LIVE instead (see `measureMarket`), which is what an
 * operator deciding where to add bands actually needs.
 *
 * A fallback ladder (`cityId: null`) expands to every city where the service is
 * live, from `Service.availableCityIds`. A service live nowhere expands to
 * nothing, which is the right answer for a coming-soon vertical.
 */
export async function pairsToMeasure(
  client?: PrismaTransactionClient,
): Promise<MarketPair[]> {
  const db = client ?? prisma;

  const [bands, services, cities] = await Promise.all([
    db.surgeBand.findMany({
      where: { isActive: true },
      select: { serviceType: true, cityId: true },
    }),
    db.service.findMany({ select: { key: true, availableCityIds: true } }),
    db.city.findMany({ where: { isActive: true }, select: { id: true } }),
  ]);

  const liveCities = new Set(cities.map((city) => city.id));
  const citiesByService = new Map(
    services.map((service) => [service.key, service.availableCityIds]),
  );

  const pairs = new Map<string, MarketPair>();
  for (const band of bands) {
    const inCities =
      band.cityId !== null
        ? [band.cityId]
        : (citiesByService.get(band.serviceType) ?? []);
    for (const cityId of inCities) {
      // A city switched off is not taking orders; measuring it writes rows
      // nobody will read.
      if (!liveCities.has(cityId)) continue;
      pairs.set(marketKey(band.serviceType, cityId), {
        serviceType: band.serviceType,
        cityId,
      });
    }
  }
  return [...pairs.values()];
}

export interface MarketPair {
  serviceType: ServiceKey;
  cityId: string;
}

/**
 * Reads the market right now, without writing anything.
 *
 * This is what the console shows. It deliberately does NOT price anything: a
 * screen refreshed twice showing two ratios is fine, whereas a quote refreshed
 * twice showing two prices is the thing this whole feature is arranged to
 * prevent.
 */
export async function measureMarket(
  pairs: readonly MarketPair[],
  client?: PrismaTransactionClient,
): Promise<MarketReading[]> {
  const [waiting, available] = await Promise.all([
    ordersWaitingByCity(client),
    ridersAvailableByCity(client),
  ]);

  return pairs.map((pair) => {
    const key = marketKey(pair.serviceType, pair.cityId);
    return {
      serviceType: pair.serviceType,
      cityId: pair.cityId,
      ordersWaiting: waiting.get(key) ?? 0,
      ridersAvailable: available.get(key) ?? 0,
    };
  });
}

export interface SnapshotPassResult {
  measured: number;
  surging: number;
}

/**
 * One cron pass: measure every configured pair and write a snapshot each.
 *
 * A row is written even when nothing surged. The zero rows are the record that
 * the market WAS looked at, which is the difference between "calm" and "the
 * cron stopped running" — and a quote cannot tell those apart from an absent
 * row, so it treats both as no surge and the operator needs to be able to.
 */
export async function recordSurgeSnapshots(
  client?: PrismaTransactionClient,
): Promise<SnapshotPassResult> {
  const db = client ?? prisma;

  const pairs = await pairsToMeasure(db);
  if (pairs.length === 0) return { measured: 0, surging: 0 };

  const [readings, bands] = await Promise.all([
    measureMarket(pairs, db),
    db.surgeBand.findMany({ where: { isActive: true } }),
  ]);

  const bandsByService = new Map<ServiceKey, SurgeBandFacts[]>();
  for (const band of bands) {
    const forService = bandsByService.get(band.serviceType) ?? [];
    forService.push(band);
    bandsByService.set(band.serviceType, forService);
  }

  const rows = readings.map((reading) => {
    const outcome = surgeForMarket({
      bands: bandsByService.get(reading.serviceType) ?? [],
      cityId: reading.cityId,
      ordersWaiting: reading.ordersWaiting,
      ridersAvailable: reading.ridersAvailable,
    });
    return {
      serviceType: reading.serviceType,
      cityId: reading.cityId,
      ordersWaiting: reading.ordersWaiting,
      ridersAvailable: reading.ridersAvailable,
      ratio: outcome.ratio,
      surgeCentavos: outcome.surgeCentavos,
      bandLabel: outcome.label,
    };
  });

  await db.surgeSnapshot.createMany({ data: rows });

  return {
    measured: rows.length,
    surging: rows.filter((row) => row.surgeCentavos > 0).length,
  };
}

/**
 * What a quote should add for a service in a city, from the newest snapshot.
 *
 * Reads, never measures. Every branch that is not "a fresh snapshot says
 * surge" comes back as ₱0 — see `surgeFromSnapshot`.
 */
export async function currentSurge(
  serviceType: ServiceKey,
  cityId: string,
  now: Date = new Date(),
  client?: PrismaTransactionClient,
): Promise<SurgeCharge> {
  const db = client ?? prisma;

  // Deliberately NOT filtered on freshness in SQL. An earlier version bounded
  // the query by `createdAt >= now - window`, which was fast and wrong: an
  // aged-out snapshot simply did not match, so the rule saw `null` and
  // answered NO_SNAPSHOT — "the market has not been measured yet" — for a
  // market that had been measured all day until the cron died. That is the one
  // failure the console exists to make visible, reported as its opposite, and
  // it made `surgeFromSnapshot`'s STALE branch unreachable in the only path
  // that calls it.
  //
  // The bound bought nothing anyway: `@@index([serviceType, cityId,
  // createdAt(sort: Desc)])` makes "newest row for this market" a single index
  // seek, whatever the table's size.
  const snapshot = await db.surgeSnapshot.findFirst({
    where: { serviceType, cityId },
    orderBy: { createdAt: 'desc' },
    select: { surgeCentavos: true, bandLabel: true, createdAt: true },
  });

  return surgeFromSnapshot(snapshot, now);
}

/**
 * The ladder in force for a service and city, for the console and for
 * explaining a charge.
 */
export async function activeLadder(
  serviceType: ServiceKey,
  cityId: string,
  client?: PrismaTransactionClient,
): Promise<SurgeBandFacts[]> {
  const db = client ?? prisma;
  const bands = await db.surgeBand.findMany({
    where: { serviceType, isActive: true, OR: [{ cityId }, { cityId: null }] },
  });
  return ladderFor(bands, cityId);
}
