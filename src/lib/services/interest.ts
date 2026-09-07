import type { ServiceKey } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getService, isOrderableIn, UnknownServiceError } from '@/lib/services/registry';

/**
 * Demand for the verticals that do not exist yet.
 *
 * Four of the five tiles on the home screen are dimmed, and the decision about
 * which to build next is currently a guess. A tap on a dimmed tile is the
 * cheapest evidence available, and this is the only place the product collects
 * any: what was asked for, where, and by how many people.
 *
 * Everything here reads the registry. There is no list of services in this
 * file and no branch on which one was tapped — a sixth vertical is measurable
 * the moment its row exists.
 */

export class ServiceAlreadyLiveError extends Error {
  constructor(readonly key: ServiceKey) {
    super('That service is already available here, so there is nothing to wait for.');
    this.name = 'ServiceAlreadyLiveError';
  }
}

export class UnknownCityError extends Error {
  constructor(readonly cityId: string) {
    super(`No city is registered under the id "${cityId}"`);
    this.name = 'UnknownCityError';
  }
}

export interface RecordInterestInput {
  serviceKey: ServiceKey;
  cityId: string;
  /** Null for a visitor who has not signed in. They still count. */
  userId?: string | null;
  now?: Date;
}

export interface InterestTally {
  /** Distinct accounts that asked. The number worth trusting. */
  accounts: number;
  /** Taps from people who were not signed in. Cannot be deduped per person. */
  anonymous: number;
}

export interface RecordInterestResult {
  tally: InterestTally;
  /** False when this person had already asked, and this was a repeat. */
  firstTime: boolean;
}

/**
 * Records that somebody wants a service here.
 *
 * Refuses two things, both of which are reachable by posting to the action
 * directly rather than by tapping the tile:
 *
 *  - an unregistered service key, and
 *  - a service that IS orderable in this city, because a waiting list for
 *    something already on sale would be counted as unmet demand forever.
 *
 * A repeat from the same account is an increment, not a new row, so the tally
 * answers "how many people" rather than "how many taps".
 */
export async function recordServiceInterest(
  input: RecordInterestInput,
): Promise<RecordInterestResult> {
  const now = input.now ?? new Date();
  // Throws UnknownServiceError for a key that is not in the registry.
  const service = await getService(input.serviceKey);

  if (isOrderableIn(service, input.cityId)) {
    throw new ServiceAlreadyLiveError(service.key);
  }

  const city = await prisma.city.findUnique({
    where: { id: input.cityId },
    select: { id: true },
  });
  if (!city) {
    // Reachable without anybody doing anything wrong: an unset or mistyped
    // NEXT_PUBLIC_DEFAULT_CITY_ID gives every visitor with no saved address a
    // city id that does not exist.
    throw new UnknownCityError(input.cityId);
  }

  let firstTime: boolean;

  if (input.userId) {
    const existing = await prisma.serviceInterest.findUnique({
      where: {
        serviceKey_cityId_userId: {
          serviceKey: service.key,
          cityId: input.cityId,
          userId: input.userId,
        },
      },
      select: { id: true },
    });
    firstTime = existing === null;

    await prisma.serviceInterest.upsert({
      where: {
        serviceKey_cityId_userId: {
          serviceKey: service.key,
          cityId: input.cityId,
          userId: input.userId,
        },
      },
      create: {
        serviceKey: service.key,
        cityId: input.cityId,
        userId: input.userId,
        createdAt: now,
        lastAskedAt: now,
      },
      update: { askCount: { increment: 1 }, lastAskedAt: now },
    });
  } else {
    // One shared counter row for everybody who is not signed in. A NULL
    // userId is not equal to itself in Postgres, so the unique index does not
    // apply here and this has to find the row itself. Two simultaneous first
    // taps can create two rows; the reads sum them, so a duplicate counter is
    // a rounding error rather than a bug.
    const shared = await prisma.serviceInterest.findFirst({
      where: { serviceKey: service.key, cityId: input.cityId, userId: null },
      select: { id: true },
    });
    firstTime = shared === null;

    if (shared) {
      await prisma.serviceInterest.update({
        where: { id: shared.id },
        data: { askCount: { increment: 1 }, lastAskedAt: now },
      });
    } else {
      await prisma.serviceInterest.create({
        data: {
          serviceKey: service.key,
          cityId: input.cityId,
          createdAt: now,
          lastAskedAt: now,
        },
      });
    }
  }

  return { tally: await tallyFor(service.key, input.cityId), firstTime };
}

/** Who has asked for one service in one city. */
export async function tallyFor(
  serviceKey: ServiceKey,
  cityId: string,
): Promise<InterestTally> {
  const [accounts, anonymous] = await Promise.all([
    prisma.serviceInterest.count({
      where: { serviceKey, cityId, userId: { not: null } },
    }),
    prisma.serviceInterest.aggregate({
      where: { serviceKey, cityId, userId: null },
      _sum: { askCount: true },
    }),
  ]);

  return { accounts, anonymous: anonymous._sum.askCount ?? 0 };
}

/** Which services this account has already asked for, in one city. */
export async function servicesAskedFor(input: {
  userId: string;
  cityId: string;
}): Promise<Set<ServiceKey>> {
  const rows = await prisma.serviceInterest.findMany({
    where: { userId: input.userId, cityId: input.cityId },
    select: { serviceKey: true },
  });
  return new Set(rows.map((row) => row.serviceKey));
}

export interface ServiceDemand {
  serviceKey: ServiceKey;
  accounts: number;
  anonymous: number;
  /** Per city, busiest first. The row a launch decision is actually made on. */
  byCity: { cityId: string; accounts: number; anonymous: number }[];
}

/** One row of the grouped query, and the only thing `foldDemand` needs. */
export interface DemandRow {
  serviceKey: ServiceKey;
  cityId: string;
  userId: string | null;
  askCount: number;
}

/**
 * Turns grouped rows into per-service, per-city demand.
 *
 * Separate from the query, and pure, because this fold is where the mistake
 * would be: an account and a tap are counted differently on purpose, and
 * adding them together — the obvious thing to do — would report a number that
 * one person with a script can move.
 *
 * A row with a userId is ONE person however many times they asked. A row with
 * no userId is a shared counter, so its `askCount` is the number of taps.
 */
export function foldDemand(rows: readonly DemandRow[]): Map<ServiceKey, ServiceDemand> {
  const byService = new Map<ServiceKey, ServiceDemand>();
  const cityIndex = new Map<string, { cityId: string; accounts: number; anonymous: number }>();

  for (const row of rows) {
    const demand =
      byService.get(row.serviceKey) ??
      { serviceKey: row.serviceKey, accounts: 0, anonymous: 0, byCity: [] };
    byService.set(row.serviceKey, demand);

    const cityKey = `${row.serviceKey}:${row.cityId}`;
    let city = cityIndex.get(cityKey);
    if (!city) {
      city = { cityId: row.cityId, accounts: 0, anonymous: 0 };
      cityIndex.set(cityKey, city);
      demand.byCity.push(city);
    }

    if (row.userId === null) {
      demand.anonymous += row.askCount;
      city.anonymous += row.askCount;
    } else {
      demand.accounts += 1;
      city.accounts += 1;
    }
  }

  for (const demand of byService.values()) {
    // Busiest city first: the launch list reads top to bottom.
    demand.byCity.sort((a, b) => b.accounts - a.accounts || b.anonymous - a.anonymous);
  }

  return byService;
}

/**
 * Everything asked for, grouped by service and then city.
 *
 * Aggregated in the database rather than by loading rows and counting in
 * TypeScript, for the same reason the rest of the console is: this works
 * beautifully on ten rows and badly on a hundred thousand.
 */
export async function demandByService(): Promise<Map<ServiceKey, ServiceDemand>> {
  const grouped = await prisma.serviceInterest.groupBy({
    by: ['serviceKey', 'cityId', 'userId'],
    _sum: { askCount: true },
  });

  return foldDemand(
    grouped.map((row) => ({
      serviceKey: row.serviceKey,
      cityId: row.cityId,
      userId: row.userId,
      askCount: row._sum.askCount ?? 0,
    })),
  );
}


export interface LaunchAnnouncement {
  serviceKey: ServiceKey;
  cityId: string;
  userId: string;
  interestId: string;
}

/**
 * Interest rows whose service has since gone live where the person asked.
 *
 * Read as a plain query rather than fired from the launch switch, for two
 * reasons. A console action that fans out to every person who ever asked would
 * hold a transaction open while it wrote thousands of rows, on a request an
 * administrator is waiting on. And a launch that happened before this existed
 * — or one done with a SQL update, or by withdrawing and re-adding a city — is
 * picked up anyway, because the query asks about the current state rather than
 * about an event somebody remembered to publish.
 */
export async function pendingLaunchAnnouncements(
  limit = 200,
): Promise<LaunchAnnouncement[]> {
  const rows = await prisma.serviceInterest.findMany({
    where: {
      notifiedAt: null,
      // Anonymous rows can never be told anything. They stay null forever,
      // which is why this filter is here and not a puzzle later.
      userId: { not: null },
      service: { isActive: true },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      serviceKey: true,
      cityId: true,
      userId: true,
      service: { select: { availableCityIds: true } },
    },
  });

  // The city test cannot be expressed in the query — `availableCityIds` is an
  // array on Service and the city to compare it against is on the row — so it
  // happens here. `isActive` is filtered above so this only ever discards the
  // launched-elsewhere case.
  return rows.flatMap((row) =>
    row.userId !== null && row.service.availableCityIds.includes(row.cityId)
      ? [
          {
            interestId: row.id,
            serviceKey: row.serviceKey,
            cityId: row.cityId,
            userId: row.userId,
          },
        ]
      : [],
  );
}

/** Marks one interest row as told. Idempotent by way of the null check above. */
export async function markAnnounced(interestId: string, now = new Date()): Promise<void> {
  await prisma.serviceInterest.update({
    where: { id: interestId },
    data: { notifiedAt: now },
  });
}

export { UnknownServiceError };
