import type { PromoKind, ServiceKey } from '@prisma/client';

/**
 * Promo codes: the rules, with no database and no clock.
 *
 * ### What makes a promo code different from the other two code features
 *
 * A referral code belongs to one person and pays credits. A loyalty balance
 * belongs to one person and converts to credits. **A promo code is public.** It
 * goes on a tarpaulin, into a Facebook group, and round a group chat, and a
 * code meant for a hundred people is used by ten thousand within the hour.
 *
 * So the design is not about secrecy — a code somebody has to remember and say
 * out loud is guessable by construction. It is about bounds: how many orders it
 * may touch, how much it may cost in total, how much it may take off one order,
 * and who it applies to. Every one of those is a column, and every one of them
 * is checked here and again in the database.
 *
 * ### Three kinds, one number
 *
 * `PERCENTAGE`, `FIXED_AMOUNT` and `FREE_DELIVERY` all resolve to a single
 * centavos figure. That is deliberate: `Order.promoDiscountCentavos` and the
 * arithmetic in `applyBenefits` have existed since the first schema and handle
 * exactly one number, so nothing about the checkout needs a third case. It also
 * means a free-delivery code shows the customer a named discount line rather
 * than a delivery fee that mysteriously reads zero.
 *
 * ### Two classes of refusal, and why the messages differ
 *
 * A refusal about THIS ORDER — too small, wrong city, not your first — is
 * stated precisely, because the customer can act on it. "Spend ₱50 more" is
 * useful; "that code does not work" is not.
 *
 * A refusal about THE CODE ITSELF — unknown, expired, exhausted, switched off —
 * is answered uniformly, as "that code is not available". Not to be
 * unhelpful, but because distinguishing them turns the checkout field into an
 * oracle: try a hundred guesses and the different messages tell you which of
 * them are real codes that have merely run out. There is nothing a customer can
 * do differently with the distinction anyway.
 *
 * Pure: imports nothing but types.
 */

/** The most one order's promo discount may be. Mirrors the SQL guard. */
export const MAX_DISCOUNT_CENTAVOS = 500_000;

/** A code's rules. Structural, so a Prisma row passes straight in. */
export interface PromoFacts {
  id: string;
  code: string;
  label: string;
  kind: PromoKind;
  percentBasisPoints: number | null;
  amountCentavos: number | null;
  maxDiscountCentavos: number | null;
  minimumOrderCentavos: number;
  serviceTypes: readonly ServiceKey[];
  cityIds: readonly string[];
  storeId: string | null;
  firstOrderOnly: boolean;
  startsAt: Date;
  endsAt: Date;
  totalRedemptionLimit: number | null;
  perCustomerLimit: number;
  budgetCentavos: number | null;
  stacksWithSubscription: boolean;
  isActive: boolean;
}

/** The order being priced, as far as a promo cares. */
export interface PromoOrderFacts {
  serviceType: ServiceKey;
  cityId: string;
  storeId: string | null;
  subtotalCentavos: number;
  deliveryFeeCentavos: number;
}

/** What the customer's own history says. */
export interface PromoCustomerFacts {
  completedOrderCount: number;
  /** How many times THIS customer has already used THIS code. */
  timesUsed: number;
}

/** How the code has been used across everybody. Counted, never cached. */
export interface PromoUsageFacts {
  redemptions: number;
  spentCentavos: number;
}

/**
 * Refusals the customer can act on. Stated precisely.
 */
export type OrderRefusal =
  | 'ORDER_TOO_SMALL'
  | 'WRONG_SERVICE'
  | 'WRONG_CITY'
  | 'WRONG_STORE'
  | 'NOT_YOUR_FIRST_ORDER'
  | 'ALREADY_USED'
  | 'NOTHING_TO_DISCOUNT';

/**
 * Refusals about the code itself. Answered uniformly — see the note above on
 * why the checkout field must not become an oracle.
 */
export type CodeRefusal = 'UNAVAILABLE';

export type PromoRefusal = OrderRefusal | CodeRefusal;

export interface PromoQuote {
  /** Positive centavos to take off. Zero when refused. */
  discountCentavos: number;
  /** The code's own label, for the line on the bill. */
  label: string | null;
  refusal: PromoRefusal | null;
  /** False when the code says a subscription's benefits must be dropped. */
  stacksWithSubscription: boolean;
}

const REFUSED = (refusal: PromoRefusal): PromoQuote => ({
  discountCentavos: 0,
  label: null,
  refusal,
  stacksWithSubscription: true,
});

/**
 * The raw discount a kind implies, before the ceiling and before the bill.
 *
 * `FREE_DELIVERY` resolves to the fee itself, which is what makes three kinds
 * into one number.
 */
export function rawDiscountFor(
  promo: Pick<PromoFacts, 'kind' | 'percentBasisPoints' | 'amountCentavos'>,
  order: Pick<PromoOrderFacts, 'subtotalCentavos' | 'deliveryFeeCentavos'>,
): number {
  switch (promo.kind) {
    case 'PERCENTAGE':
      // Off the subtotal, not the total: a percentage of the delivery fee is a
      // percentage of the rider's money, and of surge, which is theirs too.
      return Math.floor(
        (order.subtotalCentavos * (promo.percentBasisPoints ?? 0)) / 10_000,
      );
    case 'FIXED_AMOUNT':
      return promo.amountCentavos ?? 0;
    case 'FREE_DELIVERY':
      return order.deliveryFeeCentavos;
  }
}

/**
 * Whether this code applies to this order for this customer, and for how much.
 *
 * Everything is checked in an order chosen so the message is the most useful
 * one: scope before amount, because "this code is for Manila" beats "spend ₱50
 * more" when the customer is in Cebu and can never qualify.
 *
 * `now` is a parameter because a code's window is the whole behaviour and a
 * rule that reads the clock cannot be tested at its edges.
 */
export function resolvePromo(input: {
  promo: PromoFacts;
  order: PromoOrderFacts;
  customer: PromoCustomerFacts;
  usage: PromoUsageFacts;
  now: Date;
}): PromoQuote {
  const { promo, order, customer, usage, now } = input;

  // --- About the code itself: one answer, for all of them. -----------------
  if (!promo.isActive) return REFUSED('UNAVAILABLE');
  if (now < promo.startsAt || now > promo.endsAt) return REFUSED('UNAVAILABLE');
  if (
    promo.totalRedemptionLimit !== null &&
    usage.redemptions >= promo.totalRedemptionLimit
  ) {
    return REFUSED('UNAVAILABLE');
  }

  // --- About this order: precise, because the customer can act on it. ------
  if (promo.serviceTypes.length > 0 && !promo.serviceTypes.includes(order.serviceType)) {
    return REFUSED('WRONG_SERVICE');
  }
  if (promo.cityIds.length > 0 && !promo.cityIds.includes(order.cityId)) {
    return REFUSED('WRONG_CITY');
  }
  if (promo.storeId !== null && promo.storeId !== order.storeId) {
    return REFUSED('WRONG_STORE');
  }
  if (promo.firstOrderOnly && customer.completedOrderCount > 0) {
    return REFUSED('NOT_YOUR_FIRST_ORDER');
  }
  if (customer.timesUsed >= promo.perCustomerLimit) {
    return REFUSED('ALREADY_USED');
  }
  if (order.subtotalCentavos < promo.minimumOrderCentavos) {
    return REFUSED('ORDER_TOO_SMALL');
  }

  // --- The amount, bounded three ways. ------------------------------------
  let discount = rawDiscountFor(promo, order);

  // The code's own per-order ceiling. Required for a percentage.
  if (promo.maxDiscountCentavos !== null) {
    discount = Math.min(discount, promo.maxDiscountCentavos);
  }
  // The hard ceiling, whatever a row says. Belt to the SQL guard's braces.
  discount = Math.min(discount, MAX_DISCOUNT_CENTAVOS);

  // What is left of the campaign budget. A code that would overspend gives
  // what remains rather than refusing outright — the customer gets something,
  // and the budget is still respected to the centavo.
  if (promo.budgetCentavos !== null) {
    discount = Math.min(discount, Math.max(0, promo.budgetCentavos - usage.spentCentavos));
  }

  // Never more than the order is worth. `applyBenefits` clamps the combined
  // discounts to the gross as well, but arriving there with a promo bigger
  // than the bill would let the clamp silently eat a subscription's benefit
  // instead — which is the one thing that function is careful not to do.
  discount = Math.min(discount, order.subtotalCentavos + order.deliveryFeeCentavos);

  if (discount <= 0) return REFUSED('NOTHING_TO_DISCOUNT');

  return {
    discountCentavos: discount,
    label: promo.label,
    refusal: null,
    stacksWithSubscription: promo.stacksWithSubscription,
  };
}

/**
 * What the customer is told.
 *
 * The order-specific ones name the thing to change. The code one says nothing
 * about which of four reasons applies, on purpose.
 */
export const REFUSAL_TEXT: Readonly<Record<PromoRefusal, string>> = {
  UNAVAILABLE: 'That code is not available.',
  ORDER_TOO_SMALL: 'Your order is below the minimum for that code.',
  WRONG_SERVICE: 'That code is not for this kind of order.',
  WRONG_CITY: 'That code is not being used in this city.',
  WRONG_STORE: 'That code only works at another shop.',
  NOT_YOUR_FIRST_ORDER: 'That code is for a first order only.',
  ALREADY_USED: 'You have already used that code.',
  NOTHING_TO_DISCOUNT: 'That code has nothing left to give on this order.',
};

/**
 * Tidies a code somebody typed.
 *
 * Uppercase and trimmed, with internal whitespace removed — people type
 * "TARA 50" for TARA50 — and nothing else. Unlike a referral code there is no
 * fixed alphabet to strip against, because marketing picks these and a code
 * containing a digit, a letter and a hyphen is perfectly reasonable. So the
 * lookup either finds it or does not.
 */
export function normalisePromoCode(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, '').slice(0, 40);
}

/** Whether a normalised code is worth a database round trip at all. */
export function codeLooksPlausible(code: string): boolean {
  return code.length >= 3 && code.length <= 40 && /^[A-Z0-9-]+$/.test(code);
}

// --- What the checkout screen shows ------------------------------------------

/**
 * What to say about a code, once the server has priced the order with it.
 *
 * There are FOUR states, not two, and the fourth is the one worth naming: a
 * code can be perfectly valid, offer a real discount, and still take nothing
 * off — because it refuses to stack and the customer's own plan saved them
 * more, so `bestOutcome` kept the plan and left the code unspent. Without a
 * name for that the screen shows an accepted code and no discount line, which
 * reads as the app having lost the code.
 *
 * A function rather than a chain of ternaries in JSX, so the four states are
 * enumerable and testable.
 */
export type PromoDisplay =
  | { kind: 'none' }
  | { kind: 'accepted'; discountCentavos: number }
  | { kind: 'refused'; refusal: PromoRefusal }
  | { kind: 'outbid'; offeredCentavos: number };

export function promoDisplay(input: {
  code: string;
  refusal: PromoRefusal | null;
  /** What the code itself offered. */
  offeredCentavos: number;
  /** What actually came off the bill. */
  appliedCentavos: number;
}): PromoDisplay {
  if (input.code.length === 0) return { kind: 'none' };
  if (input.refusal !== null) return { kind: 'refused', refusal: input.refusal };
  if (input.appliedCentavos > 0) {
    return { kind: 'accepted', discountCentavos: input.appliedCentavos };
  }
  if (input.offeredCentavos > 0) {
    return { kind: 'outbid', offeredCentavos: input.offeredCentavos };
  }
  // A code that resolved with no refusal and no money is not reachable through
  // `resolvePromo` — it returns NOTHING_TO_DISCOUNT instead. Answered anyway
  // rather than left to fall through, because a future caller assembling this
  // by hand should get silence and not a discount line reading zero.
  return { kind: 'none' };
}

// --- What a campaign is exposed to -------------------------------------------

/**
 * The cheapest order this code makes free.
 *
 * The promo equivalent of `farmerMargin` on the referral screen, and the
 * number an operator setting up a campaign almost never works out: a ₱100 code
 * with no minimum order means somebody buys ₱90 of food for nothing, and we
 * still pay the shop and the rider in full. Codes are public and phone numbers
 * are cheap, so "one per customer" bounds nothing.
 *
 * `resolvePromo` already stops the TOTAL going below zero, which is why this
 * is not a correctness bug and is easy to miss — the order goes through, the
 * arithmetic is right, and the money is gone.
 *
 * A percentage can only cover the food at 100%, so the usual shape of this
 * mistake is a fixed amount with a minimum somebody forgot to raise.
 */
export interface PromoGiveaway {
  /** The most this code can take off one order, or null when it only touches the fee. */
  perOrderCentavos: number | null;
  /** True when the smallest qualifying order could be entirely covered. */
  coversTheFood: boolean;
  /** The smallest order the code applies to, for the sentence that explains it. */
  smallestOrderCentavos: number;
}

export function giveawayFor(
  promo: Pick<
    PromoFacts,
    'kind' | 'percentBasisPoints' | 'amountCentavos' | 'maxDiscountCentavos' | 'minimumOrderCentavos'
  >,
): PromoGiveaway {
  // An order has to be worth at least a centavo, so a minimum of zero does not
  // mean "no order qualifies" — it means the smallest one does.
  const smallestOrderCentavos = Math.max(promo.minimumOrderCentavos, 1);

  switch (promo.kind) {
    case 'FREE_DELIVERY':
      // Bounded by the fee, which depends on the distance, so there is no
      // per-order figure to state. It never touches the food.
      return { perOrderCentavos: null, coversTheFood: false, smallestOrderCentavos };

    case 'FIXED_AMOUNT': {
      const perOrderCentavos = promo.amountCentavos ?? 0;
      return {
        perOrderCentavos,
        coversTheFood: perOrderCentavos >= smallestOrderCentavos,
        smallestOrderCentavos,
      };
    }

    case 'PERCENTAGE': {
      const ceiling = promo.maxDiscountCentavos ?? 0;
      const basisPoints = promo.percentBasisPoints ?? 0;
      return {
        perOrderCentavos: ceiling,
        // Below 100% the discount is always smaller than the order it came
        // off, whatever the ceiling. At or above it, the ceiling decides.
        coversTheFood: basisPoints >= 10_000 && ceiling >= smallestOrderCentavos,
        smallestOrderCentavos,
      };
    }
  }
}

export interface PromoExposure {
  /** The most this code can still cost, from here. */
  remainingCentavos: number | null;
  /** Redemptions still available. */
  remainingRedemptions: number | null;
  /** True when nothing bounds the total cost. */
  unbounded: boolean;
}

/**
 * What a code can still cost.
 *
 * For the console, and the reason it exists: a campaign's danger is not the
 * discount on one order, it is the number of orders. A ₱50 code with no total
 * limit and no budget is an open cheque, and the screen should say so in those
 * terms rather than showing a redemption count and leaving the arithmetic to
 * somebody at the end of the month.
 */
export function exposureFor(
  promo: Pick<
    PromoFacts,
    'totalRedemptionLimit' | 'budgetCentavos' | 'maxDiscountCentavos' | 'amountCentavos'
  >,
  usage: PromoUsageFacts,
): PromoExposure {
  const perOrder = promo.maxDiscountCentavos ?? promo.amountCentavos ?? null;

  const byBudget =
    promo.budgetCentavos === null
      ? null
      : Math.max(0, promo.budgetCentavos - usage.spentCentavos);

  const remainingRedemptions =
    promo.totalRedemptionLimit === null
      ? null
      : Math.max(0, promo.totalRedemptionLimit - usage.redemptions);

  const byCount =
    remainingRedemptions === null || perOrder === null
      ? null
      : remainingRedemptions * perOrder;

  const bounds = [byBudget, byCount].filter((value): value is number => value !== null);

  return {
    remainingCentavos: bounds.length > 0 ? Math.min(...bounds) : null,
    remainingRedemptions,
    // A free-delivery code with no budget and no limit has no bound at all,
    // because even the per-order figure depends on the distance.
    unbounded: bounds.length === 0,
  };
}
