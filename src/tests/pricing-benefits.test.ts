import { describe, expect, it } from 'vitest';
import { BenefitType, ServiceKey, type SubscriptionBenefit } from '@prisma/client';
import {
  applyBenefits,
  benefitCoversService,
  isBenefitUsable,
  type BenefitUsageSnapshot,
  type FeeInputs,
} from '@/lib/pricing/benefits';
import { applyBasisPoints } from '@/lib/money';

/** A benefit row with sane defaults, so each test states only what it cares about. */
function benefit(overrides: Partial<SubscriptionBenefit> & { type: BenefitType }): SubscriptionBenefit {
  return {
    id: overrides.id ?? `benefit_${overrides.type}`,
    planId: 'plan_plus',
    type: overrides.type,
    serviceKeys: overrides.serviceKeys ?? [],
    percentBasisPoints: overrides.percentBasisPoints ?? null,
    minimumOrderCentavos: overrides.minimumOrderCentavos ?? null,
    monthlyUsageCap: overrides.monthlyUsageCap ?? null,
    maxDiscountCentavos: overrides.maxDiscountCentavos ?? null,
    monthlyCeilingCentavos: overrides.monthlyCeilingCentavos ?? null,
    displayLabel: overrides.displayLabel ?? 'Benefit',
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fees(overrides: Partial<FeeInputs> = {}): FeeInputs {
  return {
    subtotalCentavos: 50_000, // ₱500
    deliveryFeeCentavos: 4_900, // ₱49
    serviceFeeCentavos: 1_000,
    smallOrderFeeCentavos: 0,
    surgeCentavos: 0,
    tipCentavos: 0,
    promoDiscountCentavos: 0,
    ...overrides,
  };
}

const NO_USAGE = new Map<string, BenefitUsageSnapshot>();

describe('no subscription', () => {
  it('charges the quoted fees and grants nothing', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [],
      usageByBenefitId: NO_USAGE,
    });

    expect(outcome.deliveryFeeCentavos).toBe(4_900);
    expect(outcome.subscriptionDiscountCentavos).toBe(0);
    expect(outcome.creditBackCentavos).toBe(0);
    expect(outcome.payableCentavos).toBe(55_900); // 500 + 49 + 10
    expect(outcome.appliedBenefits).toEqual([]);
  });
});

describe('FREE_DELIVERY', () => {
  const freeDelivery = benefit({
    type: BenefitType.FREE_DELIVERY,
    minimumOrderCentavos: 29_900,
    monthlyUsageCap: 8,
    displayLabel: 'Libreng delivery',
  });

  it('waives the delivery fee above the minimum order', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [freeDelivery],
      usageByBenefitId: NO_USAGE,
    });

    // The fee stays visible at ₱49 and the waiver is a discount line, so the
    // receipt shows the customer what the tier bought them.
    expect(outcome.deliveryFeeCentavos).toBe(4_900);
    expect(outcome.deliveryFeeWaived).toBe(true);
    expect(outcome.subscriptionDiscountCentavos).toBe(4_900);
    expect(outcome.payableCentavos).toBe(51_000); // 500 + 10
  });

  it('subtracts the waived fee exactly once', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [freeDelivery],
      usageByBenefitId: NO_USAGE,
    });

    const gross = 50_000 + 4_900 + 1_000;
    expect(outcome.payableCentavos).toBe(gross - 4_900);
  });

  it('does not apply below the minimum order', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees({ subtotalCentavos: 20_000 }),
      benefits: [freeDelivery],
      usageByBenefitId: NO_USAGE,
    });

    expect(outcome.deliveryFeeWaived).toBe(false);
    expect(outcome.appliedBenefits).toEqual([]);
  });

  it('stops once the monthly cap is reached', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [freeDelivery],
      usageByBenefitId: new Map([
        [freeDelivery.id, { usageCount: 8, creditedCentavos: 0 }],
      ]),
    });

    expect(outcome.deliveryFeeWaived).toBe(false);
    expect(outcome.appliedBenefits).toEqual([]);
  });

  it('still applies on the last permitted use', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [freeDelivery],
      usageByBenefitId: new Map([
        [freeDelivery.id, { usageCount: 7, creditedCentavos: 0 }],
      ]),
    });

    expect(outcome.deliveryFeeWaived).toBe(true);
    expect(outcome.subscriptionDiscountCentavos).toBe(4_900);
  });

  it('claims nothing when delivery was already free', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees({ deliveryFeeCentavos: 0 }),
      benefits: [freeDelivery],
      usageByBenefitId: NO_USAGE,
    });

    // Recording a "saving" of zero would inflate what the tier appears to cost.
    expect(outcome.appliedBenefits).toEqual([]);
    expect(outcome.subscriptionDiscountCentavos).toBe(0);
  });
});

describe('DISCOUNT_PERCENT is scoped by data, not by a branch', () => {
  const foodOnly = benefit({
    type: BenefitType.DISCOUNT_PERCENT,
    serviceKeys: [ServiceKey.FOOD],
    percentBasisPoints: 500, // 5%
    maxDiscountCentavos: 10_000,
    displayLabel: '5% off sa Kainan',
  });

  it('applies to a service it is scoped to', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [foodOnly],
      usageByBenefitId: NO_USAGE,
    });

    expect(outcome.subscriptionDiscountCentavos).toBe(2_500); // 5% of ₱500
  });

  it('does not apply to a service outside its scope', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.MART,
      fees: fees(),
      benefits: [foodOnly],
      usageByBenefitId: NO_USAGE,
    });

    expect(outcome.subscriptionDiscountCentavos).toBe(0);
    expect(outcome.appliedBenefits).toEqual([]);
  });

  it('applies to every service when scoped to none', () => {
    const allServices = benefit({
      type: BenefitType.DISCOUNT_PERCENT,
      serviceKeys: [],
      percentBasisPoints: 1_000,
    });

    for (const key of Object.values(ServiceKey)) {
      const outcome = applyBenefits({
        serviceType: key,
        fees: fees(),
        benefits: [allServices],
        usageByBenefitId: NO_USAGE,
      });
      expect(outcome.subscriptionDiscountCentavos, `scoped out of ${key}`).toBe(5_000);
    }
  });

  it('respects the per-order ceiling', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      // 5% of ₱5,000 would be ₱250, above the ₱100 ceiling.
      fees: fees({ subtotalCentavos: 500_000 }),
      benefits: [foodOnly],
      usageByBenefitId: NO_USAGE,
    });

    expect(outcome.subscriptionDiscountCentavos).toBe(10_000);
  });

  it('handles fractional percentages without drifting', () => {
    const sevenAndAHalf = benefit({
      type: BenefitType.DISCOUNT_PERCENT,
      percentBasisPoints: 750, // 7.5% — the reason this column is basis points
    });
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees({ subtotalCentavos: 33_333 }),
      benefits: [sevenAndAHalf],
      usageByBenefitId: NO_USAGE,
    });

    expect(outcome.subscriptionDiscountCentavos).toBe(applyBasisPoints(33_333, 750));
    expect(Number.isInteger(outcome.subscriptionDiscountCentavos)).toBe(true);
  });
});

describe('CREDIT_BACK_PERCENT', () => {
  const creditBack = benefit({
    type: BenefitType.CREDIT_BACK_PERCENT,
    percentBasisPoints: 200, // 2%
    monthlyCeilingCentavos: 20_000, // ₱200/month
    displayLabel: '2% credits pabalik',
  });

  it('accrues credits without reducing what is payable now', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [creditBack],
      usageByBenefitId: NO_USAGE,
    });

    expect(outcome.payableCentavos).toBe(55_900);
    expect(outcome.subscriptionDiscountCentavos).toBe(0);
    expect(outcome.creditBackCentavos).toBe(1_118); // 2% of ₱559
  });

  it('is trimmed to the remaining monthly ceiling', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [creditBack],
      usageByBenefitId: new Map([
        [creditBack.id, { usageCount: 3, creditedCentavos: 19_500 }],
      ]),
    });

    expect(outcome.creditBackCentavos).toBe(500); // only ₱5 of headroom left
  });

  it('grants nothing once the ceiling is spent', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [creditBack],
      usageByBenefitId: new Map([
        [creditBack.id, { usageCount: 9, creditedCentavos: 20_000 }],
      ]),
    });

    expect(outcome.creditBackCentavos).toBe(0);
    expect(outcome.appliedBenefits).toEqual([]);
  });

  it('is computed after discounts, not before', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [
        benefit({
          type: BenefitType.FREE_DELIVERY,
          id: 'b_free',
          minimumOrderCentavos: 0,
          sortOrder: 0,
        }),
        { ...creditBack, sortOrder: 1 },
      ],
      usageByBenefitId: NO_USAGE,
    });

    // Payable is ₱510 after the waived fee, so credit-back is 2% of that.
    expect(outcome.payableCentavos).toBe(51_000);
    expect(outcome.creditBackCentavos).toBe(1_020);
  });
});

describe('discounts never produce a negative bill', () => {
  it('caps combined discounts at the gross amount', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees({ subtotalCentavos: 10_000, deliveryFeeCentavos: 0, serviceFeeCentavos: 0, promoDiscountCentavos: 8_000 }),
      benefits: [
        benefit({ type: BenefitType.DISCOUNT_PERCENT, percentBasisPoints: 5_000 }), // 50%
      ],
      usageByBenefitId: NO_USAGE,
    });

    expect(outcome.payableCentavos).toBe(0);
    // The customer's own voucher is honoured in full; the subscription share
    // absorbs the overshoot.
    expect(outcome.promoDiscountCentavos).toBe(8_000);
    expect(outcome.subscriptionDiscountCentavos).toBe(2_000);
    expect(
      outcome.promoDiscountCentavos + outcome.subscriptionDiscountCentavos,
    ).toBe(10_000);
  });
});

describe('misconfigured benefit rows are skipped, not thrown on', () => {
  it('ignores a FREE_DELIVERY with no minimum set', () => {
    expect(isBenefitUsable(benefit({ type: BenefitType.FREE_DELIVERY }))).toBe(false);
  });

  it('ignores a percentage benefit with no percentage', () => {
    expect(isBenefitUsable(benefit({ type: BenefitType.DISCOUNT_PERCENT }))).toBe(false);
    expect(
      isBenefitUsable(benefit({ type: BenefitType.DISCOUNT_PERCENT, percentBasisPoints: 0 })),
    ).toBe(false);
  });

  it('prices an order normally when every benefit is broken', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [
        benefit({ type: BenefitType.FREE_DELIVERY, id: 'broken_1' }),
        benefit({ type: BenefitType.DISCOUNT_PERCENT, id: 'broken_2' }),
      ],
      usageByBenefitId: NO_USAGE,
    });

    expect(outcome.payableCentavos).toBe(55_900);
    expect(outcome.appliedBenefits).toEqual([]);
  });
});

describe('scoping helper', () => {
  it('treats an empty scope as universal', () => {
    for (const key of Object.values(ServiceKey)) {
      expect(benefitCoversService({ serviceKeys: [] }, key)).toBe(true);
    }
  });

  it('honours an explicit scope', () => {
    expect(
      benefitCoversService({ serviceKeys: [ServiceKey.PARCEL] }, ServiceKey.PARCEL),
    ).toBe(true);
    expect(
      benefitCoversService({ serviceKeys: [ServiceKey.PARCEL] }, ServiceKey.FOOD),
    ).toBe(false);
  });
});
