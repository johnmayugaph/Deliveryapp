import { OrderStatus } from '@prisma/client';

/**
 * What the shop's own reporting screens count, and over how long.
 *
 * Two screens report on the same orders — *Regulars* and *History* — and until
 * this module existed they disagreed twice over, silently.
 *
 * **They covered different periods.** Regulars asked for ninety days of
 * completed orders. History asked for the most recent fifty orders of any
 * finished status, with no date bound at all. Both then reported "what TARA
 * absorbed on this shop's orders", and a shop comparing the two figures had no
 * way to know they were answers to different questions. Neither screen said
 * what period it covered.
 *
 * **And History counted orders nobody absorbed anything on.** Settlement
 * accrues inside the completion transaction and nowhere else, so `COMPLETED`
 * is the only status on which TARA has actually paid for a discount. History
 * summed every finished order, cancelled and expired ones included — so a
 * cancelled order that had a promo code on it added to the total, and its own
 * row read "Customer paid ₱50 less — TARA covered it" about an order the
 * customer paid nothing for and which was refunded in full.
 *
 * Pure: the enum and nothing else.
 */

/**
 * How far back the shop's reporting screens look.
 *
 * Ninety days because that is the window the tier standing was already
 * computed over, and because it is long enough that a quiet fortnight does not
 * make a shop's numbers look like a collapse. One constant, imported by both,
 * rather than a number written down twice.
 */
export const REPORT_WINDOW_DAYS = 90;

export function reportWindowStart(now: Date, windowDays = REPORT_WINDOW_DAYS): Date {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
}

/**
 * The statuses on which TARA has really absorbed a discount.
 *
 * An array rather than a bare comparison so the database filter and the
 * in-memory predicate below cannot drift: the query filters on this, and the
 * screen decides per row with `absorbedCountsFor`, and they are the same list.
 *
 * It is `COMPLETED` alone, and that is not an oversight about the other
 * terminal statuses. `accrueOrderSettlement` is called from exactly one place
 * — the completion path in `orders/maintenance.ts` — so an order that was
 * cancelled, expired or failed has no settlement entry, no commission taken
 * and no discount paid for by anybody. Its refund went back to where the money
 * came from.
 */
export const SETTLED_STATUSES: readonly OrderStatus[] = [OrderStatus.COMPLETED];

/** Whether this order is one TARA actually paid a discount on. */
export function absorbedCountsFor(status: OrderStatus): boolean {
  return SETTLED_STATUSES.includes(status);
}

/**
 * The sentence naming the period, so a figure is never a number with no
 * question attached.
 */
export function windowNote(windowDays = REPORT_WINDOW_DAYS): string {
  if (windowDays === 1) return 'the last day';
  if (windowDays % 7 === 0 && windowDays < 60) {
    const weeks = windowDays / 7;
    return weeks === 1 ? 'the last week' : `the last ${weeks} weeks`;
  }
  return `the last ${windowDays} days`;
}

/**
 * How much of the window is on screen.
 *
 * Null when everything in the window is shown, which is the ordinary case for
 * a new shop and the case where saying anything would be noise. When the cap
 * bites it has to be said: a list that silently stops at fifty rows is a list
 * whose totals mean something different from what it looks like they mean.
 */
export function cappedNote(shown: number, totalInWindow: number): string | null {
  if (totalInWindow <= shown) return null;
  return `Showing the most recent ${shown} of ${totalInWindow}`;
}
