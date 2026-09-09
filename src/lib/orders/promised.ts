/**
 * The promised time, and how a moment is stamped on a screen that is both a
 * live tracker and a permanent receipt.
 *
 * Two defects, and the first is one this codebase had already fixed on the
 * other side of the same order.
 *
 * **A promised time that could not be late.** The merchant queue card learned
 * to say *"Promised 07:42 · 25m late"* — because a time that has passed
 * rendering identically to one that has not is the whole point of showing it.
 * The customer's tracking screen kept the original: `Estimated arrival 07:42`,
 * unchanged at 08:15. The person waiting for the food is the one who most
 * needs that acknowledged, and the shop's own **+10 min** button moves
 * `etaAt`, so the number on the customer's screen is one the shop can push
 * out.
 *
 * **A stamp with no date.** The timeline used `toLocaleTimeString` alone. On a
 * live order that reads fine. On the same screen opened three months later
 * from `/orders` — which is what it is, there is no separate receipt — "07:42"
 * says nothing about which day; and an order placed at 23:50 and delivered at
 * 00:20 renders as a timeline running *backwards*.
 *
 * The wording here is the customer's, not the kitchen's. A shop reads "25m
 * late" about food it is cooking; a customer reads about food that has not
 * arrived, so the tense changes with the fact — "Arriving by 07:42" while
 * there is still time, "was due at 07:42" once there is not.
 *
 * Pure: imports nothing.
 */

/**
 * How late something is, in seconds, or null when it is not.
 *
 * Moved here from `lib/merchant/queue-clock`, which is where it was first
 * written and the wrong home for it once the customer needed the same fact:
 * a module named for the back office is one a customer screen should not be
 * importing. `queue-clock` re-exports it, so the merchant card is unchanged.
 */
export function lateBySeconds(etaAt: Date | null, now: Date): number | null {
  if (etaAt === null) return null;
  const late = Math.floor((now.getTime() - etaAt.getTime()) / 1000);
  return late > 0 ? late : null;
}

/** "25m late" / "1h 5m late". Minutes, because nobody is late by seconds. */
export function formatLate(seconds: number): string {
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes}m late`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m late`;
}

/** What a customer is told about the time they were promised. */
export type PromiseState =
  /** No estimate on this order at all. */
  | { kind: 'NONE' }
  /** Still ahead. */
  | { kind: 'DUE'; at: Date }
  /** Passed, and the order is still going. */
  | { kind: 'OVERDUE'; at: Date; lateSeconds: number }
  /**
   * The order is finished, so the estimate is history rather than a promise.
   * Kept separate because "25m late" about food already eaten is a
   * complaint, not information.
   */
  | { kind: 'DONE'; at: Date };

export function promiseState(
  etaAt: Date | null,
  isLive: boolean,
  now: Date,
): PromiseState {
  if (etaAt === null) return { kind: 'NONE' };
  if (!isLive) return { kind: 'DONE', at: etaAt };
  const lateSeconds = lateBySeconds(etaAt, now);
  return lateSeconds === null
    ? { kind: 'DUE', at: etaAt }
    : { kind: 'OVERDUE', at: etaAt, lateSeconds };
}

/**
 * The sentence for the header, or null when there is nothing to say.
 *
 * Takes its formatter so this module stays pure and the screen keeps its own
 * locale.
 *
 * OVERDUE deliberately does NOT apologise or promise a new time. It has
 * neither to give: nothing in the app knows why an order is late or when it
 * will arrive, and a screen that guessed would be inventing both. Saying the
 * plain fact, and putting the help link within reach, is the honest floor.
 */
export function describePromise(
  state: PromiseState,
  formatTime: (date: Date) => string,
): string | null {
  switch (state.kind) {
    case 'NONE':
    case 'DONE':
      return null;
    case 'DUE':
      return `Arriving by ${formatTime(state.at)}`;
    case 'OVERDUE':
      return `Was due at ${formatTime(state.at)} — ${formatLate(
        state.lateSeconds,
      )}`;
  }
}

/** Whether the header should read as a problem rather than as information. */
export function promiseIsOverdue(state: PromiseState): boolean {
  return state.kind === 'OVERDUE';
}

// -----------------------------------------------------------------------------
// Stamping a moment
// -----------------------------------------------------------------------------

/**
 * Whether two moments fall on the same day, according to the caller's idea of
 * a day.
 *
 * `dayKey` is passed in rather than computed here, and that is the whole
 * lesson of this module's second bug: the first version used
 * `getFullYear/getMonth/getDate`, which are the HOST's calendar. On a UTC
 * container an order placed 23:50 and delivered 00:20 Manila time is one UTC
 * day, so the crossing this function exists to find was invisible. See
 * `lib/time/manila`.
 */
export function sameDay(
  a: Date,
  b: Date,
  dayKey: (date: Date) => string,
): boolean {
  return dayKey(a) === dayKey(b);
}

/**
 * Whether a timeline entry needs its date shown.
 *
 * True for the first entry that is not from today, and for any entry that
 * starts a new day within the list. So a live order tracked this afternoon is
 * a column of bare times, and an order that crossed midnight says so exactly
 * where it crossed — which is the only place the reader needs telling.
 */
export function needsDate(
  at: Date,
  previous: Date | null,
  now: Date,
  dayKey: (date: Date) => string,
): boolean {
  if (previous === null) return !sameDay(at, now, dayKey);
  return !sameDay(at, previous, dayKey);
}
