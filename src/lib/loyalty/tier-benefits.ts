import { BenefitType, TierBenefitType, type ServiceKey } from '@prisma/client';

/**
 * What a loyalty tier confers: the rules, with no database and no clock.
 *
 * ### What changed, and why the old comment was right anyway
 *
 * `policy.ts` used to say a tier changes the earn rate and nothing else, and
 * argued at length against making Tapat waive delivery: this app already has
 * three ways to reduce a bill, each interacting with the others inside
 * `applyBenefits`, and a fourth would put loyalty arithmetic in the checkout
 * path where a bug costs somebody the wrong price.
 *
 * That argument was about a FOURTH MECHANISM, and it still holds. What this
 * module does instead is give a tier a second way to qualify for the mechanism
 * that already exists. A `LoyaltyTierBenefit` of type FREE_DELIVERY carries
 * the same columns as a `SubscriptionBenefit` of type FREE_DELIVERY and is
 * priced by the same function, so there is one implementation of "free
 * delivery over ₱300, four times a month" and one place a bug in it can be.
 *
 * ### Two families, one enum
 *
 * Three of the six types are bill benefits and map onto `BenefitType`. The
 * other three touch no bill and are read at exactly one seam each:
 *
 *   DISPATCH_PRIORITY    the fan-out's ordering, `lib/fleet/dispatch-offers.ts`
 *   SUPPORT_PRIORITY     the ticket queue's ordering, `lib/support/queries.ts`
 *   POINTS_NEVER_EXPIRE  the expiry stamped on an earned point, `earning.ts`
 *
 * `billBenefitTypeFor` is the boundary between the families and is compile
 * enforced over all six, so a seventh type cannot be added without deciding
 * which side of it the new one falls on.
 *
 * Pure: imports nothing but types.
 */

/** Basis points, so `10000` is 1.0. */
const BASIS = 10_000;

/**
 * The most a tier discount may be, in basis points.
 *
 * Mirrors `loyalty_tier_benefit_sane` in `prisma/sql/loyalty_tiers.sql`; a
 * test asserts they agree. 50% — above anything a status band should hand out,
 * and low enough that a mistyped 5000 for 500 is caught rather than charged.
 */
export const MAX_TIER_PERCENT_BASIS_POINTS = 5_000;

/**
 * The most a tier may jump the queue by.
 *
 * Also mirrored in SQL. The unit is minutes of apparent age — see
 * `dispatchPriorityFor` — so 100 is the ceiling on how much earlier a suki's
 * order can look than it is. A weight in the thousands would be a suki always
 * first however long anybody else had waited, which is not a loyalty benefit
 * but a different queue.
 */
export const MAX_TIER_PRIORITY_WEIGHT = 100;

/** The structural shape of a tier benefit row. */
export interface TierBenefitFacts {
  id: string;
  type: TierBenefitType;
  serviceKeys: readonly ServiceKey[];
  percentBasisPoints: number | null;
  minimumOrderCentavos: number | null;
  monthlyUsageCap: number | null;
  maxDiscountCentavos: number | null;
  monthlyCeilingCentavos: number | null;
  priorityWeight: number | null;
  displayLabel: string;
  sortOrder: number;
}

// --- The boundary between the two families ----------------------------------

/**
 * The `BenefitType` this tier benefit is priced as, or null when it is a perk.
 *
 * The one function that decides which family a type belongs to. Everything
 * else asks this rather than listing types itself, so the split lives in one
 * place and a new type has to be classified here to compile.
 */
export function billBenefitTypeFor(
  type: TierBenefitType,
): BenefitType | null {
  switch (type) {
    case TierBenefitType.FREE_DELIVERY:
      return BenefitType.FREE_DELIVERY;
    case TierBenefitType.DISCOUNT_PERCENT:
      return BenefitType.DISCOUNT_PERCENT;
    case TierBenefitType.CREDIT_BACK_PERCENT:
      return BenefitType.CREDIT_BACK_PERCENT;
    case TierBenefitType.DISPATCH_PRIORITY:
    case TierBenefitType.SUPPORT_PRIORITY:
    case TierBenefitType.POINTS_NEVER_EXPIRE:
      return null;
  }
}

/** True when this type costs money on a bill. */
export function isBillBenefit(type: TierBenefitType): boolean {
  return billBenefitTypeFor(type) !== null;
}

/**
 * Which columns each type actually uses.
 *
 * Compile-enforced over every type, and the shape
 * `loyalty_tier_benefit_columns_match_type` checks in SQL — a test walks both
 * and asserts they agree, because a guard that disagrees with the code refuses
 * rows the app would have handled and vice versa.
 */
export const TIER_BENEFIT_COLUMNS: Readonly<
  Record<TierBenefitType, readonly (keyof TierBenefitFacts)[]>
> = {
  [TierBenefitType.FREE_DELIVERY]: ['minimumOrderCentavos', 'monthlyUsageCap'],
  [TierBenefitType.DISCOUNT_PERCENT]: [
    'percentBasisPoints',
    'serviceKeys',
    'maxDiscountCentavos',
  ],
  [TierBenefitType.CREDIT_BACK_PERCENT]: [
    'percentBasisPoints',
    'monthlyCeilingCentavos',
  ],
  [TierBenefitType.DISPATCH_PRIORITY]: ['priorityWeight'],
  [TierBenefitType.SUPPORT_PRIORITY]: ['priorityWeight'],
  [TierBenefitType.POINTS_NEVER_EXPIRE]: [],
};

/**
 * A row carries what its type needs.
 *
 * The same posture as `isBenefitUsable` for a plan's benefits: a misconfigured
 * row is SKIPPED rather than thrown on, because a bad entry in the console
 * must not take checkout down for everybody. The database refuses to write one
 * (guard 1), so this is the belt to that braces — it catches rows written
 * before the guard existed, and rows in a database somebody applied the
 * migration to without the guards.
 */
export function isTierBenefitUsable(
  benefit: Pick<
    TierBenefitFacts,
    'type' | 'percentBasisPoints' | 'minimumOrderCentavos' | 'priorityWeight'
  >,
): boolean {
  switch (benefit.type) {
    case TierBenefitType.FREE_DELIVERY:
      return benefit.minimumOrderCentavos !== null;
    case TierBenefitType.DISCOUNT_PERCENT:
    case TierBenefitType.CREDIT_BACK_PERCENT:
      return (
        benefit.percentBasisPoints !== null && benefit.percentBasisPoints > 0
      );
    case TierBenefitType.DISPATCH_PRIORITY:
    case TierBenefitType.SUPPORT_PRIORITY:
      return benefit.priorityWeight !== null && benefit.priorityWeight >= 1;
    case TierBenefitType.POINTS_NEVER_EXPIRE:
      // Nothing to configure, so nothing to get wrong.
      return true;
  }
}

// --- The bill family --------------------------------------------------------

/**
 * The shape `applyBenefits` reads, which both kinds of benefit row satisfy.
 *
 * This is what makes one pricing engine serve both. `id` is opaque to the
 * engine, `type` is the shared enum, and every other field is a column both
 * tables have under the same name.
 */
export interface BenefitLike {
  id: string;
  type: BenefitType;
  serviceKeys: readonly ServiceKey[];
  percentBasisPoints: number | null;
  minimumOrderCentavos: number | null;
  monthlyUsageCap: number | null;
  maxDiscountCentavos: number | null;
  monthlyCeilingCentavos: number | null;
  displayLabel: string;
  sortOrder: number;
}

/**
 * A tier's bill benefits, in the shape the pricing engine reads.
 *
 * Perks are dropped and unusable rows are dropped. What comes back can be
 * concatenated with a plan's benefits and handed straight to `applyBenefits`.
 */
export function billBenefitsOf(
  benefits: readonly TierBenefitFacts[],
): BenefitLike[] {
  const out: BenefitLike[] = [];
  for (const benefit of benefits) {
    const type = billBenefitTypeFor(benefit.type);
    if (type === null) continue;
    if (!isTierBenefitUsable(benefit)) continue;
    out.push({
      id: benefit.id,
      type,
      serviceKeys: benefit.serviceKeys,
      percentBasisPoints: benefit.percentBasisPoints,
      minimumOrderCentavos: benefit.minimumOrderCentavos,
      monthlyUsageCap: benefit.monthlyUsageCap,
      maxDiscountCentavos: benefit.maxDiscountCentavos,
      monthlyCeilingCentavos: benefit.monthlyCeilingCentavos,
      displayLabel: benefit.displayLabel,
      sortOrder: benefit.sortOrder,
    });
  }
  return out;
}

// --- The perk family --------------------------------------------------------

/** The perk row of this type on a tier, if it has a usable one. */
export function perkOf(
  benefits: readonly TierBenefitFacts[],
  type: TierBenefitType,
): TierBenefitFacts | null {
  return (
    benefits.find(
      (benefit) => benefit.type === type && isTierBenefitUsable(benefit),
    ) ?? null
  );
}

/**
 * How much earlier a tier's order should LOOK to the dispatch fan-out, in
 * minutes.
 *
 * Expressed as apparent age rather than as a sort key, and that is the whole
 * design. The fan-out orders waiting orders oldest first; a priority weight
 * subtracts minutes from a suki's placement time, so their order is offered
 * ahead of things placed in the last `weight` minutes and behind anything
 * older than that.
 *
 * Which means the benefit **cannot starve anybody**. A stranger's order that
 * has waited an hour still goes first, however loyal the other customer is.
 * The alternative — a boolean that sorts every suki above every non-suki —
 * would mean a busy Friday in which somebody's dinner is never offered at all
 * while sukis keep arriving, and no operator would see it happen.
 *
 * Zero when the tier has no such perk, which is also what a null tier gets.
 */
export function dispatchPriorityFor(
  benefits: readonly TierBenefitFacts[],
): number {
  const perk = perkOf(benefits, TierBenefitType.DISPATCH_PRIORITY);
  if (perk === null) return 0;
  return Math.min(
    MAX_TIER_PRIORITY_WEIGHT,
    Math.max(0, perk.priorityWeight ?? 0),
  );
}

/**
 * The same idea for the support queue, in minutes of apparent age.
 *
 * Support has the sharper version of the starvation problem, because a ticket
 * is a person waiting for an answer rather than a meal that will arrive
 * eventually either way. Same bound, same reason.
 */
export function supportPriorityFor(
  benefits: readonly TierBenefitFacts[],
): number {
  const perk = perkOf(benefits, TierBenefitType.SUPPORT_PRIORITY);
  if (perk === null) return 0;
  return Math.min(
    MAX_TIER_PRIORITY_WEIGHT,
    Math.max(0, perk.priorityWeight ?? 0),
  );
}

/**
 * When an order should be treated as having been placed, for queue ordering.
 *
 * Pure and exported so the BOUND can be tested rather than asserted about the
 * source. An earlier version of this arithmetic lived inside a closure in the
 * fan-out and was guarded by a test matching `* 60_000` in the file — which
 * happily matched a mutant that had changed it to `* 60_000_000_000`, turning
 * a few minutes of head start into "sukis always first". The property that
 * matters is numeric, so it is checked numerically:
 *
 *     the shift is exactly `boostMinutes` minutes, and boostMinutes is bounded
 *
 * Used by the dispatch fan-out; the support queue does the same thing in
 * minutes-of-waiting rather than timestamps, and shares the same bound.
 */
export function effectiveQueueTime(
  placedAt: Date,
  boostMinutes: number,
): number {
  const bounded = Math.min(
    MAX_TIER_PRIORITY_WEIGHT,
    Math.max(0, Math.floor(boostMinutes)),
  );
  return placedAt.getTime() - bounded * 60_000;
}

/** True when points earned at this tier are stamped with no expiry. */
export function pointsNeverExpireAt(
  benefits: readonly TierBenefitFacts[],
): boolean {
  return perkOf(benefits, TierBenefitType.POINTS_NEVER_EXPIRE) !== null;
}

// --- Words -------------------------------------------------------------------

/**
 * What each type is called on a screen, compile-enforced over every type.
 *
 * Written for the CUSTOMER, since that is where they mostly appear. The
 * console shows the same words so that an operator configuring a benefit reads
 * what the person receiving it will read.
 */
export const TIER_BENEFIT_NAME: Readonly<Record<TierBenefitType, string>> = {
  [TierBenefitType.FREE_DELIVERY]: 'Free delivery',
  [TierBenefitType.DISCOUNT_PERCENT]: 'Discount on the food',
  [TierBenefitType.CREDIT_BACK_PERCENT]: 'Credits back',
  [TierBenefitType.DISPATCH_PRIORITY]: 'Your order goes out first',
  [TierBenefitType.SUPPORT_PRIORITY]: 'Answered first',
  [TierBenefitType.POINTS_NEVER_EXPIRE]: 'Your points never expire',
};

/**
 * The sentence a customer reads under it, from the row's own numbers.
 *
 * Never the `displayLabel`. That column is what an operator typed and may say
 * anything; this is generated from the columns the arithmetic actually uses,
 * so the promise on the screen cannot drift from the rule. The label is shown
 * as the heading and this as the detail — if they disagree, the operator can
 * see that they disagree.
 */
export function describeTierBenefit(
  benefit: TierBenefitFacts,
  format: (centavos: number) => string,
): string {
  switch (benefit.type) {
    case TierBenefitType.FREE_DELIVERY: {
      const minimum = benefit.minimumOrderCentavos ?? 0;
      const over =
        minimum > 0 ? ` on orders over ${format(minimum)}` : ' on any order';
      const cap = benefit.monthlyUsageCap;
      return cap === null
        ? `No delivery fee${over}, as often as you like.`
        : `No delivery fee${over}, ${cap} ${cap === 1 ? 'time' : 'times'} a month.`;
    }
    case TierBenefitType.DISCOUNT_PERCENT: {
      const percent = ((benefit.percentBasisPoints ?? 0) / 100).toFixed(2);
      const cap = benefit.maxDiscountCentavos;
      const scope =
        benefit.serviceKeys.length === 0
          ? ''
          : ` on ${benefit.serviceKeys.join(', ').toLowerCase()}`;
      return cap === null
        ? `${percent}% off the food${scope}, every order.`
        : `${percent}% off the food${scope}, up to ${format(cap)} an order.`;
    }
    case TierBenefitType.CREDIT_BACK_PERCENT: {
      const percent = ((benefit.percentBasisPoints ?? 0) / 100).toFixed(2);
      const ceiling = benefit.monthlyCeilingCentavos;
      const base = `${percent}% of what you pay comes back as credits`;
      return ceiling === null
        ? `${base}, with no monthly limit.`
        : `${base}, up to ${format(ceiling)} a month.`;
    }
    case TierBenefitType.DISPATCH_PRIORITY: {
      const minutes = benefit.priorityWeight ?? 0;
      return (
        `When riders are scarce your order is offered ahead of ones placed ` +
        `in the last ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. ` +
        'Somebody who has waited longer than that still goes first.'
      );
    }
    case TierBenefitType.SUPPORT_PRIORITY: {
      const minutes = benefit.priorityWeight ?? 0;
      return (
        `Your message is answered ahead of ones sent in the last ${minutes} ` +
        `${minutes === 1 ? 'minute' : 'minutes'}. Somebody who has been ` +
        'waiting longer than that still goes first.'
      );
    }
    case TierBenefitType.POINTS_NEVER_EXPIRE:
      return 'Points you earn while you are at this tier never expire.';
  }
}

// --- What it costs -----------------------------------------------------------

export interface TierGiveback {
  /**
   * The bill benefits' worst case on ONE order, in centavos, given a
   * representative order.
   *
   * Worst case rather than expected: an operator asked "what does Tapat cost"
   * wants the number that cannot be exceeded, not an average that depends on
   * how people order.
   */
  perOrderCeilingCentavos: number;
  /** The monthly ceiling, where every capped benefit is at its cap. */
  perMonthCeilingCentavos: number;
  /** How many of the tier's benefits are perks rather than money. */
  perkCount: number;
  /** True when this tier gives away a delivery fee. */
  waivesDelivery: boolean;
}

/**
 * What one customer at this tier can cost in a month, at most.
 *
 * The console's headline number, and it needs a representative order because
 * a percentage of nothing is nothing. `deliveryFeeCentavos` and
 * `subtotalCentavos` are the operator's own typical order — the screen shows
 * which figures it used, so the answer is checkable rather than magic.
 *
 * An uncapped benefit makes the monthly figure unbounded, and that is reported
 * as `null` rather than as a large number: "we cannot bound this" is the
 * finding, and rounding it to a number an operator might budget against would
 * be the wrong kind of helpful.
 */
export function tierGiveback(
  benefits: readonly TierBenefitFacts[],
  order: { subtotalCentavos: number; deliveryFeeCentavos: number },
  ordersPerMonth: number,
): TierGiveback & { perMonthCeilingCentavos: number; unbounded: boolean } {
  let perOrder = 0;
  let perMonth = 0;
  let unbounded = false;
  let perkCount = 0;
  let waivesDelivery = false;

  for (const benefit of benefits) {
    if (!isTierBenefitUsable(benefit)) continue;
    const type = billBenefitTypeFor(benefit.type);
    if (type === null) {
      perkCount += 1;
      continue;
    }

    switch (benefit.type) {
      case TierBenefitType.FREE_DELIVERY: {
        waivesDelivery = true;
        perOrder += order.deliveryFeeCentavos;
        const times = benefit.monthlyUsageCap ?? ordersPerMonth;
        if (benefit.monthlyUsageCap === null) unbounded = true;
        perMonth += order.deliveryFeeCentavos * times;
        break;
      }
      case TierBenefitType.DISCOUNT_PERCENT: {
        const raw = Math.floor(
          (order.subtotalCentavos * (benefit.percentBasisPoints ?? 0)) / BASIS,
        );
        const capped =
          benefit.maxDiscountCentavos === null
            ? raw
            : Math.min(raw, benefit.maxDiscountCentavos);
        perOrder += capped;
        // Per-order only: nothing caps how many orders somebody places.
        unbounded = true;
        perMonth += capped * ordersPerMonth;
        break;
      }
      case TierBenefitType.CREDIT_BACK_PERCENT: {
        const gross = order.subtotalCentavos + order.deliveryFeeCentavos;
        const raw = Math.floor((gross * (benefit.percentBasisPoints ?? 0)) / BASIS);
        perOrder += raw;
        if (benefit.monthlyCeilingCentavos === null) {
          unbounded = true;
          perMonth += raw * ordersPerMonth;
        } else {
          perMonth += Math.min(
            benefit.monthlyCeilingCentavos,
            raw * ordersPerMonth,
          );
        }
        break;
      }
      case TierBenefitType.DISPATCH_PRIORITY:
      case TierBenefitType.SUPPORT_PRIORITY:
      case TierBenefitType.POINTS_NEVER_EXPIRE:
        // Unreachable: `billBenefitTypeFor` returned null for these above.
        break;
    }
  }

  return {
    perOrderCeilingCentavos: perOrder,
    perMonthCeilingCentavos: perMonth,
    perkCount,
    waivesDelivery,
    unbounded,
  };
}
