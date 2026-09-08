import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BenefitSource,
  BenefitType,
  ServiceKey,
  TierBenefitType,
} from '@prisma/client';
import {
  MAX_TIER_PERCENT_BASIS_POINTS,
  MAX_TIER_PRIORITY_WEIGHT,
  TIER_BENEFIT_COLUMNS,
  TIER_BENEFIT_NAME,
  billBenefitTypeFor,
  billBenefitsOf,
  describeTierBenefit,
  dispatchPriorityFor,
  isBillBenefit,
  isTierBenefitUsable,
  effectiveQueueTime,
  perkOf,
  pointsNeverExpireAt,
  supportPriorityFor,
  tierGiveback,
  type TierBenefitFacts,
} from '@/lib/loyalty/tier-benefits';
import {
  WITHHELD_IS_WORTH_SHOWING,
  applyBenefits,
  describeWithheld,
  type FeeInputs,
  type WithheldBenefitLine,
  type WithheldReason,
} from '@/lib/pricing/benefits';
import { sourcedBenefitsFor } from '@/lib/pricing/checkout';
import { formatCentavos } from '@/lib/money';
import { platformAbsorbedCentavos } from '@/lib/settlement/policy';

/**
 * Loyalty tier benefits.
 *
 * A tier used to change one thing — the earn rate — and the module that
 * decided that argued at length against letting it touch a bill. It now does
 * both, and these tests guard the line that argument was really drawing: a
 * tier confers a bill benefit through the SAME engine as a subscription plan,
 * not through a fourth mechanism of its own.
 *
 * The other half is the perks, which are the part that could quietly hurt
 * somebody. A priority benefit is minutes of apparent age, bounded, so a
 * stranger who has waited longer still goes first — and most of what follows
 * about DISPATCH_PRIORITY is about that bound holding.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

const ALL_TYPES = Object.values(TierBenefitType);

const benefit = (
  over: Partial<TierBenefitFacts> & { type: TierBenefitType },
): TierBenefitFacts => ({
  id: over.id ?? `tb_${over.type}`,
  type: over.type,
  serviceKeys: over.serviceKeys ?? [],
  percentBasisPoints: over.percentBasisPoints ?? null,
  minimumOrderCentavos: over.minimumOrderCentavos ?? null,
  monthlyUsageCap: over.monthlyUsageCap ?? null,
  maxDiscountCentavos: over.maxDiscountCentavos ?? null,
  monthlyCeilingCentavos: over.monthlyCeilingCentavos ?? null,
  priorityWeight: over.priorityWeight ?? null,
  displayLabel: over.displayLabel ?? 'A benefit',
  sortOrder: over.sortOrder ?? 0,
});

/** A usable row of each type, so "every type" tests are honest. */
const usableOf = (type: TierBenefitType): TierBenefitFacts => {
  switch (type) {
    case TierBenefitType.FREE_DELIVERY:
      return benefit({ type, minimumOrderCentavos: 30_000, monthlyUsageCap: 4 });
    case TierBenefitType.DISCOUNT_PERCENT:
      return benefit({ type, percentBasisPoints: 1_000, maxDiscountCentavos: 10_000 });
    case TierBenefitType.CREDIT_BACK_PERCENT:
      return benefit({ type, percentBasisPoints: 200, monthlyCeilingCentavos: 20_000 });
    case TierBenefitType.DISPATCH_PRIORITY:
      return benefit({ type, priorityWeight: 10 });
    case TierBenefitType.SUPPORT_PRIORITY:
      return benefit({ type, priorityWeight: 15 });
    case TierBenefitType.POINTS_NEVER_EXPIRE:
      return benefit({ type });
  }
};

// --- The boundary between the two families ----------------------------------

describe('which family a benefit type belongs to', () => {
  it('classifies every type, and the three bill types map onto BenefitType', () => {
    expect(billBenefitTypeFor(TierBenefitType.FREE_DELIVERY)).toBe(
      BenefitType.FREE_DELIVERY,
    );
    expect(billBenefitTypeFor(TierBenefitType.DISCOUNT_PERCENT)).toBe(
      BenefitType.DISCOUNT_PERCENT,
    );
    expect(billBenefitTypeFor(TierBenefitType.CREDIT_BACK_PERCENT)).toBe(
      BenefitType.CREDIT_BACK_PERCENT,
    );
  });

  it('and returns null for every perk, rather than a made-up bill type', () => {
    for (const type of [
      TierBenefitType.DISPATCH_PRIORITY,
      TierBenefitType.SUPPORT_PRIORITY,
      TierBenefitType.POINTS_NEVER_EXPIRE,
    ]) {
      expect(billBenefitTypeFor(type), type).toBeNull();
      expect(isBillBenefit(type), type).toBe(false);
    }
  });

  it('covers the whole enum, so a seventh type cannot be added unclassified', () => {
    // The switch is exhaustive, so this passing is really the compiler's
    // doing — what it catches is somebody widening the enum in the schema and
    // forgetting the policy module.
    for (const type of ALL_TYPES) {
      expect(() => billBenefitTypeFor(type)).not.toThrow();
      expect(billBenefitTypeFor(type), type).not.toBeUndefined();
    }
    expect(ALL_TYPES.length).toBe(6);
  });

  it('names every type for a screen, in the customer’s words', () => {
    for (const type of ALL_TYPES) {
      expect(TIER_BENEFIT_NAME[type], type).toBeTruthy();
      expect(TIER_BENEFIT_NAME[type].length, type).toBeGreaterThan(4);
    }
    // Not the enum name shouted back at somebody.
    expect(Object.values(TIER_BENEFIT_NAME).join(' ')).not.toMatch(/_/);
  });
});

// --- Rows that carry what they need -----------------------------------------

describe('a row carries the columns its type needs', () => {
  it('accepts a usable row of every type', () => {
    for (const type of ALL_TYPES) {
      expect(isTierBenefitUsable(usableOf(type)), type).toBe(true);
    }
  });

  it('refuses a free delivery with no minimum, and accepts one at zero', () => {
    // Null and zero are different: zero is "any order", null is unconfigured.
    expect(isTierBenefitUsable(benefit({ type: TierBenefitType.FREE_DELIVERY }))).toBe(
      false,
    );
    expect(
      isTierBenefitUsable(
        benefit({ type: TierBenefitType.FREE_DELIVERY, minimumOrderCentavos: 0 }),
      ),
    ).toBe(true);
  });

  it('refuses a percentage benefit with no percentage, or zero', () => {
    for (const type of [
      TierBenefitType.DISCOUNT_PERCENT,
      TierBenefitType.CREDIT_BACK_PERCENT,
    ]) {
      expect(isTierBenefitUsable(benefit({ type })), type).toBe(false);
      expect(
        isTierBenefitUsable(benefit({ type, percentBasisPoints: 0 })),
        type,
      ).toBe(false);
    }
  });

  it('refuses a priority benefit with no weight, or zero minutes', () => {
    for (const type of [
      TierBenefitType.DISPATCH_PRIORITY,
      TierBenefitType.SUPPORT_PRIORITY,
    ]) {
      expect(isTierBenefitUsable(benefit({ type })), type).toBe(false);
      expect(isTierBenefitUsable(benefit({ type, priorityWeight: 0 })), type).toBe(
        false,
      );
      expect(isTierBenefitUsable(benefit({ type, priorityWeight: 1 })), type).toBe(
        true,
      );
    }
  });

  it('accepts POINTS_NEVER_EXPIRE with nothing set, because it configures nothing', () => {
    expect(
      isTierBenefitUsable(benefit({ type: TierBenefitType.POINTS_NEVER_EXPIRE })),
    ).toBe(true);
    expect(TIER_BENEFIT_COLUMNS[TierBenefitType.POINTS_NEVER_EXPIRE]).toEqual([]);
  });

  it('agrees with the database guard about which columns each type uses', () => {
    // A guard that disagrees with the code refuses rows the app would have
    // handled, and accepts rows it cannot read. Both are worse than either.
    const sql = source('prisma/sql/loyalty_tiers.sql');
    const guard = sql.slice(
      sql.indexOf('loyalty_tier_benefit_columns_match_type CHECK'),
      sql.indexOf('-- 2. The numbers are in range'),
    );

    const COLUMN_OF: Readonly<Record<string, string>> = {
      minimumOrderCentavos: '"minimumOrderCentavos"',
      monthlyUsageCap: '"monthlyUsageCap"',
      percentBasisPoints: '"percentBasisPoints"',
      maxDiscountCentavos: '"maxDiscountCentavos"',
      monthlyCeilingCentavos: '"monthlyCeilingCentavos"',
      priorityWeight: '"priorityWeight"',
    };

    for (const type of ALL_TYPES) {
      const at = guard.indexOf(`WHEN '${type}' THEN`);
      expect(at, type).toBeGreaterThan(-1);
      const nextWhen = guard.indexOf('WHEN ', at + 5);
      const arm = guard.slice(at, nextWhen === -1 ? undefined : nextWhen);

      for (const [field, column] of Object.entries(COLUMN_OF)) {
        const used = TIER_BENEFIT_COLUMNS[type].includes(
          field as keyof TierBenefitFacts,
        );
        // A column the type uses is required or optional; one it does not use
        // must be asserted NULL, so a stale value cannot survive a type change.
        if (!used) {
          expect(arm, `${type}.${field}`).toContain(`${column} IS NULL`);
        } else {
          expect(arm, `${type}.${field}`).not.toContain(`${column} IS NULL`);
        }
      }
    }
  });

  it('agrees with the database about both ceilings', () => {
    const sql = source('prisma/sql/loyalty_tiers.sql');
    expect(sql).toContain(String(MAX_TIER_PERCENT_BASIS_POINTS));
    expect(sql).toContain(String(MAX_TIER_PRIORITY_WEIGHT));
  });
});

// --- Into the pricing engine ------------------------------------------------

describe('what reaches the pricing engine', () => {
  const everything = ALL_TYPES.map(usableOf);

  it('passes the bill benefits through and drops the perks', () => {
    const priced = billBenefitsOf(everything);
    expect(priced.map((row) => row.type).sort()).toEqual(
      [
        BenefitType.CREDIT_BACK_PERCENT,
        BenefitType.DISCOUNT_PERCENT,
        BenefitType.FREE_DELIVERY,
      ].sort(),
    );
  });

  it('drops a misconfigured row rather than handing the engine a broken one', () => {
    const priced = billBenefitsOf([
      benefit({ type: TierBenefitType.FREE_DELIVERY }),
      benefit({ type: TierBenefitType.DISCOUNT_PERCENT, percentBasisPoints: 0 }),
      usableOf(TierBenefitType.CREDIT_BACK_PERCENT),
    ]);
    expect(priced).toHaveLength(1);
    expect(priced[0]?.type).toBe(BenefitType.CREDIT_BACK_PERCENT);
  });

  it('carries every column the engine reads, under the same names', () => {
    const [priced] = billBenefitsOf([usableOf(TierBenefitType.FREE_DELIVERY)]);
    expect(priced).toMatchObject({
      minimumOrderCentavos: 30_000,
      monthlyUsageCap: 4,
      serviceKeys: [],
      sortOrder: 0,
    });
  });

  it('never invents a perk as a zero-value bill benefit', () => {
    // The tempting bug: mapping DISPATCH_PRIORITY to DISCOUNT_PERCENT at 0%,
    // which would put a "−₱0.00" line on somebody's receipt.
    for (const type of [
      TierBenefitType.DISPATCH_PRIORITY,
      TierBenefitType.SUPPORT_PRIORITY,
      TierBenefitType.POINTS_NEVER_EXPIRE,
    ]) {
      expect(billBenefitsOf([usableOf(type)]), type).toEqual([]);
    }
  });
});

// --- The perks ---------------------------------------------------------------

describe('the perks that touch no bill', () => {
  it('reads a dispatch head start in minutes, and zero when there is none', () => {
    expect(dispatchPriorityFor([usableOf(TierBenefitType.DISPATCH_PRIORITY)])).toBe(10);
    expect(dispatchPriorityFor([])).toBe(0);
    expect(dispatchPriorityFor([usableOf(TierBenefitType.SUPPORT_PRIORITY)])).toBe(0);
  });

  it('clamps it, so no tier can be permanently first', () => {
    // The bound is the whole safety property: minutes of apparent age can
    // never starve an order, a boolean "sukis first" can.
    expect(
      dispatchPriorityFor([
        benefit({ type: TierBenefitType.DISPATCH_PRIORITY, priorityWeight: 100_000 }),
      ]),
    ).toBe(MAX_TIER_PRIORITY_WEIGHT);
    expect(
      supportPriorityFor([
        benefit({ type: TierBenefitType.SUPPORT_PRIORITY, priorityWeight: 100_000 }),
      ]),
    ).toBe(MAX_TIER_PRIORITY_WEIGHT);
  });

  it('never returns a negative head start, which would push somebody back', () => {
    expect(
      dispatchPriorityFor([
        benefit({ type: TierBenefitType.DISPATCH_PRIORITY, priorityWeight: -50 }),
      ]),
    ).toBe(0);
  });

  it('keeps the two priorities separate', () => {
    const both = [
      benefit({ type: TierBenefitType.DISPATCH_PRIORITY, priorityWeight: 5 }),
      benefit({ type: TierBenefitType.SUPPORT_PRIORITY, priorityWeight: 30 }),
    ];
    expect(dispatchPriorityFor(both)).toBe(5);
    expect(supportPriorityFor(both)).toBe(30);
  });

  it('reads the never-expire perk, and ignores an unusable row', () => {
    expect(pointsNeverExpireAt([usableOf(TierBenefitType.POINTS_NEVER_EXPIRE)])).toBe(
      true,
    );
    expect(pointsNeverExpireAt([])).toBe(false);
    expect(perkOf([], TierBenefitType.POINTS_NEVER_EXPIRE)).toBeNull();
  });

  it('ignores a broken priority row instead of treating it as zero minutes', () => {
    expect(perkOf([benefit({ type: TierBenefitType.DISPATCH_PRIORITY })], TierBenefitType.DISPATCH_PRIORITY)).toBeNull();
  });
});

// --- The sentence a customer reads ------------------------------------------

describe('the sentence under each benefit', () => {
  it('says something specific for every type, from the row’s own numbers', () => {
    for (const type of ALL_TYPES) {
      const text = describeTierBenefit(usableOf(type), formatCentavos);
      expect(text.length, type).toBeGreaterThan(25);
      expect(text.endsWith('.'), type).toBe(true);
      expect(text, type).not.toMatch(/undefined|NaN|null/);
    }
  });

  it('puts the real numbers in it, never the operator’s label', () => {
    const text = describeTierBenefit(
      benefit({
        type: TierBenefitType.FREE_DELIVERY,
        minimumOrderCentavos: 30_000,
        monthlyUsageCap: 4,
        displayLabel: 'FREE DELIVERY FOREVER!!',
      }),
      formatCentavos,
    );
    expect(text).toContain('₱300.00');
    expect(text).toContain('4 times a month');
    expect(text).not.toContain('FOREVER');
  });

  it('distinguishes an uncapped benefit from a capped one', () => {
    const capped = describeTierBenefit(
      benefit({ type: TierBenefitType.FREE_DELIVERY, minimumOrderCentavos: 0, monthlyUsageCap: 1 }),
      formatCentavos,
    );
    const uncapped = describeTierBenefit(
      benefit({ type: TierBenefitType.FREE_DELIVERY, minimumOrderCentavos: 0 }),
      formatCentavos,
    );
    expect(capped).toContain('1 time a month');
    expect(uncapped).toContain('as often as you like');
  });

  it('tells the truth about a priority perk, including its limit', () => {
    for (const type of [
      TierBenefitType.DISPATCH_PRIORITY,
      TierBenefitType.SUPPORT_PRIORITY,
    ]) {
      const text = describeTierBenefit(usableOf(type), formatCentavos);
      // The honest half: somebody who waited longer still goes first. A
      // promise of "priority" with that omitted is the promise people
      // complain about when they see somebody served before them.
      expect(text, type).toMatch(/wait(ed|ing) longer/i);
      expect(text, type).toMatch(/still goes first/i);
    }
  });
});

// --- What it costs ----------------------------------------------------------

describe('what a tier can cost, for the console', () => {
  const ORDER = { subtotalCentavos: 50_000, deliveryFeeCentavos: 4_900 };

  it('bounds a capped free delivery exactly', () => {
    const cost = tierGiveback(
      [benefit({ type: TierBenefitType.FREE_DELIVERY, minimumOrderCentavos: 0, monthlyUsageCap: 4 })],
      ORDER,
      8,
    );
    expect(cost.perOrderCeilingCentavos).toBe(4_900);
    expect(cost.perMonthCeilingCentavos).toBe(4_900 * 4);
    expect(cost.unbounded).toBe(false);
    expect(cost.waivesDelivery).toBe(true);
  });

  it('reports an uncapped benefit as unbounded rather than as a big number', () => {
    const cost = tierGiveback(
      [benefit({ type: TierBenefitType.FREE_DELIVERY, minimumOrderCentavos: 0 })],
      ORDER,
      8,
    );
    expect(cost.unbounded).toBe(true);
  });

  it('treats a per-order percentage as unbounded, because nothing caps orders', () => {
    const cost = tierGiveback(
      [benefit({ type: TierBenefitType.DISCOUNT_PERCENT, percentBasisPoints: 1_000 })],
      ORDER,
      8,
    );
    expect(cost.perOrderCeilingCentavos).toBe(5_000);
    expect(cost.unbounded).toBe(true);
  });

  it('honours a credit-back monthly ceiling', () => {
    const cost = tierGiveback(
      [
        benefit({
          type: TierBenefitType.CREDIT_BACK_PERCENT,
          percentBasisPoints: 500,
          monthlyCeilingCentavos: 5_000,
        }),
      ],
      ORDER,
      8,
    );
    // 5% of ₱549 is ₱27.45 an order, ₱219.60 over eight — over the ₱50 cap.
    expect(cost.perOrderCeilingCentavos).toBe(2_745);
    expect(cost.perMonthCeilingCentavos).toBe(5_000);
    expect(cost.unbounded).toBe(false);
  });

  it('counts the perks separately and charges nothing for them', () => {
    const cost = tierGiveback(
      [
        usableOf(TierBenefitType.DISPATCH_PRIORITY),
        usableOf(TierBenefitType.SUPPORT_PRIORITY),
        usableOf(TierBenefitType.POINTS_NEVER_EXPIRE),
      ],
      ORDER,
      8,
    );
    expect(cost.perkCount).toBe(3);
    expect(cost.perOrderCeilingCentavos).toBe(0);
    expect(cost.perMonthCeilingCentavos).toBe(0);
    expect(cost.unbounded).toBe(false);
    expect(cost.waivesDelivery).toBe(false);
  });

  it('ignores a misconfigured row, so a broken benefit is not costed', () => {
    const cost = tierGiveback(
      [benefit({ type: TierBenefitType.FREE_DELIVERY })],
      ORDER,
      8,
    );
    expect(cost.perOrderCeilingCentavos).toBe(0);
    expect(cost.waivesDelivery).toBe(false);
  });
});

// --- Priced by the same engine as a plan ------------------------------------

describe('a tier benefit and a plan benefit through one engine', () => {
  const fees = (over: Partial<FeeInputs> = {}): FeeInputs => ({
    subtotalCentavos: 50_000,
    deliveryFeeCentavos: 4_900,
    serviceFeeCentavos: 1_000,
    smallOrderFeeCentavos: 0,
    surgeCentavos: 0,
    tipCentavos: 0,
    promoDiscountCentavos: 0,
    ...over,
  });

  const tierWaiver = {
    benefit: billBenefitsOf([
      benefit({
        id: 'tier_free',
        type: TierBenefitType.FREE_DELIVERY,
        minimumOrderCentavos: 0,
        monthlyUsageCap: 2,
        displayLabel: 'Free delivery for Tapat',
      }),
    ])[0]!,
    source: BenefitSource.LOYALTY_TIER,
  };
  const planWaiver = {
    benefit: {
      id: 'plan_free',
      type: BenefitType.FREE_DELIVERY,
      serviceKeys: [],
      percentBasisPoints: null,
      minimumOrderCentavos: 0,
      monthlyUsageCap: 4,
      maxDiscountCentavos: null,
      monthlyCeilingCentavos: null,
      displayLabel: 'Plus free delivery',
      sortOrder: 0,
    },
    source: BenefitSource.SUBSCRIPTION,
  };

  it('puts a tier’s discount in its own column, never the subscription’s', () => {
    // The receipt reason: a customer who has never paid for Plus must not
    // read "Plus benefits −₱49".
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [tierWaiver],
      usageByBenefitId: new Map(),
    });
    expect(outcome.loyaltyDiscountCentavos).toBe(4_900);
    expect(outcome.subscriptionDiscountCentavos).toBe(0);
    expect(outcome.appliedBenefits[0]?.source).toBe(BenefitSource.LOYALTY_TIER);
  });

  it('waives delivery ONCE when both a plan and a tier would', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [tierWaiver, planWaiver],
      usageByBenefitId: new Map(),
    });
    const gross = 50_000 + 4_900 + 1_000;
    expect(outcome.payableCentavos).toBe(gross - 4_900);
    expect(outcome.appliedBenefits).toHaveLength(1);
  });

  it('and spends the TIER’s allowance, leaving the paid one intact', () => {
    // The caller puts the tier first for exactly this reason. A subscriber
    // paid for their four free deliveries; the tier's are a gift, and
    // spending the gift first is what a customer would choose.
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [tierWaiver, planWaiver],
      usageByBenefitId: new Map(),
    });
    expect(outcome.appliedBenefits[0]?.benefitId).toBe('tier_free');
    expect(outcome.loyaltyDiscountCentavos).toBe(4_900);
    expect(outcome.subscriptionDiscountCentavos).toBe(0);
  });

  it('falls through to the plan once the tier’s month is spent', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [tierWaiver, planWaiver],
      usageByBenefitId: new Map([
        ['tier_free', { usageCount: 2, creditedCentavos: 0 }],
      ]),
    });
    expect(outcome.appliedBenefits[0]?.benefitId).toBe('plan_free');
    expect(outcome.subscriptionDiscountCentavos).toBe(4_900);
    expect(outcome.loyaltyDiscountCentavos).toBe(0);
  });

  it('clips the tier before the subscription, and the promo not at all', () => {
    // Only collides on a bill a voucher has nearly zeroed — which is exactly
    // when an arbitrary order becomes a ticket nobody can explain.
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees({
        subtotalCentavos: 6_000,
        deliveryFeeCentavos: 4_900,
        serviceFeeCentavos: 0,
        promoDiscountCentavos: 6_000,
      }),
      benefits: [
        tierWaiver,
        {
          benefit: {
            ...planWaiver.benefit,
            id: 'plan_pct',
            type: BenefitType.DISCOUNT_PERCENT,
            percentBasisPoints: 5_000,
            minimumOrderCentavos: null,
            monthlyUsageCap: null,
            sortOrder: 1,
          },
          source: BenefitSource.SUBSCRIPTION,
        },
      ],
      usageByBenefitId: new Map(),
    });

    // Gross ₱109. Wanted: ₱60 promo + ₱49 tier + ₱30 plan = ₱139.
    expect(outcome.payableCentavos).toBe(0);
    expect(outcome.promoDiscountCentavos).toBe(6_000);
    expect(outcome.subscriptionDiscountCentavos).toBe(3_000);
    // The tier absorbs the whole overshoot.
    expect(outcome.loyaltyDiscountCentavos).toBe(1_900);
  });

  it('never reduces a bill below zero, whatever is stacked on it', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees({ subtotalCentavos: 1_000, serviceFeeCentavos: 0, promoDiscountCentavos: 50_000 }),
      benefits: [tierWaiver],
      usageByBenefitId: new Map(),
    });
    expect(outcome.payableCentavos).toBe(0);
    expect(
      outcome.promoDiscountCentavos +
        outcome.subscriptionDiscountCentavos +
        outcome.loyaltyDiscountCentavos,
    ).toBe(1_000 + 4_900);
  });
});

// --- Explaining an absence --------------------------------------------------

describe('a benefit the customer has that this bill did not use', () => {
  const fees = (over: Partial<FeeInputs> = {}): FeeInputs => ({
    subtotalCentavos: 50_000,
    deliveryFeeCentavos: 4_900,
    serviceFeeCentavos: 1_000,
    smallOrderFeeCentavos: 0,
    surgeCentavos: 0,
    tipCentavos: 0,
    promoDiscountCentavos: 0,
    ...over,
  });

  const waiver = (
    id: string,
    source: BenefitSource,
    over: { minimumOrderCentavos?: number; monthlyUsageCap?: number | null } = {},
  ) => ({
    benefit: {
      id,
      type: BenefitType.FREE_DELIVERY,
      serviceKeys: [] as ServiceKey[],
      percentBasisPoints: null,
      minimumOrderCentavos: over.minimumOrderCentavos ?? 30_000,
      monthlyUsageCap: over.monthlyUsageCap === undefined ? 4 : over.monthlyUsageCap,
      maxDiscountCentavos: null,
      monthlyCeilingCentavos: null,
      displayLabel: id,
      sortOrder: 0,
    },
    source,
  });

  const withheldFor = (input: Parameters<typeof applyBenefits>[0]) =>
    applyBenefits(input).withheldBenefits;

  it('reports an order below the minimum, with the exact shortfall', () => {
    // The actionable one. "Add ₱40 more and delivery is free" is the single
    // most useful sentence a checkout can show, and it can only be computed
    // where the minimum and the subtotal are both in hand.
    const [line] = withheldFor({
      serviceType: ServiceKey.FOOD,
      fees: fees({ subtotalCentavos: 26_000 }),
      benefits: [waiver('tier_free', BenefitSource.LOYALTY_TIER)],
      usageByBenefitId: new Map(),
    });
    expect(line?.reason).toBe('UNDER_MINIMUM');
    expect(line?.shortfallCentavos).toBe(4_000);
    expect(line?.source).toBe(BenefitSource.LOYALTY_TIER);
  });

  it('gets the shortfall right at the boundary, and reports nothing on it', () => {
    const oneShort = withheldFor({
      serviceType: ServiceKey.FOOD,
      fees: fees({ subtotalCentavos: 29_999 }),
      benefits: [waiver('tier_free', BenefitSource.LOYALTY_TIER)],
      usageByBenefitId: new Map(),
    });
    expect(oneShort[0]?.shortfallCentavos).toBe(1);

    // Exactly at the minimum it APPLIES, so there is nothing to explain.
    const exact = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees({ subtotalCentavos: 30_000 }),
      benefits: [waiver('tier_free', BenefitSource.LOYALTY_TIER)],
      usageByBenefitId: new Map(),
    });
    expect(exact.withheldBenefits).toEqual([]);
    expect(exact.loyaltyDiscountCentavos).toBe(4_900);
  });

  it('reports a spent monthly allowance, carrying the cap', () => {
    const [line] = withheldFor({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [waiver('tier_free', BenefitSource.LOYALTY_TIER)],
      usageByBenefitId: new Map([
        ['tier_free', { usageCount: 4, creditedCentavos: 0 }],
      ]),
    });
    expect(line?.reason).toBe('MONTHLY_CAP_SPENT');
    expect(line?.monthlyCap).toBe(4);
  });

  it('reports the plan’s waiver as already covered when the tier took it', () => {
    // This is what the old `break` lost. The money was right and the reason
    // was gone: a subscriber whose plan's free delivery went unused saw no
    // line and no explanation.
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [
        waiver('tier_free', BenefitSource.LOYALTY_TIER),
        waiver('plan_free', BenefitSource.SUBSCRIPTION),
      ],
      usageByBenefitId: new Map(),
    });
    expect(outcome.appliedBenefits).toHaveLength(1);
    expect(outcome.withheldBenefits).toHaveLength(1);
    expect(outcome.withheldBenefits[0]).toMatchObject({
      benefitId: 'plan_free',
      reason: 'ALREADY_COVERED',
      source: BenefitSource.SUBSCRIPTION,
    });
  });

  it('reports a benefit scoped to another service', () => {
    const [line] = withheldFor({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [
        {
          ...waiver('mart_only', BenefitSource.LOYALTY_TIER),
          benefit: {
            ...waiver('mart_only', BenefitSource.LOYALTY_TIER).benefit,
            serviceKeys: [ServiceKey.MART],
          },
        },
      ],
      usageByBenefitId: new Map(),
    });
    expect(line?.reason).toBe('NOT_FOR_THIS_SERVICE');
  });

  it('says NOTHING about a misconfigured row, because that is not the customer’s problem', () => {
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees(),
      benefits: [
        {
          ...waiver('broken', BenefitSource.LOYALTY_TIER),
          benefit: {
            ...waiver('broken', BenefitSource.LOYALTY_TIER).benefit,
            minimumOrderCentavos: null,
          },
        },
      ],
      usageByBenefitId: new Map(),
    });
    expect(outcome.withheldBenefits).toEqual([]);
    expect(outcome.appliedBenefits).toEqual([]);
  });

  it('stays quiet when delivery is already free from the fee rule’s own threshold', () => {
    // The delivery line already reads "Libre". A second sentence about a
    // waiver that was not needed would be noise on top of good news.
    const outcome = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: fees({ deliveryFeeCentavos: 0 }),
      benefits: [waiver('tier_free', BenefitSource.LOYALTY_TIER)],
      usageByBenefitId: new Map(),
    });
    expect(outcome.withheldBenefits).toEqual([]);

    // And no APPLIED line either, which is the half that shows. The first
    // version of this test checked only the withheld list, and a mutation
    // that removed the zero-fee guard passed it — because the benefit then
    // "applied" for nothing and put "Free delivery −₱0.00" on the bill.
    expect(outcome.appliedBenefits).toEqual([]);
    expect(outcome.deliveryFeeWaived).toBe(false);
    expect(outcome.loyaltyDiscountCentavos).toBe(0);
  });

  it('has a decision about every reason, and a sentence for the ones it shows', () => {
    const all: WithheldReason[] = [
      'UNDER_MINIMUM',
      'MONTHLY_CAP_SPENT',
      'ALREADY_COVERED',
      'MONTHLY_CEILING_REACHED',
      'NOT_FOR_THIS_SERVICE',
    ];
    expect(Object.keys(WITHHELD_IS_WORTH_SHOWING).sort()).toEqual([...all].sort());

    const line = (reason: WithheldReason): WithheldBenefitLine => ({
      benefitId: 'b',
      source: BenefitSource.LOYALTY_TIER,
      type: BenefitType.FREE_DELIVERY,
      displayLabel: 'Free delivery',
      reason,
      shortfallCentavos: 4_000,
      monthlyCap: 4,
    });

    for (const reason of all) {
      const text = describeWithheld(line(reason), formatCentavos);
      if (WITHHELD_IS_WORTH_SHOWING[reason]) {
        expect(text, reason).not.toBeNull();
        expect(text!.length, reason).toBeGreaterThan(20);
        expect(text!.endsWith('.'), reason).toBe(true);
        expect(text!, reason).not.toMatch(/undefined|NaN|null/);
      } else {
        // Collected, deliberately not shown — except the one case below.
        expect(text, reason).toBeNull();
      }
    }
  });

  it('puts the shortfall in the sentence, as money', () => {
    const line: WithheldBenefitLine = {
      benefitId: 'b',
      source: BenefitSource.LOYALTY_TIER,
      type: BenefitType.FREE_DELIVERY,
      displayLabel: 'Free delivery four times a month',
      reason: 'UNDER_MINIMUM',
      shortfallCentavos: 4_000,
      monthlyCap: 4,
    };
    const text = describeWithheld(line, formatCentavos);
    expect(text).toContain('₱40.00');
    expect(text).toMatch(/add .* more and delivery is free/i);

    // Credited to the TIER by name, not by echoing the operator's label. The
    // first version appended `displayLabel` lowercased and read "delivery is
    // free — that is free delivery four times a month", which says the same
    // thing twice. Seen on the screen, in a browser.
    const credited = describeWithheld(line, formatCentavos, {
      sourceLabel: 'Tapat',
    });
    expect(credited).toBe('Add ₱40.00 more and delivery is free with Tapat.');
    expect(credited).not.toMatch(/that is free delivery/i);
  });

  it('says "your free delivery" in the singular when the cap is one', () => {
    const one = describeWithheld(
      {
        benefitId: 'b',
        source: BenefitSource.LOYALTY_TIER,
        type: BenefitType.FREE_DELIVERY,
        displayLabel: 'Free delivery',
        reason: 'MONTHLY_CAP_SPENT',
        shortfallCentavos: 0,
        monthlyCap: 1,
      },
      formatCentavos,
    );
    expect(one).toMatch(/used your free delivery this month/i);
    expect(one).not.toMatch(/all 1 of/);
  });

  it('shows the already-covered note only to a subscriber', () => {
    const line: WithheldBenefitLine = {
      benefitId: 'plan_free',
      source: BenefitSource.SUBSCRIPTION,
      type: BenefitType.FREE_DELIVERY,
      displayLabel: 'Your tier',
      reason: 'ALREADY_COVERED',
      shortfallCentavos: 0,
      monthlyCap: 0,
    };
    expect(describeWithheld(line, formatCentavos)).toBeNull();
    const forSubscriber = describeWithheld(line, formatCentavos, {
      subscriberSeesCoveredNote: true,
    });
    expect(forSubscriber).toMatch(/plan's free delivery was not needed/i);
    expect(forSubscriber).toMatch(/keeps this month/i);
  });
});

describe('the checkout screen says whose benefit it is', () => {
  const codeOnlyForm = (): string =>
    source('src/components/cart/CheckoutForm.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
      .replace(/^\s*\/\/.*$/gm, ' ');

  it('tags each applied line with the tier or the plan', () => {
    // Two things confer benefits and they rendered identically — just the
    // label an operator typed — so a customer could not tell which applied,
    // and `loyaltyTierName` was read by nothing at all.
    const code = codeOnlyForm();
    expect(code).toMatch(/benefit\.source === 'LOYALTY_TIER'/);
    expect(code).toMatch(/quote\.price\.loyaltyTierName/);
    expect(code).toMatch(/'TARA Plus'/);
  });

  it('renders the withheld sentences, and marks the actionable one', () => {
    const code = codeOnlyForm();
    expect(code).toMatch(/describeWithheld/);
    expect(code).toMatch(/withheldNotes/);
    expect(code).toMatch(/reason === 'UNDER_MINIMUM'/);
  });

  it('no longer tells a customer with no plan that their plan was set aside', () => {
    // `subscriptionBenefitsDropped` also fires for somebody who has a tier
    // and no subscription. The old sentence named a thing they never had.
    const rendered = source('src/components/cart/CheckoutForm.tsx');
    const at = rendered.indexOf('cannot be combined');
    expect(at).toBeGreaterThan(-1);
    const sentence = rendered.slice(at, at + 200);
    expect(sentence).toMatch(/your benefits/i);
    expect(sentence).not.toMatch(/your plan's benefits|your plan&apos;s benefits/i);
  });
});

// --- The wiring, asserted at the seams --------------------------------------

describe('the bound on a queue head start', () => {
  const placed = new Date('2026-09-09T12:00:00.000Z');
  const minutesOff = (boost: number): number =>
    (placed.getTime() - effectiveQueueTime(placed, boost)) / 60_000;

  it('moves an order earlier by exactly the minutes granted', () => {
    // Asserted numerically rather than by matching the multiplication in the
    // source: a source regex for `* 60_000` matched a mutant that had made it
    // `* 60_000_000_000`, which is the difference between a head start and a
    // separate queue for loyal customers.
    expect(minutesOff(0)).toBe(0);
    expect(minutesOff(1)).toBe(1);
    expect(minutesOff(10)).toBe(10);
    expect(minutesOff(100)).toBe(100);
  });

  it('never more than the ceiling, whatever it is handed', () => {
    expect(minutesOff(MAX_TIER_PRIORITY_WEIGHT)).toBe(MAX_TIER_PRIORITY_WEIGHT);
    expect(minutesOff(10_000)).toBe(MAX_TIER_PRIORITY_WEIGHT);
    expect(minutesOff(60 * 24 * 365)).toBe(MAX_TIER_PRIORITY_WEIGHT);
    // Which is the property that makes starvation impossible: an order that
    // has waited longer than the ceiling can never be overtaken.
    expect(MAX_TIER_PRIORITY_WEIGHT).toBeLessThanOrEqual(120);
  });

  it('never later than it really was', () => {
    expect(minutesOff(-30)).toBe(0);
    expect(effectiveQueueTime(placed, -30)).toBe(placed.getTime());
  });

  it('ignores a fractional minute rather than drifting on it', () => {
    expect(minutesOff(2.9)).toBe(2);
  });
});

describe('whose monthly allowance is spent first', () => {
  const row = (id: string) => ({
    id,
    type: BenefitType.FREE_DELIVERY,
    serviceKeys: [] as ServiceKey[],
    percentBasisPoints: null,
    minimumOrderCentavos: 0,
    monthlyUsageCap: 2,
    maxDiscountCentavos: null,
    monthlyCeilingCentavos: null,
    displayLabel: id,
    sortOrder: 0,
  });

  it('offers the TIER’s benefits before the plan’s', () => {
    // The decision `applyBenefits` cannot make for itself: it waives delivery
    // once, taking the first that applies, so this order decides whose
    // allowance is consumed. The subscriber PAID for theirs.
    const sourced = sourcedBenefitsFor({
      planBenefits: [row('plan')],
      tierBenefits: [row('tier')],
    });
    expect(sourced.map((entry) => [entry.benefit.id, entry.source])).toEqual([
      ['tier', BenefitSource.LOYALTY_TIER],
      ['plan', BenefitSource.SUBSCRIPTION],
    ]);
  });

  it('tags each side correctly even when only one exists', () => {
    expect(
      sourcedBenefitsFor({ planBenefits: [row('plan')], tierBenefits: [] }),
    ).toEqual([{ benefit: row('plan'), source: BenefitSource.SUBSCRIPTION }]);
    expect(
      sourcedBenefitsFor({ planBenefits: [], tierBenefits: [row('tier')] }),
    ).toEqual([{ benefit: row('tier'), source: BenefitSource.LOYALTY_TIER }]);
  });
});

describe('the seams each perk is read at', () => {
  const codeOnly = (relativePath: string): string =>
    source(relativePath)
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
      .replace(/^\s*\/\/.*$/gm, ' ');

  it('sorts the dispatch fan-out by effective age, not by a suki flag', () => {
    const code = codeOnly('src/lib/fleet/dispatch-offers.ts');
    expect(code).toMatch(/dispatchPriorityFor/);
    expect(code).toMatch(/effectiveQueueTime/);
    expect(code).toMatch(/effectiveAge\(a\) - effectiveAge\(b\)/);
    // And it takes a wider slice than it works, or a priority order sitting
    // past the limit would never be reached however long it waited.
    expect(code).toMatch(/take: take \* 2/);
  });

  it('keeps the support boost inside a priority band', () => {
    const code = codeOnly('src/lib/support/queries.ts');
    expect(code).toMatch(/supportPriorityFor/);
    // The priority comparison returns BEFORE the boost is considered.
    const byPriority = code.indexOf('const byPriority');
    const boost = code.indexOf('left.tierBoostMinutes');
    expect(byPriority).toBeGreaterThan(-1);
    expect(boost).toBeGreaterThan(byPriority);
    expect(code).toMatch(/if \(byPriority !== 0\) return byPriority;/);
  });

  it('stamps no expiry when the tier says so, and reads the tier at earning', () => {
    const code = codeOnly('src/lib/loyalty/earning.ts');
    expect(code).toMatch(/pointsNeverExpireAt/);
    expect(code).toMatch(/expiresAt: neverExpires \? null : expiryFor\(programme, now\)/);
  });

  it('and the expiry sweep never touches a null expiry', () => {
    const code = codeOnly('src/lib/loyalty/expiry.ts');
    expect(code).toMatch(/expiresAt: \{ not: null \}/);
  });

  it('commits usage for a tier-only customer, with no subscription in sight', () => {
    // The bug the compiler caught: the placement call used to be gated on
    // `subscriptionId`, so a customer with a tier and no plan would have had
    // no usage row written and no receipt line — and their monthly allowance
    // would never have run out.
    const code = codeOnly('src/lib/orders/place-order.ts');
    expect(code).toMatch(/if \(quote\.price\.appliedBenefits\.length > 0\)/);
    expect(code).not.toMatch(/quote\.price\.subscriptionId &&/);
    expect(code).toMatch(/customerId: input\.customerId/);
  });

  it('absorbs the tier discount against the platform share, like every other', () => {
    /**
     * This used to grep `accrual.ts` for `order.loyaltyDiscountCentavos`, and
     * broke the moment that sum was extracted into a shared function — for no
     * behavioural reason at all. Asked of the function instead: a tier
     * discount is one of the things the platform absorbs, and it counts the
     * same as a plan's.
     */
    const zero = {
      promoDiscountCentavos: 0,
      subscriptionDiscountCentavos: 0,
      loyaltyDiscountCentavos: 0,
      walletCreditAppliedCentavos: 0,
    };
    expect(platformAbsorbedCentavos({ ...zero, loyaltyDiscountCentavos: 4_000 })).toBe(
      4_000,
    );
    // The same peso off, whichever source gave it.
    expect(
      platformAbsorbedCentavos({ ...zero, subscriptionDiscountCentavos: 4_000 }),
    ).toBe(4_000);
    // And they add rather than one shadowing the other.
    expect(
      platformAbsorbedCentavos({
        ...zero,
        loyaltyDiscountCentavos: 4_000,
        promoDiscountCentavos: 1_500,
        walletCreditAppliedCentavos: 500,
      }),
    ).toBe(6_000);
  });

  it('names it as the tier on the receipt, never as Plus', () => {
    const receipt = source('src/app/orders/[orderId]/page.tsx');
    expect(receipt).toMatch(/loyaltyDiscountCentavos/);
    // The line's own label, not the subscription's.
    const at = receipt.indexOf('loyaltyDiscountCentavos');
    const line = receipt.slice(receipt.lastIndexOf('{', at), at);
    expect(line).not.toMatch(/Plus/);
  });
});
