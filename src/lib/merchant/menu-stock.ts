/**
 * What on a menu a customer cannot order right now, and for how long.
 *
 * Two gaps this closes, both of the same shape: the app knew and the shop did
 * not.
 *
 * **Nothing ever put a dish back.** The only writer of `MenuItem.isAvailable`
 * is a manual tap, so the out-of-stock switch is an 8pm decision with no 6am
 * undo. The label on it reads "Wala ngayon" — *not now* — which is a claim
 * about tonight that can be six weeks old, and there was no way to tell the
 * difference. Over a few busy Saturdays a shop's menu quietly shrinks to
 * nothing, one forgotten dish at a time.
 *
 * **A dish can be in stock and still impossible to order.** A required option
 * group whose answers have all run out — "pick a size" with both sizes marked
 * out — cannot be answered, so checkout refuses the dish. `groupIsSatisfiable`
 * has always said so, and it was rendered only on the per-dish options
 * sub-page, one tap deeper than the list and behind a link a shop opens on
 * purpose. On the list the dish read "In stock" in emerald.
 *
 * Pure: takes rows and a clock, imports nothing.
 */

/** Every way a dish on the menu is not sellable right now. */
export type UnsellableReason = 'MARKED_OUT' | 'CHOICES_RUN_OUT';

export interface ReasonCopy {
  /** On the row, beside the dish. Short — it sits under the name. */
  badge: string;
  /** What it means, for the summary above the list. */
  detail: string;
  /**
   * True when this is the shop's own deliberate switch.
   *
   * The distinction the screen turns on: a dish somebody marked out at eight
   * is a decision, and a dish nobody can order because its sizes ran out is a
   * surprise. Only the second one deserves a warning.
   */
  isTheShopsChoice: boolean;
}

/** Compile-enforced, so a third way to be unsellable forces both decisions. */
export const UNSELLABLE_REASONS: Readonly<Record<UnsellableReason, ReasonCopy>> = {
  MARKED_OUT: {
    badge: 'Wala ngayon',
    detail: 'marked out of stock',
    isTheShopsChoice: true,
  },
  CHOICES_RUN_OUT: {
    badge: 'Cannot be ordered',
    detail: 'in stock, but a required choice has run out',
    isTheShopsChoice: false,
  },
};

/**
 * How long a dish has been out, in the terms a shop thinks in.
 *
 * `TONIGHT` is the case the switch was built for. `FORGOTTEN` is the case it
 * was not: nobody decides to stop selling adobo for three weeks, so past a
 * point this stops being stock and starts being a menu that needs editing.
 */
export type OutFor = 'TONIGHT' | 'DAYS' | 'FORGOTTEN' | 'UNKNOWN';

/** A day is the boundary because the decision it models is a service. */
const HOURS = 60 * 60 * 1000;
export const FORGOTTEN_AFTER_DAYS = 14;

export function outFor(since: Date | null, now: Date): OutFor {
  // No timestamp at all: rows that were already out when the column was added.
  // "We do not know when" is the honest answer and not the same as "just now".
  if (since === null) return 'UNKNOWN';
  const elapsed = now.getTime() - since.getTime();
  if (elapsed < 24 * HOURS) return 'TONIGHT';
  if (elapsed < FORGOTTEN_AFTER_DAYS * 24 * HOURS) return 'DAYS';
  return 'FORGOTTEN';
}

/** Whole days, floored, for the phrase on the row. */
export function daysOut(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / (24 * HOURS)));
}

/**
 * The phrase after the badge: "since this morning", "3 days", "3 weeks".
 *
 * Weeks past a fortnight because "19 days" is a number a person has to convert
 * and "nearly 3 weeks" is one they react to.
 */
export function outForPhrase(since: Date | null, now: Date): string | null {
  const bucket = outFor(since, now);
  if (bucket === 'UNKNOWN') return null;
  if (bucket === 'TONIGHT') return 'since today';
  const days = daysOut(since!, now);
  if (days < 14) return `${days} days`;
  const weeks = Math.floor(days / 7);
  return `${weeks} weeks`;
}

export interface StockItemLike {
  id: string;
  name: string;
  isAvailable: boolean;
  outOfStockSince: Date | null;
  /**
   * Required option groups that cannot currently be answered, by name.
   *
   * Names rather than a count, because the row says which one: "Size has run
   * out" is actionable and "1 choice has run out" is a puzzle.
   */
  unsatisfiableGroupNames: readonly string[];
}

export interface ItemStock {
  id: string;
  name: string;
  reason: UnsellableReason | null;
  /** Only meaningful for `MARKED_OUT`. */
  outFor: OutFor;
  phrase: string | null;
  /** Only meaningful for `CHOICES_RUN_OUT`. */
  blockedByGroups: readonly string[];
  sellable: boolean;
}

/**
 * One dish's state.
 *
 * `MARKED_OUT` wins over `CHOICES_RUN_OUT` when both apply: the shop's own
 * switch is the fact they acted on and the one they will act on again, and
 * telling them a dish they deliberately took off also has an add-on problem is
 * noise until they put it back.
 */
export function itemStock(item: StockItemLike, now: Date): ItemStock {
  const base = { id: item.id, name: item.name };
  if (!item.isAvailable) {
    return {
      ...base,
      reason: 'MARKED_OUT',
      outFor: outFor(item.outOfStockSince, now),
      phrase: outForPhrase(item.outOfStockSince, now),
      blockedByGroups: [],
      sellable: false,
    };
  }
  if (item.unsatisfiableGroupNames.length > 0) {
    return {
      ...base,
      reason: 'CHOICES_RUN_OUT',
      outFor: 'UNKNOWN',
      phrase: null,
      blockedByGroups: item.unsatisfiableGroupNames,
      sellable: false,
    };
  }
  return {
    ...base,
    reason: null,
    outFor: 'UNKNOWN',
    phrase: null,
    blockedByGroups: [],
    sellable: true,
  };
}

export interface MenuStock {
  items: ItemStock[];
  /** How many a customer could actually order. */
  sellable: number;
  /** Marked out by the shop — the ones the restore control puts back. */
  markedOut: number;
  /** Marked out long enough that it reads as forgotten rather than decided. */
  forgotten: number;
  /** In stock and unorderable. The silent one. */
  choicesRunOut: number;
}

export function menuStock(
  items: readonly StockItemLike[],
  now: Date,
): MenuStock {
  const states = items.map((item) => itemStock(item, now));
  return {
    items: states,
    sellable: states.filter((state) => state.sellable).length,
    markedOut: states.filter((state) => state.reason === 'MARKED_OUT').length,
    forgotten: states.filter(
      (state) => state.reason === 'MARKED_OUT' && state.outFor === 'FORGOTTEN',
    ).length,
    choicesRunOut: states.filter((state) => state.reason === 'CHOICES_RUN_OUT')
      .length,
  };
}

/**
 * The line above the list.
 *
 * Leads with what a customer can order rather than with how many rows exist,
 * because that is the number that decides whether the shop gets an order. The
 * old line read "11 items · 4 out of stock", which counted rows and said
 * nothing about the dishes that were in stock and unorderable.
 */
export function describeStock(stock: MenuStock, total: number): string {
  if (total === 0) return 'Nothing on the menu yet';
  const parts = [`${stock.sellable} of ${total} orderable`];
  if (stock.markedOut > 0) parts.push(`${stock.markedOut} out of stock`);
  if (stock.choicesRunOut > 0) {
    parts.push(
      stock.choicesRunOut === 1
        ? '1 blocked by a missing choice'
        : `${stock.choicesRunOut} blocked by missing choices`,
    );
  }
  return parts.join(' · ');
}

/**
 * The warning worth interrupting the screen with, or null.
 *
 * Two cases, and neither is "you have things out of stock" — a kitchen knows
 * that. It is the ones nobody decided: a dish that has been out for a
 * fortnight, and a dish that looks fine and cannot be ordered.
 */
export interface StockWarning {
  reason: UnsellableReason;
  count: number;
  line: string;
}

export function stockWarnings(stock: MenuStock): StockWarning[] {
  const warnings: StockWarning[] = [];
  if (stock.choicesRunOut > 0) {
    const one = stock.choicesRunOut === 1;
    warnings.push({
      reason: 'CHOICES_RUN_OUT',
      count: stock.choicesRunOut,
      line: one
        ? 'One dish is in stock but cannot be ordered: a choice it requires has run out.'
        : `${stock.choicesRunOut} dishes are in stock but cannot be ordered: a choice each one requires has run out.`,
    });
  }
  if (stock.forgotten > 0) {
    const one = stock.forgotten === 1;
    warnings.push({
      reason: 'MARKED_OUT',
      count: stock.forgotten,
      line: one
        ? `One dish has been out of stock for over ${FORGOTTEN_AFTER_DAYS} days. Put it back, or take it off the menu.`
        : `${stock.forgotten} dishes have been out of stock for over ${FORGOTTEN_AFTER_DAYS} days. Put them back, or take them off the menu.`,
    });
  }
  return warnings;
}
