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

  // Stable: `sort` on the caller's array order, so a tier row and a plan row
  // with the same sortOrder keep the order the caller chose.
  const eligible = input.benefits
    .filter((row) => benefitCoversService(row.benefit, input.serviceType))
    .filter((row) => isBenefitUsable(row.benefit))
    .sort((a, b) => a.benefit.sortOrder - b.benefit.sortOrder);

  // --- 1. FREE_DELIVERY ---------------------------------------------------
  // The fee is NOT zeroed. It stays on the order at full value and the waiver
  // is recorded as a discount line, so the receipt reads
  // "Delivery fee ₱49 / Plus benefits −₱49" — the customer sees what the tier
  // bought them, and we can measure what it costs us. Zeroing the fee AND
  // recording a discount would subtract it twice.
  for (const row of eligible.filter(
    (r) => r.benefit.type === BenefitType.FREE_DELIVERY,
  )) {
    const benefit = row.benefit;
    if (deliveryWaived || fees.deliveryFeeCentavos <= 0) break;
    if (fees.subtotalCentavos < (benefit.minimumOrderCentavos ?? 0)) continue;

    const usage = input.usageByBenefitId.get(benefit.id);
    if (
      benefit.monthlyUsageCap !== null &&
      (usage?.usageCount ?? 0) >= benefit.monthlyUsageCap
    ) {
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
    break;
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
    if (granted <= 0) continue;

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
  };
}
