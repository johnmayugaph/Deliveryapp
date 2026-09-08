import { NotificationKind, type ServiceKey } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { getService } from '@/lib/services/registry';
import { marketKey, type MarketOutcome } from '@/lib/pricing/surge';
import {
  ALERT_COOLDOWN_SECONDS,
  SUSTAINED_MINUTES,
  SUSTAINED_ALERT_COOLDOWN_SECONDS,
  alertWorthSending,
  sustainedRun,
  type SurgeReading,
} from '@/lib/pricing/surge-alert-policy';

/**
 * Telling people about surge.
 *
 * Surge that nobody is told about is a price rise with no incentive attached:
 * the customer pays more and no more riders come out, which is the exact
 * failure the fee is named against. So this is not decoration on the pricing
 * feature — it is the half that makes it do its job.
 *
 * Two messages, to two audiences, and they are shaped by opposite concerns.
 *
 * **To riders, the danger is noise.** The market is measured every minute. A
 * naive "notify while surging" is sixty pushes an hour to every rider in the
 * city, which is how an app gets its notifications switched off in a week. So:
 * only on a step going UP, only to riders who are not already online, only
 * outside quiet hours, and never twice inside the cooldown.
 *
 * **To administrators, the danger is silence.** A market pinned at the top step
 * has been offered everything the ladder has and is still short. Nothing about
 * the pricing screen makes that visible — it looks like surge working — and the
 * answer is recruitment rather than a higher step.
 *
 * ### What is deliberately NOT here
 *
 * There is no "the sweep has stopped measuring" alert, and there cannot be a
 * useful one: the thing that would detect it is the thing that stopped. An
 * alert written from inside the sweep to say the sweep is not running is a
 * check that can never fire, and this codebase has produced enough of those.
 * That failure is covered where it can be — the banner on `/admin/surge`, which
 * is honest about being visible only to somebody who opens it — and properly
 * belongs to whatever watches the cron from outside.
 */

export interface AlertPassResult {
  /** Markets that transitioned up into a step. */
  markets: number;
  /** Riders told. */
  riders: number;
  /** Markets reported to administrators as sustained. */
  sustained: number;
}

/**
 * The newest snapshot from BEFORE this pass, per market.
 *
 * The comparison the whole rider alert turns on, so how it is expressed
 * matters. An earlier version took the second-newest row (`skip: 1`), which
 * quietly assumed each pass writes exactly one row per market — true today,
 * and false the moment two rows share a timestamp, at which point "the
 * previous reading" becomes whichever of the tied rows the database happened
 * to return. A market would then look unchanged when it had just gone busy,
 * and nobody would be told.
 *
 * `createdAt < now` is exact instead, and it is exact because
 * `recordSurgeSnapshots` stamps every row of a pass with that same instant.
 */
export async function previousReadings(
  markets: readonly MarketOutcome[],
  now: Date,
  client?: PrismaTransactionClient,
): Promise<Map<string, number>> {
  const db = client ?? prisma;
  const before = new Map<string, number>();

  for (const market of markets) {
    const rows = await db.surgeSnapshot.findMany({
      where: {
        serviceType: market.serviceType,
        cityId: market.cityId,
        createdAt: { lt: now },
      },
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: { surgeCentavos: true },
    });
    // No previous reading means this market has never been measured before.
    // Treated as ₱0, so the first measurement of a busy market does alert —
    // a launch into a rush should not be silent.
    before.set(marketKey(market.serviceType, market.cityId), rows[0]?.surgeCentavos ?? 0);
  }
  return before;
}

/**
 * Riders who could take a job in this market but are not currently working.
 *
 * Offline is the filter that matters and it is a choice worth naming. An online
 * rider is already in the dispatch loop: offers reach them with the surge
 * included in the earnings figure, so telling them the market is busy is a
 * second message about something their own screen already says. The supply
 * surge is meant to reach is the rider who has closed the app.
 */
export async function ridersToInvite(
  serviceType: ServiceKey,
  cityId: string,
  client?: PrismaTransactionClient,
): Promise<{ id: string; userId: string }[]> {
  const db = client ?? prisma;
  return db.fleetPartner.findMany({
    where: {
      isOnline: false,
      isSuspended: false,
      wantsBusyAlerts: true,
      homeCityId: cityId,
      enabledServices: { has: serviceType },
    },
    select: { id: true, userId: true },
  });
}

/**
 * Which of those riders has not been told recently.
 *
 * One query for the whole city rather than one per rider, and it reads the
 * notification table itself rather than keeping a separate "last alerted"
 * column — the record of what somebody was told is the right place to ask what
 * somebody was told, and a column would be a second truth that can disagree
 * with the inbox.
 */
export async function recentlyAlerted(
  serviceType: ServiceKey,
  cityId: string,
  userIds: readonly string[],
  now: Date,
  client?: PrismaTransactionClient,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const db = client ?? prisma;

  const since = new Date(now.getTime() - ALERT_COOLDOWN_SECONDS * 1_000);
  const rows = await db.notification.findMany({
    where: {
      kind: NotificationKind.SURGE_ACTIVE,
      userId: { in: [...userIds] },
      createdAt: { gte: since },
      // Per market: a rider approved for two services in one city can hear
      // about each, since they are different work.
      dedupeKey: { startsWith: alertKeyPrefix(serviceType, cityId) },
    },
    select: { userId: true },
  });
  return new Set(rows.map((row) => row.userId));
}

/** `surge:<service>:<city>:` — the prefix every alert key for a market shares. */
export function alertKeyPrefix(serviceType: ServiceKey, cityId: string): string {
  return `surge:${serviceType}:${cityId}:`;
}

/**
 * Tells riders about markets that just went busier, and administrators about
 * markets that have stopped being a spike.
 *
 * Takes the outcomes the sweep just wrote rather than re-measuring, so the
 * message and the price a customer is being charged come from one reading.
 */
export async function sendSurgeAlerts(
  markets: readonly MarketOutcome[],
  now: Date = new Date(),
  client?: PrismaTransactionClient,
): Promise<AlertPassResult> {
  const db = client ?? prisma;
  const result: AlertPassResult = { markets: 0, riders: 0, sustained: 0 };
  if (markets.length === 0) return result;

  const previous = await previousReadings(markets, now, db);
  const cities = await db.city.findMany({
    where: { id: { in: markets.map((market) => market.cityId) } },
    select: { id: true, name: true },
  });
  const cityNames = new Map(cities.map((city) => [city.id, city.name]));

  for (const market of markets) {
    const key = marketKey(market.serviceType, market.cityId);
    const reading: SurgeReading = {
      surgeCentavos: market.surgeCentavos,
      previousCentavos: previous.get(key) ?? 0,
    };

    if (alertWorthSending(reading)) {
      result.markets += 1;
      result.riders += await inviteRiders(market, cityNames, now, db);
    }

    result.sustained += await reportSustained(market, cityNames, now, db);
  }

  return result;
}

/** The rider half. Returns how many were told. */
async function inviteRiders(
  market: MarketOutcome,
  cityNames: Map<string, string>,
  now: Date,
  db: PrismaTransactionClient,
): Promise<number> {
  const partners = await ridersToInvite(market.serviceType, market.cityId, db);
  if (partners.length === 0) return 0;

  const userIds = partners.map((partner) => partner.userId);
  const alreadyTold = await recentlyAlerted(
    market.serviceType,
    market.cityId,
    userIds,
    now,
    db,
  );

  const service = await getService(market.serviceType);
  const cityName = cityNames.get(market.cityId) ?? 'your area';
  // One key per market per cooldown window, so two sweeps inside the window
  // collapse even if the surge stepped up twice. `recentlyAlerted` is the exact
  // check; this is the belt to its braces, and the thing that makes a retried
  // pass idempotent.
  const window = Math.floor(now.getTime() / (ALERT_COOLDOWN_SECONDS * 1_000));

  let told = 0;
  for (const partner of partners) {
    if (alreadyTold.has(partner.userId)) continue;
    try {
      const sent = await enqueueNotification(
        {
          userId: partner.userId,
          kind: NotificationKind.SURGE_ACTIVE,
          href: '/fleet',
          context: {
            serviceName: service.displayName,
            cityName,
            surgeLabel: market.bandLabel ?? 'Busy',
            surgeCentavos: market.surgeCentavos,
            surgeOrdersWaiting: market.ordersWaiting,
            surgeRidersAvailable: market.ridersAvailable,
          },
          dedupeKey:
            `${alertKeyPrefix(market.serviceType, market.cityId)}${window}:${partner.id}`,
          now,
        },
        db,
      );
      if (sent) told += 1;
    } catch {
      // Never let telling one rider stop the rest, and never let it break the
      // sweep — the pricing itself is already written and correct.
    }
  }
  return told;
}

/** The administrator half. Returns 1 when a market was reported. */
async function reportSustained(
  market: MarketOutcome,
  cityNames: Map<string, string>,
  now: Date,
  db: PrismaTransactionClient,
): Promise<number> {
  // Only meaningful for a market at the TOP of its ladder: a city sitting at
  // the ₱20 step for an hour is surge doing its job, not a staffing problem.
  const topStep = await db.surgeBand.aggregate({
    where: {
      serviceType: market.serviceType,
      isActive: true,
      OR: [{ cityId: market.cityId }, { cityId: null }],
    },
    _max: { surgeCentavos: true },
  });
  const ceiling = topStep._max.surgeCentavos ?? 0;
  if (ceiling === 0 || market.surgeCentavos < ceiling) return 0;

  const history = await db.surgeSnapshot.findMany({
    where: { serviceType: market.serviceType, cityId: market.cityId },
    orderBy: { createdAt: 'desc' },
    take: SUSTAINED_MINUTES + 5,
    select: { surgeCentavos: true, createdAt: true },
  });
  const run = sustainedRun(history, ceiling);
  if (run.minutes < SUSTAINED_MINUTES) return 0;

  const admins = await db.user.findMany({
    where: { roles: { has: 'ADMIN' } },
    select: { id: true },
  });
  const cityName = cityNames.get(market.cityId) ?? market.cityId;
  const window = Math.floor(
    now.getTime() / (SUSTAINED_ALERT_COOLDOWN_SECONDS * 1_000),
  );

  let reported = 0;
  for (const admin of admins) {
    try {
      const sent = await enqueueNotification(
        {
          userId: admin.id,
          kind: NotificationKind.SURGE_SUSTAINED,
          href: '/admin/surge',
          context: {
            cityName,
            surgeCentavos: market.surgeCentavos,
            surgeMinutes: run.minutes,
            surgeOrdersWaiting: market.ordersWaiting,
            surgeRidersAvailable: market.ridersAvailable,
          },
          dedupeKey:
            `surge-sustained:${market.serviceType}:${market.cityId}:${window}`,
          now,
        },
        db,
      );
      if (sent) reported = 1;
    } catch {
      // Same reasoning as above: an alert must not cost the measurement.
    }
  }
  return reported;
}
