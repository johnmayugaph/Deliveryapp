import { DISPLAY_OFFSET_MS } from '@/lib/time/manila';

/**
 * Posted opening hours, and whether the shop is inside them right now.
 *
 * WHY THERE IS NO SCHEDULER. The obvious build is a cron that flips `isOpen`
 * at 08:00 and back at 17:00, and it is the wrong one: the state is then only
 * as correct as the last job run. A missed sweep leaves a shop taking orders
 * at three in the morning, a double run fights the shop's own switch, and
 * nothing in the database says which of the two wrote the row last.
 *
 * So openness is DERIVED, every time it is read, from the clock and four
 * integers. There is no job to fail, no drift to reconcile, and the whole rule
 * is the pure function below — which means it can be tested at 4,000 minutes
 * of the day in a second rather than by waiting for five o'clock.
 *
 * `Store.isOpen` keeps its meaning: the shop's own switch. A customer can
 * order when that is true AND the clock is inside the posted hours. The shop
 * can therefore close early on a dead Tuesday without editing its hours, and
 * it reopens by itself the next morning — which is the behaviour a switch
 * alone could never give, because somebody has to remember to flip it back.
 */

/** Minutes in a day. 1440 is midnight tomorrow, which is 0. */
export const MINUTES_IN_DAY = 24 * 60;

export interface OpeningHours {
  /** Minutes from midnight, Manila. Null means no posted schedule. */
  opensAtMinute: number | null;
  closesAtMinute: number | null;
  /** An optional daily break. Both null, or both set. */
  breakStartMinute: number | null;
  breakEndMinute: number | null;
}

/**
 * The minute of the Manila day, 0–1439.
 *
 * Through the fixed offset rather than `Intl`, deliberately: the Philippines
 * has never observed daylight saving, the rest of this codebase already
 * measures Manila days by the same constant, and a formatter here would make
 * a hot read path allocate.
 */
export function manilaMinuteOfDay(at: Date): number {
  const shifted = at.getTime() + DISPLAY_OFFSET_MS;
  const sinceMidnight = ((shifted % 86_400_000) + 86_400_000) % 86_400_000;
  return Math.floor(sinceMidnight / 60_000);
}

/**
 * Whether `minute` falls in the window that starts at `from` and ends at `to`.
 *
 * Start-inclusive, end-EXCLUSIVE, and that matters at exactly one moment a
 * day: a shop posted 08:00–17:00 is shut at 17:00, not at 17:01. "Closes at
 * five" is what the sign on the door means.
 *
 * A `to` at or below `from` is an overnight window — 18:00 to 02:00 — and is
 * the normal case for a carinderia rather than a typo, so it is handled here
 * instead of being refused at the form.
 */
export function withinWindow(minute: number, from: number, to: number): boolean {
  if (from === to) return false; // A zero-length window is never open.
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** Whether the posted hours say the shop is open at this instant. */
export function withinOpeningHours(hours: OpeningHours, at: Date): boolean {
  const { opensAtMinute, closesAtMinute } = hours;
  // No schedule is not "closed" — it is "the schedule has no opinion", and the
  // shop's own switch is then the whole answer. Every store behaved this way
  // before opening hours existed.
  if (opensAtMinute === null || closesAtMinute === null) return true;

  const minute = manilaMinuteOfDay(at);
  if (!withinWindow(minute, opensAtMinute, closesAtMinute)) return false;

  const { breakStartMinute, breakEndMinute } = hours;
  if (breakStartMinute !== null && breakEndMinute !== null) {
    if (withinWindow(minute, breakStartMinute, breakEndMinute)) return false;
  }
  return true;
}

/**
 * The one answer every customer path should ask for.
 *
 * Both halves, in one place, so no screen can check the switch and forget the
 * clock — which is how a shop ends up greyed out on the list and still able to
 * take an order at checkout.
 */
export function isAcceptingOrders(
  store: OpeningHours & { isOpen: boolean },
  at: Date,
): boolean {
  return store.isOpen && withinOpeningHours(store, at);
}

/** "08:00", from a minute of the day. */
export function formatMinuteOfDay(minute: number): string {
  const hour = Math.floor(minute / 60) % 24;
  const rest = minute % 60;
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** "08:00" back to 480, or null if it is not a time. */
export function parseMinuteOfDay(raw: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * The hours as a sentence, for the storefront and the shop's own screen.
 *
 * Says when it REOPENS rather than only that it is shut, because "Closed"
 * with no time beside it is the message that makes somebody close the app.
 */
export function describeOpeningHours(hours: OpeningHours): string | null {
  const { opensAtMinute, closesAtMinute } = hours;
  if (opensAtMinute === null || closesAtMinute === null) return null;

  const base = `${formatMinuteOfDay(opensAtMinute)}–${formatMinuteOfDay(closesAtMinute)}`;
  const { breakStartMinute, breakEndMinute } = hours;
  if (breakStartMinute === null || breakEndMinute === null) return base;
  return `${base}, closed ${formatMinuteOfDay(breakStartMinute)}–${formatMinuteOfDay(
    breakEndMinute,
  )}`;
}
