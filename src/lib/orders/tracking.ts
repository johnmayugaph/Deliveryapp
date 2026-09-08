import { OrderStatus } from '@prisma/client';
import { ACTIVE_JOB_STATUSES } from '@/lib/fleet/job-policy';
import { haversineMeters } from '@/lib/geo';

/**
 * Showing a customer where their rider is.
 *
 * Pure, and the three rules it holds are the ones that decide whether this
 * feature is honest or merely impressive.
 *
 * **1. Only while somebody is carrying it.** The trackable statuses are
 * `ACTIVE_JOB_STATUSES` — the same list the rider's own screen uses to decide
 * what their current job is — rather than a second list that could disagree
 * with it. Before assignment there is nobody to show; after a terminal status
 * the rider has gone home, and where they went is nobody's business.
 *
 * **2. Only a recent fix.** A pin from eleven minutes ago is worse than no pin:
 * it is a confident wrong answer, and the customer stands at the gate watching
 * a stationary motorcycle that is actually three barangays away. Past
 * `POSITION_FRESH_MS` the map says it has lost the signal and the status
 * timeline — which is always right — carries the screen instead.
 *
 * **3. Only their own order.** The position is read through the order and
 * checked against the signed-in customer; nothing here takes a rider id.
 */

/** Statuses where a rider is on the job, so a position means something. */
export const TRACKABLE_STATUSES: readonly OrderStatus[] = ACTIVE_JOB_STATUSES;

export function isTrackableStatus(status: OrderStatus): boolean {
  return TRACKABLE_STATUSES.includes(status);
}

/**
 * How old a fix may be before the map stops claiming to know.
 *
 * Ninety seconds is a little over five sharing intervals, so an ordinary gap —
 * a tunnel, a dropped packet, a phone that slept for a moment — does not blank
 * the map, while a rider whose phone has genuinely stopped reporting is
 * admitted to within a minute and a half.
 */
export const POSITION_FRESH_MS = 90_000;

export function positionIsFresh(updatedAt: Date, now: Date = new Date()): boolean {
  const age = now.getTime() - updatedAt.getTime();
  // A fix from the future is a clock disagreement, not freshness. Treated as
  // current rather than thrown away: the phone's clock is not the customer's
  // problem.
  return age < POSITION_FRESH_MS;
}

/** "just now", "40s ago", "2 min ago" — under the pin, so nobody has to guess. */
export function describeFix(updatedAt: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - updatedAt.getTime()) / 1_000));
  if (seconds < 15) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min ago`;
}

/**
 * How often the customer's screen asks for a new position.
 *
 * Ten seconds, and polling rather than a socket or an event stream. That is a
 * decision, not a shortcut:
 *
 *  - At delivery speed a motorcycle covers about eighty metres in ten seconds,
 *    which on a map at street zoom is a pin that moves smoothly enough that
 *    nobody can tell it is not continuous.
 *  - An event stream holds a connection open per watching customer. On the
 *    single small server this is built to run on, a hundred people watching
 *    their lunch is a hundred idle sockets plus whatever the reverse proxy
 *    decides to do about buffering them — and the failure mode is a stream
 *    that silently stops updating, which is exactly the confident wrong answer
 *    rule 2 exists to prevent.
 *  - The request is one indexed row and a freshness check. It is cheaper than
 *    the page refresh the tracking screen already does every fifteen seconds.
 *
 * If this ever needs to be genuinely continuous the seam is one function on
 * the client and one on the server, which is a smaller change than getting
 * sockets right on day one would have been.
 */
export const TRACKING_POLL_MS = 10_000;

/**
 * How often a rider's phone reports in while carrying a job.
 *
 * Fifteen seconds and at least twenty-five metres of movement, whichever is
 * later. The distance filter is what stops a phone sitting at a red light
 * writing the same coordinates to the database four times a minute, and the
 * interval is what stops a rider on a highway writing them forty times.
 *
 * Both numbers are also a battery decision. `watchPosition` keeps the radio
 * warm; the throttle means the WRITES are bounded even though the reads are
 * continuous, and a rider whose battery dies is a delivery that stops.
 */
export const SHARE_INTERVAL_MS = 15_000;
export const SHARE_MIN_METRES = 25;

export interface Fix {
  latitude: number;
  longitude: number;
  at: number;
}

/**
 * How often the rider's phone re-examines the fix it is holding.
 *
 * `watchPosition` calls back when the position CHANGES, which is not the same
 * as continuously. A reading refused for arriving too soon after the last
 * write must therefore be held and reconsidered on a clock of our own —
 * dropping it means waiting for the phone to move again, and a rider who
 * moves and then stops (which is what arriving looks like) may not move again
 * for minutes. This tick costs nothing: it re-reads a fix already in memory
 * and never asks the radio for a new one.
 */
export const SHARE_FLUSH_MS = 3_000;

/**
 * Whether a new reading is worth sending.
 *
 * The first one always is. After that: enough time AND enough movement, so a
 * parked phone is quiet and a moving one is current.
 *
 * `now` rather than `next.at` for the interval, and the distinction matters.
 * The question is "has it been long enough since we last WROTE" — measured
 * against the clock — not "were these two readings taken far enough apart",
 * which is a question about the phone's sampling and has nothing to do with
 * how current the customer's map is. Asked the second way, a fix taken two
 * seconds after a write stays two seconds after it forever, and is refused
 * forever however long it then sits in hand.
 */
export function shouldShareFix(previous: Fix | null, next: Fix, now: number): boolean {
  if (previous === null) return true;
  if (now - previous.at < SHARE_INTERVAL_MS) return false;
  const moved = haversineMeters(
    previous.latitude,
    previous.longitude,
    next.latitude,
    next.longitude,
  );
  return moved >= SHARE_MIN_METRES;
}

/**
 * A coordinate a browser handed us, or null.
 *
 * Geolocation on a bad fix reports positions that are merely wrong rather than
 * absent — a null island reading at (0, 0) is the classic one — and a rider
 * apparently in the Gulf of Guinea would put the customer's map over the
 * ocean. The Philippines bounds are checked by the caller; what is refused
 * here is the shape.
 */
export function readCoordinate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/** What the customer's screen is given, and nothing more. */
export interface RiderPosition {
  latitude: number;
  longitude: number;
  updatedAt: Date;
}

/** Metres between the rider and where they are going, for the caption. */
export function metresToDropoff(
  rider: { latitude: number; longitude: number },
  dropoff: { latitude: number; longitude: number },
): number {
  return Math.round(
    haversineMeters(rider.latitude, rider.longitude, dropoff.latitude, dropoff.longitude),
  );
}

/** "400 m away", "1.2 km away" — distance, never an arrival time. */
export function describeDistance(metres: number): string {
  if (metres < 1_000) return `${Math.max(10, Math.round(metres / 10) * 10)} m away`;
  return `${(metres / 1_000).toFixed(1)} km away`;
}
