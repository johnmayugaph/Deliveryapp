/**
 * Surge pricing: the rule, with no database and no clock of its own.
 *
 * Surge is the only number in this app that goes UP on a customer who did
 * nothing except open the app at a busy moment. That makes it the number most
 * likely to be experienced as the app inventing a price, so every decision here
 * is aimed at one thing: a customer who asks "why is it ₱79 instead of ₱49?"
 * gets an answer, and gets the same answer twice.
 *
 * Four choices follow from that.
 *
 * **Steps, not a multiplier.** A continuous 1.3× moves the fee on every page
 * refresh: a customer sees ₱43.17, then ₱44.02, and concludes the price is
 * being made up. A step is a flat peso amount with a name — "Busy, +₱20" — that
 * holds still while the market wobbles underneath it.
 *
 * **The market is measured on a schedule, not per quote.** Counting the queue
 * inside a quote means the checkout page and the placement a few seconds later
 * can disagree, and the customer is shown one price and charged another. The
 * cron writes a `SurgeSnapshot`; quotes read the newest one. Every charge is
 * then explainable from stored inputs long after the moment has passed.
 *
 * **Off unless somebody turned it on.** No `SurgeBand` rows means no surge, the
 * same way commission starts at zero. Surge is a policy decision about a
 * market, and the code has no business having an opinion by default.
 *
 * **Every uncertainty resolves to not charging.** No snapshot, a stale
 * snapshot, no ladder, no step met — all of them are ₱0. The failure mode of
 * this module is "we missed a chance to pay riders more", never "we billed
 * somebody for a market condition we could not confirm".
 *
 * Pure: no imports but types, so a client component can render a surge line
 * without dragging the server into the browser bundle.
 */

/**
 * The hard ceiling on one step, in centavos.
 *
 * Mirrors `surge_band_step_sane` in `prisma/sql/surge.sql`, and the test suite
 * asserts the two agree — the database is the enforcement, this is the same
 * number where the arithmetic can see it. ₱100 sits deliberately below the ₱250
 * fee cap the seed ships: a surge bigger than the whole fare is a decimal point
 * in the wrong place, not a busy Friday.
 */
export const SURGE_CEILING_CENTAVOS = 10_000;

/**
 * How old a snapshot may be and still set a price, in seconds.
 *
 * The cron runs every minute, so five minutes is four missed passes — by then
 * the reading describes a market that has moved. The direction of this failure
 * is chosen: a stale snapshot charges nothing rather than charging yesterday's
 * peak, because a surge nobody can still observe is indistinguishable from an
 * invented one.
 */
export const SNAPSHOT_MAX_AGE_SECONDS = 5 * 60;

/** A configured step. Structural, so callers can pass Prisma rows straight in. */
export interface SurgeBandFacts {
  id: string;
  cityId: string | null;
  minOrdersPerRider: number;
  surgeCentavos: number;
  label: string;
  isActive: boolean;
}

/** A stored measurement. */
export interface SurgeSnapshotFacts {
  surgeCentavos: number;
  bandLabel: string | null;
  createdAt: Date;
}

/** Why a quote is or is not carrying surge. Every branch is named. */
export type SurgeReason =
  /** Nobody has configured a ladder for this service and city. */
  | 'NOT_CONFIGURED'
  /** Configured, but the cron has never measured this service and city. */
  | 'NO_SNAPSHOT'
  /** Measured too long ago to be used — see `SNAPSHOT_MAX_AGE_SECONDS`. */
  | 'STALE'
  /** Measured, and the market is calm enough that no step applies. */
  | 'CALM'
  /** A step applied. */
  | 'BUSY';

export interface SurgeCharge {
  surgeCentavos: number;
  /** The step's name, for the line on the customer's bill. Null when ₱0. */
  label: string | null;
  reason: SurgeReason;
}

/** The one shape for "no surge", so no caller has to remember to null the label. */
function noSurge(reason: Exclude<SurgeReason, 'BUSY'>): SurgeCharge {
  return { surgeCentavos: 0, label: null, reason };
}

/**
 * Orders waiting for a rider, per rider available.
 *
 * Zero riders is the interesting case, and it is deliberately NOT treated as
 * "no market, no surge". Consider one rider with eight orders queued: the ratio
 * is 8 and the surge is at its ceiling. That rider then ends their shift. If
 * zero riders meant zero surge, the surge would vanish at the exact moment the
 * market got worse — a cliff at the tightest hour, visible to customers as the
 * price dropping as the wait got longer.
 *
 * So with no riders each waiting order counts as its own unit of pressure,
 * which is continuous with the one-rider case and keeps the ladder monotonic.
 * An empty market — no orders, no riders — is still 0, which is the honest
 * reading of 3am.
 */
export function ordersPerRider(
  ordersWaiting: number,
  ridersAvailable: number,
): number {
  const orders = Math.max(0, ordersWaiting);
  const riders = Math.max(0, ridersAvailable);
  if (orders === 0) return 0;
  if (riders === 0) return orders;
  return orders / riders;
}

/**
 * The ladder that applies to a city: its own steps if it has any, otherwise the
 * service's fallback steps (`cityId: null`).
 *
 * A city's ladder wins ENTIRELY. The two are never merged, because half of one
 * ladder and half of another is a ladder nobody designed — and the result would
 * be a surge no operator could predict from either screen they configured. Same
 * rule as `findDeliveryFeeRule`, applied to a set rather than a single row.
 *
 * Inactive steps are dropped here rather than by the caller, so "deactivate the
 * ₱40 step" cannot accidentally mean "fall back to the whole national ladder".
 */
export function ladderFor(
  bands: readonly SurgeBandFacts[],
  cityId: string,
): SurgeBandFacts[] {
  const active = bands.filter((band) => band.isActive);
  const local = active.filter((band) => band.cityId === cityId);
  const chosen = local.length > 0 ? local : active.filter((b) => b.cityId === null);
  return [...chosen].sort((a, b) => a.minOrdersPerRider - b.minOrdersPerRider);
}

/**
 * The step a ratio has earned, or null when the market is calm.
 *
 * Among the steps whose threshold the ratio has met, this takes the LARGEST
 * SURGE rather than the highest threshold. Those are the same answer for any
 * ladder that climbs, which is every ladder anybody means to write. They differ
 * only when a ladder is mistyped — 1.5 → ₱30, 2.0 → ₱10 — and there the
 * difference matters: highest-threshold-met would charge a busier market LESS,
 * so a customer watching the queue grow would watch the price fall, and no
 * screen could explain it.
 *
 * Taking the maximum makes the function monotonic in the ratio by construction,
 * whatever is in the table. The cost is that a mistyped high step cannot be
 * undercut by adding a lower one — it has to be corrected. That is the right
 * cost: `firstDescendingStep` exists so the console can point at the mistake
 * before it is saved.
 */
export function selectBand(
  ladder: readonly SurgeBandFacts[],
  ratio: number,
): SurgeBandFacts | null {
  let best: SurgeBandFacts | null = null;
  for (const band of ladder) {
    if (ratio < band.minOrdersPerRider) continue;
    if (best === null || band.surgeCentavos > best.surgeCentavos) best = band;
  }
  return best;
}

/**
 * The first step in a ladder that charges less than the step below it.
 *
 * Not an error — `selectBand` cannot be made to charge less for more — but a
 * ladder that reads wrong to whoever configured it, and a step whose money will
 * never be reached. The console warns with it.
 */
export function firstDescendingStep(
  ladder: readonly SurgeBandFacts[],
): SurgeBandFacts | null {
  const sorted = [...ladder].sort(
    (a, b) => a.minOrdersPerRider - b.minOrdersPerRider,
  );
  let previous: SurgeBandFacts | null = null;
  for (const band of sorted) {
    if (previous !== null && band.surgeCentavos < previous.surgeCentavos) {
      return band;
    }
    previous = band;
  }
  return null;
}

/** Belt to the SQL guard's braces: no arithmetic here can exceed the ceiling. */
export function capSurge(centavos: number): number {
  if (!Number.isFinite(centavos) || centavos <= 0) return 0;
  return Math.min(Math.round(centavos), SURGE_CEILING_CENTAVOS);
}

/**
 * What the cron should write for a measurement, given the ladder in force.
 *
 * The snapshot stores the OUTCOME as well as the inputs, so a quote never
 * re-runs band selection and cannot reach a different answer than the row it is
 * reading — and so an old charge stays explainable after the bands are edited.
 */
export function surgeForMarket(input: {
  bands: readonly SurgeBandFacts[];
  cityId: string;
  ordersWaiting: number;
  ridersAvailable: number;
}): SurgeCharge & { ratio: number } {
  const ratio = ordersPerRider(input.ordersWaiting, input.ridersAvailable);
  const ladder = ladderFor(input.bands, input.cityId);
  if (ladder.length === 0) return { ...noSurge('NOT_CONFIGURED'), ratio };

  const band = selectBand(ladder, ratio);
  if (band === null) return { ...noSurge('CALM'), ratio };

  const surgeCentavos = capSurge(band.surgeCentavos);
  // A step capped to nothing is not a step. Reachable only if the ceiling is
  // ever lowered below a saved row, and it must not produce a labelled ₱0 —
  // `surge_snapshot_surge_has_a_reason` would refuse the write.
  if (surgeCentavos === 0) return { ...noSurge('CALM'), ratio };

  return { surgeCentavos, label: band.label, reason: 'BUSY', ratio };
}

/**
 * What a quote should charge, from the newest snapshot.
 *
 * `now` is a parameter because a rule that reads the clock cannot be tested at
 * the boundary, and the boundary — five minutes — is the whole behaviour.
 */
export function surgeFromSnapshot(
  snapshot: SurgeSnapshotFacts | null,
  now: Date,
): SurgeCharge {
  if (snapshot === null) return noSurge('NO_SNAPSHOT');

  const ageSeconds = (now.getTime() - snapshot.createdAt.getTime()) / 1_000;
  // A snapshot from the future is a clock disagreeing with itself; treat it the
  // same as stale rather than trusting it, since the one thing it proves is
  // that the timestamps cannot be reasoned about.
  if (ageSeconds < 0 || ageSeconds > SNAPSHOT_MAX_AGE_SECONDS) {
    return noSurge('STALE');
  }

  const surgeCentavos = capSurge(snapshot.surgeCentavos);
  if (surgeCentavos === 0 || snapshot.bandLabel === null) return noSurge('CALM');

  return { surgeCentavos, label: snapshot.bandLabel, reason: 'BUSY' };
}

/** One sentence for a screen, per reason. Compile-enforced over every branch. */
export const SURGE_REASON_TEXT: Record<SurgeReason, string> = {
  NOT_CONFIGURED: 'No surge steps are configured for this service and city.',
  NO_SNAPSHOT: 'The market has not been measured yet, so nothing is added.',
  STALE: 'The last measurement is too old to price from, so nothing is added.',
  CALM: 'There are enough riders for the orders waiting.',
  BUSY: 'More orders than riders right now, and the extra goes to the rider.',
};
