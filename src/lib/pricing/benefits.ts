import { BenefitSource, BenefitType, type ServiceKey } from '@prisma/client';
import { applyBasisPoints } from '@/lib/money';
import type { BenefitLike } from '@/lib/loyalty/tier-benefits';

/**
 * Subscription benefit arithmetic — pure, so the rules that decide what a
 * customer pays are testable without a database.
 *
 * There is no service-key branch here. A benefit is scoped by its own
 * `serviceKeys` column, which is data, so scoping a discount to MART on launch
 * day is a row edit.
 *
 * ### It prices two kinds of benefit, and knows about neither
 *
 * A `SubscriptionBenefit` row and a `LoyaltyTierBenefit` row of a bill type
 * carry the same columns under the same names, so both satisfy `BenefitLike`
 * and both come through here. That is deliberate to the letter: two
 * implementations of "free delivery over ₱300, four times a month" is how the
 * plan and the tier come to disagree by a peso in month three, and only one of
 * them gets fixed.
 *
 * What this module does NOT know is which is which. The caller tags each row
 * with a `source` and gets it back on the applied line, so the receipt can
 * name Plus or the tier without this function having an opinion about either.
 */

export interface BenefitUsageSnapshot {
  /** Times this benefit has been used in the current calendar month. */
  usageCount: number;
  /** Credit-back already accrued this month, centavos. */
  creditedCentavos: number;
}

export interface FeeInputs {
  subtotalCentavos: number;
  deliveryFeeCentavos: number;
  serviceFeeCentavos: number;
  smallOrderFeeCentavos: number;
  surgeCentavos: number;
  tipCentavos: number;
  promoDiscountCentavos: number;
}

/** A benefit row plus which of the two things conferred it. */
export interface SourcedBenefit {
  benefit: BenefitLike;
  source: BenefitSource;
}

export interface AppliedBenefitLine {
  benefitId: string;
  source: BenefitSource;
  type: BenefitType;
  displayLabel: string;
  /** Positive centavos taken off the total by this benefit. */
  amountCentavos: number;
  /** For CREDIT_BACK_PERCENT: credits to grant on completion. */
  creditBackCentavos: number;
}

/** Why a benefit the customer HAS did not apply to this bill. */
export type WithheldReason =
  /** FREE_DELIVERY: the order is below the minimum it needs. */
  | 'UNDER_MINIMUM'
  /** FREE_DELIVERY: this month's allowance is spent. */
  | 'MONTHLY_CAP_SPENT'
  /** Another benefit already waived the fee — one waiver per order. */
  | 'ALREADY_COVERED'
  /** CREDIT_BACK_PERCENT: this month's ceiling is reached. */
  | 'MONTHLY_CEILING_REACHED'
  /** Scoped to other services by its own `serviceKeys`. */
  | 'NOT_FOR_THIS_SERVICE';

/**
 * A benefit that was in play and did not apply.
 *
 * The reason this exists: a screen that shows only what APPLIED cannot explain
 * an absence, and an absence is what a customer notices. Somebody whose tier
 * gives them free delivery four times a month, placing a fifth order, simply
 * does not get it — and is told nothing, so the feature reads as broken.
 *
 * `shortfallCentavos` is the actionable one. "Add ₱40 more and delivery is
 * free" is the single most useful sentence a checkout can show, and it can
 * only be computed here, where the minimum and the subtotal are both in hand.
 */
export interface WithheldBenefitLine {
  benefitId: string;
  source: BenefitSource;
  type: BenefitType;
  displayLabel: string;
  reason: WithheldReason;
  /** UNDER_MINIMUM: how much more subtotal would trigger it. Else zero. */
  shortfallCentavos: number;
  /** MONTHLY_CAP_SPENT: the cap that is spent. Else zero. */
  monthlyCap: number;
}

/**
 * Which withheld reasons are worth SAYING to a customer, and how.
 *
 * Two of the five. `UNDER_MINIMUM` because it is actionable — the customer can
 * add an item and get the thing — and `MONTHLY_CAP_SPENT` because a benefit
 * that simply stops working is the one people ask support about.
 *
 * The other three are collected and not shown. `NOT_FOR_THIS_SERVICE` tells
 * somebody about a benefit they never expected here; `MONTHLY_CEILING_REACHED`
 * is about credits arriving later rather than about this bill; and
 * `ALREADY_COVERED` is shown only to a SUBSCRIBER, because "your plan's free
 * delivery was not needed" is reassurance for somebody paying every month and
 * clutter for anybody else. `worthShowing` is what encodes that.
 */
export const WITHHELD_IS_WORTH_SHOWING: Readonly<Record<WithheldReason, boolean>> = {
  UNDER_MINIMUM: true,
  MONTHLY_CAP_SPENT: true,
  ALREADY_COVERED: false,
  MONTHLY_CEILING_REACHED: false,
  NOT_FOR_THIS_SERVICE: false,
};

/**
 * The sentence for one withheld benefit, or null when it is not worth saying.
 *
 * A `format` function is passed in rather than imported so this module stays
 * arithmetic — the same reason `describeTierBenefit` takes one.
 */
export function describeWithheld(
  line: WithheldBenefitLine,
  format: (centavos: number) => string,
  options: {
    subscriberSeesCoveredNote?: boolean;
    /**
     * What to credit the benefit to — the tier's name, or the plan's. Named
     * rather than taken from `displayLabel`, because that column is the
     * operator's own words and the first version of this sentence appended it
     * lowercased: "delivery is free — that is free delivery four times a
     * month", which says the same thing twice. Seen in a browser.
     */
    sourceLabel?: string | null;
  } = {},
): string | null {
  switch (line.reason) {
    case 'UNDER_MINIMUM':
      return options.sourceLabel
        ? `Add ${format(line.shortfallCentavos)} more and delivery is free ` +
            `with ${options.sourceLabel}.`
        : `Add ${format(line.shortfallCentavos)} more and delivery is free.`;
    case 'MONTHLY_CAP_SPENT':
      return line.monthlyCap === 1
        ? 'You have used your free delivery this month. It comes back next month.'
        : `You have used all ${line.monthlyCap} of your free deliveries this ` +
            'month. They come back next month.';
    case 'ALREADY_COVERED':
      return options.subscriberSeesCoveredNote
        ? `Your plan's free delivery was not needed — ${line.displayLabel} ` +
            'covered it, so your plan keeps this month\u2019s use.'
        : null;
    case 'MONTHLY_CEILING_REACHED':
    case 'NOT_FOR_THIS_SERVICE':
      return null;
  }
}

export interface BenefitOutcome {
  /** Unchanged from the quoted fee; a waiver appears as a discount, not a zero. */
  deliveryFeeCentavos: number;
  /** Whether a FREE_DELIVERY benefit covered the fee. */
  deliveryFeeWaived: boolean;
  /** Discount from SUBSCRIPTION rows only. */
  subscriptionDiscountCentavos: number;
  /** Discount from LOYALTY_TIER rows only, so a receipt never conflates them. */
  loyaltyDiscountCentavos: number;
  promoDiscountCentavos: number;
  /** Owed after fees and all discounts, before credits are applied. */
  payableCentavos: number;
  /** Credits to grant on completion. NOT deducted from the total. */
  creditBackCentavos: number;
  appliedBenefits: AppliedBenefitLine[];
  /**
   * What the customer has that this bill did not use, and why.
   *
   * Deliberately NOT filtered here. A misconfigured row is excluded — that is
   * an operator's bug and no business of a customer's — but which of the rest
   * is worth SAYING is a screen's decision, not the engine's, and the
   * checkout shows two of the five.
   */
  withheldBenefits: WithheldBenefitLine[];
}

/** Empty `serviceKeys` means every active service; otherwise the key must be listed. */
export function benefitCoversService(
  benefit: Pick<BenefitLike, 'serviceKeys'>,
  serviceType: ServiceKey,
): boolean {
  return benefit.serviceKeys.length === 0 || benefit.serviceKeys.includes(serviceType);
}

/**
 * A benefit row must carry the columns its type needs. A misconfigured row is
 * skipped rather than thrown on: a bad entry in the admin should not take
 * checkout down for everyone.
 */
export function isBenefitUsable(
  benefit: Pick<BenefitLike, 'type' | 'minimumOrderCentavos' | 'percentBasisPoints'>,
): boolean {
  switch (benefit.type) {
    case BenefitType.FREE_DELIVERY:
      return benefit.minimumOrderCentavos !== null;
    case BenefitType.DISCOUNT_PERCENT:
    case BenefitType.CREDIT_BACK_PERCENT:
      return benefit.percentBasisPoints !== null && benefit.percentBasisPoints > 0;
  }
}

/**
 * Applies a plan's benefits to a set of fees.
 *
 * Order matters and is deliberate:
 *   1. FREE_DELIVERY        waives the delivery fee, subject to a minimum order
 *                           value and a monthly usage cap.
 *   2. DISCOUNT_PERCENT     off the subtotal, scoped to service keys, with an
 *                           optional per-order ceiling.
 *   3. Promo/voucher discount, then the total.
 *   4. CREDIT_BACK_PERCENT  accrued against what the customer actually pays,
 *                           subject to a monthly ceiling. Not a discount:
 *                           they pay full price now and the credits arrive on
 *                           completion.
 */
export function applyBenefits(input: {
  serviceType: ServiceKey;
  fees: FeeInputs;
  /**
   * Every benefit in play, each tagged with what conferred it. Order within
   * the array is the tie-break when two rows compete for the same waiver —
   * see the caller, which puts the tier's first on purpose.
   */
  benefits: readonly SourcedBenefit[];
  /** Current-month usage, keyed by benefit id. Absent means unused. */
  usageByBenefitId: ReadonlyMap<string, BenefitUsageSnapshot>;
}): BenefitOutcome {
  const { fees } = input;
  let creditBackCentavos = 0;
  let deliveryWaived = false;
  const appliedBenefits: AppliedBenefitLine[] = [];

  /**
   * Discounts, kept apart by source from the first centavo.
   *
   * Summing them and splitting later would need a second pass and a rule for
   * which side absorbs a rounding remainder; keeping two running totals means
   * every line is attributed by the code that created it.
   */
  const discount: Record<BenefitSource, number> = {
    [BenefitSource.SUBSCRIPTION]: 0,
    [BenefitSource.LOYALTY_TIER]: 0,
  };

  const withheldBenefits: WithheldBenefitLine[] = [];
  const withhold = (
    row: SourcedBenefit,
    reason: WithheldReason,
    extra: { shortfallCentavos?: number; monthlyCap?: number } = {},
  ): void => {
    withheldBenefits.push({
      benefitId: row.benefit.id,
      source: row.source,
      type: row.benefit.type,
      displayLabel: row.benefit.displayLabel,
      reason,
      shortfallCentavos: extra.shortfallCentavos ?? 0,
      monthlyCap: extra.monthlyCap ?? 0,
    });
  };

  // Stable: `sort` on the caller's array order, so a tier row and a plan row
  // with the same sortOrder keep the order the caller chose.
  //
  // A row scoped to other services is RECORDED as withheld; a misconfigured
  // row is dropped silently, because that is an operator's mistake and
  // telling a customer about it would be telling them nothing they can use.
  const usable = input.benefits.filter((row) => isBenefitUsable(row.benefit));
  const eligible = usable
    .filter((row) => {
      if (benefitCoversService(row.benefit, input.serviceType)) return true;
      withhold(row, 'NOT_FOR_THIS_SERVICE');
      return false;
    })
    .sort((a, b) => a.benefit.sortOrder - b.benefit.sortOrder);

  // --- 1. FREE_DELIVERY ---------------------------------------------------
  // The fee is NOT zeroed. It stays on the order at full value and the waiver
  // is recorded as a discount line, so the receipt reads
  // "Delivery fee ₱49 / Plus benefits −₱49" — the customer sees what the tier
  // bought them, and we can measure what it costs us. Zeroing the fee AND
  // recording a discount would subtract it twice.
  //
  // `continue` rather than `break` once a waiver is taken, so the ones that
  // came second are RECORDED as ALREADY_COVERED. The old `break` was correct
  // about the money and lost the reason: a subscriber whose plan's free
  // delivery went unused, because their tier's covered it, saw no line and no
  // explanation.
  for (const row of eligible.filter(
    (r) => r.benefit.type === BenefitType.FREE_DELIVERY,
  )) {
    const benefit = row.benefit;

    // Nothing to waive. The delivery line already reads "Libre" from the fee
    // rule's own threshold, so a second sentence about it would be noise.
    if (fees.deliveryFeeCentavos <= 0) continue;

    if (deliveryWaived) {
      withhold(row, 'ALREADY_COVERED');
      continue;
    }

    const minimum = benefit.minimumOrderCentavos ?? 0;
    if (fees.subtotalCentavos < minimum) {
      withhold(row, 'UNDER_MINIMUM', {
        shortfallCentavos: minimum - fees.subtotalCentavos,
      });
      continue;
    }

    const usage = input.usageByBenefitId.get(benefit.id);
    if (
      benefit.monthlyUsageCap !== null &&
      (usage?.usageCount ?? 0) >= benefit.monthlyUsageCap
    ) {
      withhold(row, 'MONTHLY_CAP_SPENT', { monthlyCap: benefit.monthlyUsageCap });
      continue;
    }

    deliveryWaived = true;
    discount[row.source] += fees.deliveryFeeCentavos;
    appliedBenefits.push({
      benefitId: benefit.id,
      source: row.source,
      type: benefit.type,
      displayLabel: benefit.displayLabel,
      amountCentavos: fees.deliveryFeeCentavos,
      creditBackCentavos: 0,
    });
    // One free-delivery benefit per order. A customer with both a plan and a
    // tier that waive delivery gets ONE waiver, and only one allowance is
    // spent — which is why the caller decides whose.
  }

  // --- 2. DISCOUNT_PERCENT ------------------------------------------------
  for (const row of eligible.filter(
    (r) => r.benefit.type === BenefitType.DISCOUNT_PERCENT,
  )) {
    const benefit = row.benefit;
    const raw = applyBasisPoints(fees.subtotalCentavos, benefit.percentBasisPoints ?? 0);
    const capped =
      benefit.maxDiscountCentavos !== null ? Math.min(raw, benefit.maxDiscountCentavos) : raw;
    if (capped <= 0) continue;

    discount[row.source] += capped;
    appliedBenefits.push({
      benefitId: benefit.id,
      source: row.source,
      type: benefit.type,
      displayLabel: benefit.displayLabel,
      amountCentavos: capped,
      creditBackCentavos: 0,
    });
  }

  // --- 3. Totals ----------------------------------------------------------
  const grossCentavos =
    fees.subtotalCentavos +
    fees.deliveryFeeCentavos +
    fees.serviceFeeCentavos +
    fees.smallOrderFeeCentavos +
    fees.surgeCentavos +
    fees.tipCentavos;

  // A discount can reduce a bill to zero but never below it. When the combined
  // discounts overshoot, they are trimmed in a deliberate order, cheapest
  // promise first:
  //
  //   1. the customer's own voucher is never clipped — they typed it, and a
  //      code that silently shrinks is the one they will ask about;
  //   2. then the subscription, which they PAY for every month;
  //   3. the loyalty tier is clipped first of all, because it is the one thing
  //      here nobody was charged for and nobody was promised a peso figure of.
  //
  // In practice all three only collide on a bill a voucher has already almost
  // zeroed, but "almost never" is exactly when an arbitrary order becomes a
  // support ticket nobody can explain.
  const requestedDiscounts =
    discount[BenefitSource.SUBSCRIPTION] +
    discount[BenefitSource.LOYALTY_TIER] +
    fees.promoDiscountCentavos;
  const allowedDiscounts = Math.min(grossCentavos, requestedDiscounts);

  const promoApplied = Math.min(fees.promoDiscountCentavos, allowedDiscounts);
  const subscriptionApplied = Math.min(
    discount[BenefitSource.SUBSCRIPTION],
    allowedDiscounts - promoApplied,
  );
  const loyaltyApplied = allowedDiscounts - promoApplied - subscriptionApplied;
  const payableCentavos = grossCentavos - allowedDiscounts;

  // --- 4. CREDIT_BACK_PERCENT --------------------------------------------
  for (const row of eligible.filter(
    (r) => r.benefit.type === BenefitType.CREDIT_BACK_PERCENT,
  )) {
    const benefit = row.benefit;
    const raw = applyBasisPoints(payableCentavos, benefit.percentBasisPoints ?? 0);
    const alreadyCredited = input.usageByBenefitId.get(benefit.id)?.creditedCentavos ?? 0;
    const remainingCeiling =
      benefit.monthlyCeilingCentavos !== null
        ? Math.max(0, benefit.monthlyCeilingCentavos - alreadyCredited)
        : Number.MAX_SAFE_INTEGER;
    const granted = Math.min(raw, remainingCeiling);
    if (granted <= 0) {
      // Distinguish "the month is used up" from "this bill earns nothing" —
      // the first is worth a sentence and the second is not.
      if (remainingCeiling <= 0) withhold(row, 'MONTHLY_CEILING_REACHED');
      continue;
    }

    creditBackCentavos += granted;
    appliedBenefits.push({
      benefitId: benefit.id,
      source: row.source,
      type: benefit.type,
      displayLabel: benefit.displayLabel,
      amountCentavos: 0,
      creditBackCentavos: granted,
    });
  }

  return {
    deliveryFeeCentavos: fees.deliveryFeeCentavos,
    deliveryFeeWaived: deliveryWaived,
    subscriptionDiscountCentavos: subscriptionApplied,
    loyaltyDiscountCentavos: loyaltyApplied,
    promoDiscountCentavos: promoApplied,
    payableCentavos,
    creditBackCentavos,
    appliedBenefits,
    withheldBenefits,
  };
}
