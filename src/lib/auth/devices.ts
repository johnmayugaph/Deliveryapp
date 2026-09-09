/**
 * What the "signed in on" list can honestly say.
 *
 * The list exists so somebody can spot a session they do not recognise and
 * revoke it, which makes every date on it load-bearing. Two were wrong.
 *
 * **"Last used" was up to five days stale, by construction.** Sessions use a
 * sliding window: `getCurrentUser` extends one that is in active use, but only
 * once it comes within `REFRESH_WHEN_REMAINING_DAYS` of expiry, so a busy
 * customer is not writing to the database on every page view. That is the
 * right trade — and it means `lastSeenAt` is bumped at most once every
 * {@link LAST_SEEN_LAG_DAYS} days. The screen labelled the column "Last used"
 * anyway, so the session RENDERING THE SCREEN — the row with the "This one"
 * badge, in use at that exact second — could read "Last used Sep 4".
 *
 * **The exact fact was loaded and dropped.** `createdAt` is written once and
 * never lazily: it is when this session started, it is precise, it was in
 * `ActiveSessionSummary`, returned by the query, and rendered nowhere. It is
 * also the fact the screen is for — a sign-in nobody remembers is the alarm,
 * and "last used" on a stranger's session tells you only that they are still
 * there.
 *
 * So: `createdAt` is the date on the row, the current session is described as
 * what it is, and the imprecision in `lastSeenAt` is stated once, in days
 * derived from the two window constants rather than typed into a sentence
 * that would rot the first time the window moved.
 *
 * Pure: imports nothing. `session.ts` reads the two constants from here.
 */

/** How long a session lasts without use. */
export const SESSION_TTL_DAYS = 30;

/**
 * Sliding window: a session in active use is extended, but only when it is
 * within this much of expiry, so a busy customer is not writing to the
 * database on every page view.
 */
export const REFRESH_WHEN_REMAINING_DAYS = 25;

/**
 * The longest `lastSeenAt` can lag actual use. DERIVED, not chosen.
 *
 * A use at time `U` refreshes the row only when `expiresAt - U` has fallen
 * below the threshold. A refresh at `T` sets `expiresAt = T + TTL`, so the
 * next use that refreshes anything is the first one after
 * `T + TTL - THRESHOLD`. Until then `lastSeenAt` stays at `T` however much
 * the session is used — which is the whole defect, and why this number is
 * computed here instead of appearing as a "5" in some copy.
 *
 * It assumes the bookkeeping write landed. That write is deliberately
 * fire-and-forget (a failed refresh must not fail a page render), so a
 * database that refused it leaves `lastSeenAt` staler still. Which is the
 * other reason the copy says "at least this recently" rather than naming a
 * moment the session was last touched.
 */
export const LAST_SEEN_LAG_DAYS = SESSION_TTL_DAYS - REFRESH_WHEN_REMAINING_DAYS;

/**
 * How many rows the list shows.
 *
 * Owned here because the CAP and the COUNT on the revoke button have to be
 * told apart: the button used to say `Sign out of ${rows.length - 1} other
 * device` off a capped list while the action it triggered was uncapped, so a
 * number that was a display limit read as a promise about what the tap would
 * do.
 */
export const DEVICE_LIST_LIMIT = 20;

/**
 * Enough of a user-agent string to recognise a device.
 *
 * Not a full parse and not meant to be: the string is truncated to 180
 * characters before it is stored, and the question this answers is "is one of
 * these not mine", which a family of device does well enough. Anything
 * unrecognised says so rather than guessing.
 */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iPhone o iPad';
  if (/Android/i.test(userAgent)) return 'Android';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'Mac';
  if (/Windows/i.test(userAgent)) return 'Windows';
  if (/Linux/i.test(userAgent)) return 'Linux';
  return 'Browser';
}

/**
 * What is known about when a session was last used.
 *
 * Two states, and the second is a LOWER BOUND rather than a moment. There is
 * deliberately no third state inferring an upper bound from the refresh rule:
 * the arithmetic works, but it rests on a fire-and-forget write, and the
 * direction it would be wrong in is the one that makes a live intruder look
 * dormant.
 */
export type LastUse =
  /** The session this page is being rendered for. Used now, definitionally. */
  | { kind: 'NOW' }
  /** Used at least this recently, and possibly since. */
  | { kind: 'SINCE'; at: Date };

export function lastUseOf(session: { lastSeenAt: Date; isCurrent: boolean }): LastUse {
  return session.isCurrent ? { kind: 'NOW' } : { kind: 'SINCE', at: session.lastSeenAt };
}

export function describeLastUse(
  state: LastUse,
  formatDay: (at: Date) => string,
): string {
  switch (state.kind) {
    case 'NOW':
      return 'In use now';
    case 'SINCE':
      return `Used since ${formatDay(state.at)}`;
  }
}

/** Just the columns a row depends on. Structural, so a summary passes in. */
export interface DeviceFacts {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  userAgent: string | null;
  isCurrent: boolean;
}

/** One row of the list. */
export interface DeviceRow {
  id: string;
  device: string;
  isCurrent: boolean;
  /** When this session started. Exact. */
  signedInAt: Date;
  lastUse: LastUse;
}

export function deviceRows(sessions: readonly DeviceFacts[]): DeviceRow[] {
  return sessions.map((session) => ({
    id: session.id,
    device: describeDevice(session.userAgent),
    isCurrent: session.isCurrent,
    signedInAt: session.createdAt,
    lastUse: lastUseOf(session),
  }));
}

/**
 * The sentence under the list, saying how precise its dates are.
 *
 * Derived from the window, so moving the refresh threshold moves the number
 * here too. A "5" typed into this string is the fourth instance in this
 * project of prose about a gate outliving the gate.
 */
export function describeLastUsePrecision(): string {
  return (
    `A device may have been used more recently than it says — we only ` +
    `record use every ${LAST_SEEN_LAG_DAYS} days, to avoid writing to your ` +
    `account on every tap.`
  );
}

/**
 * What the revoke control should say, or null when there is nothing to revoke.
 *
 * `otherCount` is counted with the same predicate the revoke uses rather than
 * measured off the visible rows — see {@link DEVICE_LIST_LIMIT}.
 */
export function describeRevoke(
  otherCount: number,
  countOf: (n: number, singular: string) => string,
): string | null {
  return otherCount > 0 ? `Sign out of ${countOf(otherCount, 'other device')}` : null;
}

/** How many rows the list is hiding, if any. */
export function notListedCount(listed: number, otherCount: number): number {
  // `otherCount` excludes the current session; `listed` includes it when it
  // fits. Never negative: the count and the page are read a moment apart.
  const total = otherCount + 1;
  return Math.max(0, total - listed);
}
