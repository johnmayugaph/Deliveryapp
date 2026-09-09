/**
 * The zone every date on every screen is rendered in.
 *
 * This exists because a unit test written for something else caught the app
 * showing the wrong time to everybody. `toLocaleTimeString('en-PH', …)` picks
 * the *locale* — how the time is written — and NOT the zone: with no `timeZone`
 * option it renders in whatever zone the Node process is in. Nothing in the
 * `Dockerfile`, `docker-compose.yml` or `.env.example` sets `TZ`, so a
 * container runs in **UTC**, and an order placed at 7:30pm in Manila renders
 * as 11:30am.
 *
 * It is invisible while developing, because everything is wrong *consistently*
 * — the seed data, the clock and the screen all agree.
 *
 * Three places in the codebase already got this right and did it their own
 * way: `startOfManilaDay` in the admin queries, `monthStart` in the referral
 * caps, and one explicit `timeZone: 'Asia/Manila'` in recovery. So the concept
 * was never missed; it was decided three times and skipped everywhere else.
 * This is the one home for it.
 *
 * The arithmetic is a fixed offset rather than a locale string, following
 * `monthStart`'s reasoning: **Manila is UTC+8 with no daylight saving**, so a
 * local boundary is a constant shift from the UTC one, and doing it this way
 * stays testable without a timezone database.
 *
 * Pure: imports nothing.
 */

/** What the app renders in. Not the host's zone, and not the viewer's. */
export const DISPLAY_ZONE = 'Asia/Manila';

/** Manila's offset from UTC. Constant — the Philippines has no DST. */
export const DISPLAY_OFFSET_MS = 8 * 60 * 60 * 1_000;

/** Midnight in Manila for the day containing `at`. */
export function startOfDayIn(at: Date): Date {
  const shifted = new Date(at.getTime() + DISPLAY_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - DISPLAY_OFFSET_MS);
}

/**
 * Midnight in Manila `days` days before the day containing `at`.
 *
 * A helper rather than `setDate(getDate() - n)` at the call site, which is
 * what the rider's weekly earnings did: `setDate` moves a calendar day in the
 * HOST's zone, so on a UTC container it walked back from the wrong midnight.
 * Plain millisecond arithmetic is exact here because the Philippines has no
 * daylight saving — every day is the same length.
 */
export function startOfDaysAgoIn(at: Date, days: number): Date {
  return new Date(startOfDayIn(at).getTime() - days * 24 * 60 * 60 * 1_000);
}

/**
 * The calendar day `at` falls on in Manila, as `YYYY-MM-DD`.
 *
 * A string rather than a Date because its only job is comparison, and two
 * strings compare correctly where two Dates invite the host-zone mistake this
 * module exists to prevent.
 */
export function dayKeyIn(at: Date): string {
  const shifted = new Date(at.getTime() + DISPLAY_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

/** Whether two moments fall on the same Manila day. */
export function sameDayIn(a: Date, b: Date): boolean {
  return dayKeyIn(a) === dayKeyIn(b);
}

/**
 * Formatters, each pinning the zone explicitly.
 *
 * Every screen should reach a date through one of these. Passing `timeZone` at
 * each of forty-eight call sites is the version of this that goes wrong on the
 * forty-ninth.
 */
export function formatTimeIn(at: Date): string {
  return at.toLocaleTimeString('en-PH', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_ZONE,
  });
}

export function formatDayIn(at: Date): string {
  return at.toLocaleDateString('en-PH', {
    day: 'numeric',
    month: 'short',
    timeZone: DISPLAY_ZONE,
  });
}

export function formatFullDayIn(at: Date): string {
  return at.toLocaleDateString('en-PH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: DISPLAY_ZONE,
  });
}
