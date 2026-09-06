import { BenefitType, type ServiceKey, type SubscriptionBenefit } from '@prisma/client';
import { applyBasisPoints } from '@/lib/money';

/**
 * Subscription benefit arithmetic — pure, so the rules that decide what a
 * customer pays are testable without a database.
 *
 * There is no service-key branch here. A benefit is scoped by its own
 * `serviceKeys` column, which is data, so scoping a discount to MART on launch
 * day is a row edit.
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

export interface AppliedBenefitLine {
  benefitId: string;
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
  subscriptionDiscountCentavos: number;
  promoDiscountCentavos: number;
  /** Owed after fees and all discounts, before credits are applied. */
  payableCentavos: number;
  /** Credits to grant on completion. NOT deducted from the total. */
  creditBackCentavos: number;
  appliedBenefits: AppliedBenefitLine[];
}

/** Empty `serviceKeys` means every active service; otherwise the key must be listed. */
export function benefitCoversService(
  benefit: Pick<SubscriptionBenefit, 'serviceKeys'>,
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
  benefit: Pick<SubscriptionBenefit, 'type' | 'minimumOrderCentavos' | 'percentBasisPoints'>,
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
  benefits: readonly SubscriptionBenefit[];
  /** Current-month usage, keyed by benefit id. Absent means unused. */
  usageByBenefitId: ReadonlyMap<string, BenefitUsageSnapshot>;
}): BenefitOutcome {
  const { fees } = input;
  let subscriptionDiscountCentavos = 0;
  let creditBackCentavos = 0;
  let deliveryWaived = false;
  const appliedBenefits: AppliedBenefitLine[] = [];

  const eligible = input.benefits
    .filter((benefit) => benefitCoversService(benefit, input.serviceType))
    .filter(isBenefitUsable)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // --- 1. FREE_DELIVERY ---------------------------------------------------
  // The fee is NOT zeroed. It stays on the order at full value and the waiver
  // is recorded as a discount line, so the receipt reads
  // "Delivery fee ₱49 / Plus benefits −₱49" — the customer sees what the tier
  // bought them, and we can measure what it costs us. Zeroing the fee AND
  // recording a discount would subtract it twice.
  for (const benefit of eligible.filter((b) => b.type === BenefitType.FREE_DELIVERY)) {
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
    subscriptionDiscountCentavos += fees.deliveryFeeCentavos;
    appliedBenefits.push({
      benefitId: benefit.id,
      type: benefit.type,
      displayLabel: benefit.displayLabel,
      amountCentavos: fees.deliveryFeeCentavos,
      creditBackCentavos: 0,
    });
    // One free-delivery benefit per order.
    break;
  }

  // --- 2. DISCOUNT_PERCENT ------------------------------------------------
  for (const benefit of eligible.filter((b) => b.type === BenefitType.DISCOUNT_PERCENT)) {
    const raw = applyBasisPoints(fees.subtotalCentavos, benefit.percentBasisPoints ?? 0);
    const capped =
      benefit.maxDiscountCentavos !== null ? Math.min(raw, benefit.maxDiscountCentavos) : raw;
    if (capped <= 0) continue;

    subscriptionDiscountCentavos += capped;
    appliedBenefits.push({
      benefitId: benefit.id,
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
  // discounts overshoot, the subscription share is trimmed first so the
  // customer's own voucher is never the thing that gets clipped.
  const requestedDiscounts = subscriptionDiscountCentavos + fees.promoDiscountCentavos;
  const allowedDiscounts = Math.min(grossCentavos, requestedDiscounts);
  const promoApplied = Math.min(fees.promoDiscountCentavos, allowedDiscounts);
  const subscriptionApplied = allowedDiscounts - promoApplied;
  const payableCentavos = grossCentavos - allowedDiscounts;

  // --- 4. CREDIT_BACK_PERCENT --------------------------------------------
  for (const benefit of eligible.filter((b) => b.type === BenefitType.CREDIT_BACK_PERCENT)) {
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
    promoDiscountCentavos: promoApplied,
    payableCentavos,
    creditBackCentavos,
    appliedBenefits,
  };
}
