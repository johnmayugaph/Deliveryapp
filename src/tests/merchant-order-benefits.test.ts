import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BenefitSource } from '@prisma/client';
import {
  platformAbsorbedCentavos,
  type OrderAbsorbed,
} from '@/lib/settlement/policy';
import {
  ABSORBED_NOTE,
  describeBenefitLine,
  orderBenefitView,
  unlistedDiscountNote,
  type AppliedBenefitRow,
} from '@/lib/merchant/order-benefits';

/**
 * What a finished order tells the shop that cooked it.
 *
 * The Regulars tab claims a customer's status costs a shop nothing. This is
 * the half that makes that claim checkable one order at a time, so the tests
 * that matter most are about NOT overstating what a past order knows.
 */

const NO_DISCOUNT: OrderAbsorbed = {
  promoDiscountCentavos: 0,
  subscriptionDiscountCentavos: 0,
  loyaltyDiscountCentavos: 0,
  walletCreditAppliedCentavos: 0,
};

const line = (over: Partial<AppliedBenefitRow> = {}): AppliedBenefitRow => ({
  source: over.source ?? BenefitSource.LOYALTY_TIER,
  displayLabel: over.displayLabel ?? 'Free delivery',
  amountCentavos: over.amountCentavos ?? 5_000,
  tierName: over.tierName === undefined ? 'Tapat' : over.tierName,
});

// --- One definition of what the platform absorbed --------------------------

describe('what the platform absorbed is defined once', () => {
  it('names every discount-shaped column on the Order model', () => {
    /**
     * The compiler cannot catch a FIFTH discount column added to the schema
     * and forgotten here — and forgetting it means the amount silently comes
     * out of a partner's pay, because settlement computes the shop's share on
     * the gross and this sum is what says how much of the gross TARA gave
     * away. So the schema is read and compared.
     */
    const schema = readFileSync(
      path.join(process.cwd(), 'prisma/schema.prisma'),
      'utf8',
    );
    const orderModel = /^model Order \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
    const columns = [
      ...orderModel.matchAll(/^\s*(\w*(?:Discount|CreditApplied)Centavos)\s/gm),
    ].map((match) => match[1]!);

    expect(columns.length).toBeGreaterThanOrEqual(4);

    const policy = readFileSync(
      path.join(process.cwd(), 'src/lib/settlement/policy.ts'),
      'utf8',
    );
    const fn = /export function platformAbsorbedCentavos[\s\S]*?\n\}/.exec(
      policy,
    )?.[0] ?? '';
    for (const column of columns) {
      expect(fn, `${column} is not in platformAbsorbedCentavos`).toContain(
        column,
      );
    }
  });

  it('is the same function settlement pays from', () => {
    const accrual = readFileSync(
      path.join(process.cwd(), 'src/lib/settlement/accrual.ts'),
      'utf8',
    );
    expect(accrual).toMatch(/discountedCentavos: platformAbsorbedCentavos\(order\)/);
  });

  it('adds every source rather than letting one shadow another', () => {
    expect(
      platformAbsorbedCentavos({
        promoDiscountCentavos: 1_000,
        subscriptionDiscountCentavos: 2_000,
        loyaltyDiscountCentavos: 4_000,
        walletCreditAppliedCentavos: 8_000,
      }),
    ).toBe(15_000);
  });
});

// --- What a past order knows, and what it must not claim ------------------

describe('a finished order and its status benefit', () => {
  it('says nothing at all about an ordinary order', () => {
    const view = orderBenefitView(NO_DISCOUNT, []);
    expect(view.absorbedCentavos).toBe(0);
    expect(view.hasStatusBenefit).toBe(false);
    expect(view.tierNames).toEqual([]);
    expect(view.hasUnlistedDiscount).toBe(false);
  });

  it('names the tier that conferred the benefit', () => {
    const view = orderBenefitView(
      { ...NO_DISCOUNT, loyaltyDiscountCentavos: 5_000 },
      [line()],
    );
    expect(view.hasStatusBenefit).toBe(true);
    expect(view.tierNames).toEqual(['Tapat']);
    expect(view.absorbedCentavos).toBe(5_000);
  });

  it('still reports the benefit when the tier has since been deleted', () => {
    /**
     * A tier's benefit rows cascade with it, so the join comes back null — but
     * `source`, `displayLabel` and `amountCentavos` are snapshotted on the
     * order precisely so a receipt survives that. The honest answer is "a
     * customer status", unnamed.
     */
    const view = orderBenefitView(
      { ...NO_DISCOUNT, loyaltyDiscountCentavos: 5_000 },
      [line({ tierName: null })],
    );
    expect(view.hasStatusBenefit).toBe(true);
    expect(view.tierNames).toEqual([]);
    expect(describeBenefitLine(line({ tierName: null }))).toBe(
      'Free delivery · a customer status',
    );
  });

  it('reports NOTHING for a regular whose order earned no benefit', () => {
    /**
     * The important negative. A Tapat customer ordering below the free-delivery
     * minimum gets no benefit row, and there is no way to know from the order
     * that they held a status — the tier is derived from points in a rolling
     * window and is not stored. Naming today's tier on a three-month-old
     * receipt would be a fabrication, and the aggregate on the Regulars tab is
     * where that question is answered instead.
     */
    const view = orderBenefitView(NO_DISCOUNT, []);
    expect(view.hasStatusBenefit).toBe(false);
    expect(view.lines).toEqual([]);
  });

  it('does not invent a tier for a subscription benefit', () => {
    const view = orderBenefitView(
      { ...NO_DISCOUNT, subscriptionDiscountCentavos: 5_000 },
      [line({ source: BenefitSource.SUBSCRIPTION, tierName: null })],
    );
    expect(view.hasStatusBenefit).toBe(false);
    expect(view.tierNames).toEqual([]);
    expect(
      describeBenefitLine(
        line({ source: BenefitSource.SUBSCRIPTION, tierName: null }),
      ),
    ).toBe('Free delivery · TARA Plus');
  });

  it('de-duplicates when one tier confers two benefits', () => {
    const view = orderBenefitView(
      { ...NO_DISCOUNT, loyaltyDiscountCentavos: 8_000 },
      [
        line({ displayLabel: 'Free delivery', amountCentavos: 5_000 }),
        line({ displayLabel: '10% off', amountCentavos: 3_000 }),
      ],
    );
    expect(view.tierNames).toEqual(['Tapat']);
    expect(view.lines).toHaveLength(2);
  });

  it('lists both when a plan and a tier each conferred something', () => {
    const view = orderBenefitView(
      {
        ...NO_DISCOUNT,
        loyaltyDiscountCentavos: 5_000,
        subscriptionDiscountCentavos: 2_000,
      },
      [
        line({ amountCentavos: 5_000 }),
        line({
          source: BenefitSource.SUBSCRIPTION,
          displayLabel: '5% off',
          amountCentavos: 2_000,
          tierName: null,
        }),
      ],
    );
    expect(view.absorbedCentavos).toBe(7_000);
    expect(view.hasStatusBenefit).toBe(true);
    expect(view.hasUnlistedDiscount).toBe(false);
  });
});

// --- The figure and the lines have to reconcile ---------------------------

describe('the total and the lines agree, or say why not', () => {
  it('flags money off that has no benefit line behind it', () => {
    /**
     * A promo code and spent credits are on the order's own columns, not
     * `OrderAppliedBenefit` rows. Without this flag the lines would not add up
     * to the headline figure, and a shop would be entirely right to wonder
     * what the missing ₱100 was.
     */
    const view = orderBenefitView(
      {
        ...NO_DISCOUNT,
        loyaltyDiscountCentavos: 5_000,
        promoDiscountCentavos: 10_000,
      },
      [line({ amountCentavos: 5_000 })],
    );
    expect(view.absorbedCentavos).toBe(15_000);
    expect(view.hasUnlistedDiscount).toBe(true);
  });

  it('flags credits spent with no benefit line at all', () => {
    const view = orderBenefitView(
      { ...NO_DISCOUNT, walletCreditAppliedCentavos: 12_000 },
      [],
    );
    expect(view.absorbedCentavos).toBe(12_000);
    expect(view.lines).toEqual([]);
    expect(view.hasUnlistedDiscount).toBe(true);
  });

  it('does not flag an order whose lines account for all of it', () => {
    const view = orderBenefitView(
      { ...NO_DISCOUNT, loyaltyDiscountCentavos: 5_000 },
      [line({ amountCentavos: 5_000 })],
    );
    expect(view.hasUnlistedDiscount).toBe(false);
  });

  it('does not flag a credit-back benefit, which takes nothing off this bill', () => {
    // CREDIT_BACK_PERCENT grants credits on completion; its `amountCentavos`
    // is zero because nothing came off the total. Both sides are zero, so
    // there is no shortfall to explain.
    const view = orderBenefitView(NO_DISCOUNT, [
      line({ displayLabel: '2% back in credits', amountCentavos: 0 }),
    ]);
    expect(view.absorbedCentavos).toBe(0);
    expect(view.hasUnlistedDiscount).toBe(false);
  });
});

// --- The claim, in the same words on both screens -------------------------

describe('the reassurance a shop reads', () => {
  it('says the shop’s share is unchanged, without hedging', () => {
    expect(ABSORBED_NOTE).toMatch(/full food subtotal/);
    expect(ABSORBED_NOTE).toMatch(/as if there had been no discount/);
    expect(ABSORBED_NOTE).not.toMatch(/may|might|usually|generally/);
  });

  it('is worded consistently with the Regulars tab', () => {
    // A shop reading two different phrasings of the same promise would
    // reasonably wonder whether they mean two different things.
    const panel = readFileSync(
      path.join(process.cwd(), 'src/components/merchant/TierStandingPanel.tsx'),
      'utf8',
    );
    expect(panel).toMatch(/full food subtotal less your usual commission/);
    expect(ABSORBED_NOTE).toMatch(/full food subtotal less your usual commission/);
  });
});

// --- The wording the browser corrected -----------------------------------

describe('the note for money off with no benefit line', () => {
  it('does not say “the rest” when there is no rest', () => {
    /**
     * Rendered in a browser, an order whose only discount was a promo code
     * read: “Customer paid ₱100.00 less — TARA covered it. The rest was a
     * promo code or credits.” There was no rest — that was all of it — and a
     * shop would reasonably go looking for the part that was missing.
     */
    expect(unlistedDiscountNote(false)).toBe(
      'That was a promo code or credits the customer had.',
    );
    expect(unlistedDiscountNote(false)).not.toMatch(/the rest/i);
  });

  it('does say “the rest” when benefit lines are listed above it', () => {
    expect(unlistedDiscountNote(true)).toMatch(/^The rest/);
  });
});
