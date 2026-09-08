import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminAction, PromoKind, ServiceKey } from '@prisma/client';
import {
  MAX_DISCOUNT_CENTAVOS,
  REFUSAL_TEXT,
  codeLooksPlausible,
  exposureFor,
  giveawayFor,
  normalisePromoCode,
  promoDisplay,
  rawDiscountFor,
  resolvePromo,
  type PromoFacts,
  type PromoOrderFacts,
  type PromoRefusal,
} from '@/lib/promo/policy';
import { applyBenefits } from '@/lib/pricing/benefits';
import { ADMIN_ACTION_LABEL } from '@/lib/admin/access';

/**
 * Promo codes.
 *
 * Three ideas carry this file.
 *
 * **A promo code is public.** Unlike a referral code, which belongs to one
 * person, a code goes onto a tarpaulin and into a group chat. So the tests are
 * about BOUNDS — how many orders, how much in total, how much per order, who
 * qualifies — and about the checkout field not becoming an oracle for finding
 * real codes.
 *
 * **A quote must never consume a use.** The split between `resolve` and
 * `consume` is the whole design, and it is asserted against the source: a
 * quote that wrote a redemption row would burn a customer's one use every time
 * they changed their address.
 *
 * **Not stacking must not punish the customer.** A subscriber who types a code
 * and ends up paying MORE than if they had typed nothing is the defect this
 * feature is most likely to ship with, because nothing anywhere errors.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
    .replace(/^\s*\/\/\/.*$/gm, ' ');
}

function codeOnly(relativePath: string): string {
  return stripComments(source(relativePath));
}

const JAN = new Date('2026-01-10T08:00:00Z');

/** ₱50 off, minimum ₱250, one per account, 500 uses, ₱25,000 budget. */
const FIFTY_OFF: PromoFacts = {
  id: 'promo-fifty',
  code: 'TARA50',
  label: '₱50 off',
  kind: PromoKind.FIXED_AMOUNT,
  percentBasisPoints: null,
  amountCentavos: 5_000,
  maxDiscountCentavos: null,
  minimumOrderCentavos: 25_000,
  serviceTypes: [],
  cityIds: [],
  storeId: null,
  firstOrderOnly: false,
  startsAt: new Date('2026-01-01T00:00:00Z'),
  endsAt: new Date('2026-02-01T00:00:00Z'),
  totalRedemptionLimit: 500,
  perCustomerLimit: 1,
  budgetCentavos: 2_500_000,
  stacksWithSubscription: true,
  isActive: true,
};

const ORDER: PromoOrderFacts = {
  serviceType: ServiceKey.FOOD,
  cityId: 'city-manila',
  storeId: 'store-1',
  subtotalCentavos: 40_000,
  deliveryFeeCentavos: 4_900,
};

const FRESH = { redemptions: 0, spentCentavos: 0 };
const NEW_CUSTOMER = { completedOrderCount: 0, timesUsed: 0 };

function resolve(
  promo: Partial<PromoFacts> = {},
  order: Partial<PromoOrderFacts> = {},
  customer: Partial<typeof NEW_CUSTOMER> = {},
  usage: Partial<typeof FRESH> = {},
  now: Date = JAN,
) {
  return resolvePromo({
    promo: { ...FIFTY_OFF, ...promo },
    order: { ...ORDER, ...order },
    customer: { ...NEW_CUSTOMER, ...customer },
    usage: { ...FRESH, ...usage },
    now,
  });
}

// =============================================================================
describe('three kinds, one number', () => {
  it('takes a percentage off the FOOD and not the fees', () => {
    // 10% of ₱400 is ₱40. Not 10% of the ₱449 bill: a percentage of the
    // delivery fee is a percentage of the rider's money.
    expect(
      rawDiscountFor(
        { kind: PromoKind.PERCENTAGE, percentBasisPoints: 1_000, amountCentavos: null },
        ORDER,
      ),
    ).toBe(4_000);
  });

  it('resolves free delivery to whatever the fee happens to be', () => {
    expect(
      rawDiscountFor(
        { kind: PromoKind.FREE_DELIVERY, percentBasisPoints: null, amountCentavos: null },
        { subtotalCentavos: 40_000, deliveryFeeCentavos: 7_300 },
      ),
    ).toBe(7_300);
  });

  it('floors a percentage rather than rounding it up', () => {
    // 3.33% of ₱100 is 333.0 centavos exactly; 3.34% would be 334. Chosen so a
    // change from floor to round would move the figure.
    expect(
      rawDiscountFor(
        { kind: PromoKind.PERCENTAGE, percentBasisPoints: 333, amountCentavos: null },
        { subtotalCentavos: 10_050, deliveryFeeCentavos: 0 },
      ),
    ).toBe(334);
  });
});

// =============================================================================
describe('the amount is bounded four ways', () => {
  it('gives the plain amount when nothing bites', () => {
    const quote = resolve();
    expect(quote.refusal).toBeNull();
    expect(quote.discountCentavos).toBe(5_000);
    expect(quote.label).toBe('₱50 off');
  });

  it("respects the code's own per-order ceiling", () => {
    const quote = resolve({
      kind: PromoKind.PERCENTAGE,
      percentBasisPoints: 5_000,
      amountCentavos: null,
      maxDiscountCentavos: 10_000,
    });
    // 50% of ₱400 is ₱200, capped at the ₱100 ceiling.
    expect(quote.discountCentavos).toBe(10_000);
  });

  it('respects the hard ceiling even when a row says otherwise', () => {
    const quote = resolve({ amountCentavos: MAX_DISCOUNT_CENTAVOS * 2 });
    expect(quote.discountCentavos).toBeLessThanOrEqual(MAX_DISCOUNT_CENTAVOS);
  });

  it('gives what is left of the budget rather than refusing outright', () => {
    // ₱25,000 budget, ₱24,970 already spent: ₱30 left, so ₱30 off.
    const quote = resolve({}, {}, {}, { spentCentavos: 2_497_000 });
    expect(quote.discountCentavos).toBe(3_000);
    expect(quote.refusal).toBeNull();
  });

  it('refuses once the budget is exactly spent', () => {
    const quote = resolve({}, {}, {}, { spentCentavos: 2_500_000 });
    expect(quote.refusal).toBe('NOTHING_TO_DISCOUNT');
    expect(quote.discountCentavos).toBe(0);
  });

  it('never gives more than the order is worth', () => {
    const quote = resolve(
      { amountCentavos: 100_000, minimumOrderCentavos: 0 },
      { subtotalCentavos: 3_000, deliveryFeeCentavos: 4_900 },
    );
    expect(quote.discountCentavos).toBe(7_900);
  });
});

// =============================================================================
describe('refusals about the CODE are all the same answer', () => {
  const cases: { why: string; promo: Partial<PromoFacts>; usage?: Partial<typeof FRESH> }[] = [
    { why: 'switched off', promo: { isActive: false } },
    { why: 'not started', promo: { startsAt: new Date('2026-06-01T00:00:00Z') } },
    { why: 'finished', promo: { endsAt: new Date('2026-01-02T00:00:00Z') } },
    { why: 'all used up', promo: { totalRedemptionLimit: 10 }, usage: { redemptions: 10 } },
  ];

  for (const { why, promo, usage } of cases) {
    it(`answers UNAVAILABLE when it is ${why}`, () => {
      expect(resolve(promo, {}, {}, usage ?? {}).refusal).toBe('UNAVAILABLE');
    });
  }

  it('gives the four of them a single indistinguishable sentence', () => {
    // The point of the uniform answer: a hundred guesses at the checkout field
    // must not reveal which of them are real codes that have merely run out.
    const answers = new Set(
      cases.map(({ promo, usage }) => {
        const refusal = resolve(promo, {}, {}, usage ?? {}).refusal;
        return REFUSAL_TEXT[refusal!];
      }),
    );
    expect(answers.size).toBe(1);
  });

  it('answers an unknown code the same way', () => {
    // Asserted at the layer that decides it, since a missing row never reaches
    // `resolvePromo` at all.
    const resolveModule = codeOnly('src/lib/promo/resolve.ts');
    expect(resolveModule).toMatch(/refusal: 'UNAVAILABLE'/);
  });
});

// =============================================================================
describe('refusals about the ORDER name the thing to change', () => {
  it('refuses the wrong service', () => {
    expect(resolve({ serviceTypes: [ServiceKey.MART] }).refusal).toBe('WRONG_SERVICE');
  });

  it('refuses the wrong city', () => {
    expect(resolve({ cityIds: ['city-cebu'] }).refusal).toBe('WRONG_CITY');
  });

  it('refuses the wrong shop', () => {
    expect(resolve({ storeId: 'store-other' }).refusal).toBe('WRONG_STORE');
  });

  it('refuses a first-order code for somebody already served', () => {
    expect(resolve({ firstOrderOnly: true }, {}, { completedOrderCount: 1 }).refusal).toBe(
      'NOT_YOUR_FIRST_ORDER',
    );
  });

  it('allows a first-order code for somebody whose only order was cancelled', () => {
    // `completedOrderCount` counts COMPLETED orders, so a cancelled one leaves
    // them still unserved and still eligible. Asserted at the layer that
    // decides which orders count.
    expect(resolve({ firstOrderOnly: true }, {}, { completedOrderCount: 0 }).refusal).toBeNull();
    expect(codeOnly('src/lib/promo/resolve.ts')).toMatch(/status: OrderStatus\.COMPLETED/);
  });

  it('refuses a second use by the same account', () => {
    expect(resolve({}, {}, { timesUsed: 1 }).refusal).toBe('ALREADY_USED');
  });

  it('allows the second of three permitted uses', () => {
    expect(resolve({ perCustomerLimit: 3 }, {}, { timesUsed: 1 }).refusal).toBeNull();
  });

  it('refuses an order below the minimum, at the centavo', () => {
    expect(resolve({}, { subtotalCentavos: 24_999 }).refusal).toBe('ORDER_TOO_SMALL');
    expect(resolve({}, { subtotalCentavos: 25_000 }).refusal).toBeNull();
  });

  it('names scope before amount, because scope is the useful sentence', () => {
    // Cebu AND too small. "That code is not being used in this city" beats
    // "spend ₱50 more" for somebody who can never qualify.
    expect(resolve({ cityIds: ['city-cebu'] }, { subtotalCentavos: 100 }).refusal).toBe(
      'WRONG_CITY',
    );
  });

  it('has a sentence for every refusal it can produce', () => {
    const refusals: PromoRefusal[] = [
      'UNAVAILABLE',
      'ORDER_TOO_SMALL',
      'WRONG_SERVICE',
      'WRONG_CITY',
      'WRONG_STORE',
      'NOT_YOUR_FIRST_ORDER',
      'ALREADY_USED',
      'NOTHING_TO_DISCOUNT',
    ];
    for (const refusal of refusals) {
      expect(REFUSAL_TEXT[refusal].length).toBeGreaterThan(10);
    }
  });
});

// =============================================================================
describe('a quote must never consume a use', () => {
  it('resolves without writing anything', () => {
    const resolveModule = codeOnly('src/lib/promo/resolve.ts');
    expect(resolveModule).not.toMatch(/promoRedemption\.create/);
    expect(resolveModule).not.toMatch(/promoRedemption\.upsert/);
    expect(resolveModule).not.toMatch(/promoCode\.update/);
  });

  it('writes the redemption only in the consuming half', () => {
    expect(codeOnly('src/lib/promo/consume.ts')).toMatch(/tx\.promoRedemption\.create/);
  });

  it('counts usage rather than reading a cached counter', () => {
    // A cached count is a second truth, and the moment it drifts a code either
    // stops early or runs past its budget with nobody able to say which. The
    // schema having no such column is the real guarantee.
    expect(source('prisma/schema.prisma')).not.toMatch(/redemptionCount\s+Int/);
    expect(codeOnly('src/lib/promo/resolve.ts')).toMatch(/promoRedemption\.aggregate/);
  });

  it('consumes inside the caller’s transaction, never its own', () => {
    const consume = codeOnly('src/lib/promo/consume.ts');
    // A `prisma.$transaction` here would be a second transaction alongside
    // placement's, which is exactly how the caps stop holding.
    expect(consume).toMatch(/tx: PrismaTransactionClient/);
    expect(consume).not.toMatch(/prisma\.\$transaction/);
  });

  it('is called from inside placement’s serializable transaction', () => {
    const place = codeOnly('src/lib/orders/place-order.ts');
    const tx = place.slice(place.indexOf('prisma.$transaction'));
    expect(tx).toMatch(/consumePromoCode\(/);
    expect(place).toMatch(/Prisma\.TransactionIsolationLevel\.Serializable/);
  });

  it('re-resolves at placement rather than trusting the quote’s number', () => {
    const consume = codeOnly('src/lib/promo/consume.ts');
    expect(consume).toMatch(/resolvePromoForOrder\(/);
    // The check that stops a client — or a stale quote — naming a bigger
    // discount than the code can justify.
    expect(consume).toMatch(/resolved\.discountCentavos < input\.appliedCentavos/);
  });

  it('is idempotent on a retried placement, by a unique index', () => {
    expect(source('prisma/schema.prisma')).toMatch(/orderId String @unique/);
    // And the guard file asserts that index still exists, rather than
    // duplicating it.
    expect(source('prisma/sql/promo_codes.sql')).toMatch(
      /PromoRedemption has no unique index/,
    );
  });
});

// =============================================================================
describe('not stacking must not punish a subscriber', () => {
  const FEES = {
    subtotalCentavos: 40_000,
    deliveryFeeCentavos: 4_900,
    serviceFeeCentavos: 0,
    smallOrderFeeCentavos: 0,
    surgeCentavos: 0,
    tipCentavos: 0,
    promoDiscountCentavos: 0,
  };

  const FREE_DELIVERY_BENEFIT = {
    id: 'benefit-free-delivery',
    planId: 'plan-plus',
    type: 'FREE_DELIVERY' as const,
    displayLabel: 'Plus free delivery',
    serviceKeys: [] as ServiceKey[],
    minimumOrderCentavos: 0,
    percentBasisPoints: null,
    maxDiscountCentavos: null,
    monthlyUsageCap: null,
    monthlyCeilingCentavos: null,
    sortOrder: 0,
    createdAt: JAN,
    updatedAt: JAN,
  };

  /** What the two alternatives actually cost, using the real arithmetic. */
  function bills(promoCentavos: number) {
    const planOnly = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: FEES,
      benefits: [FREE_DELIVERY_BENEFIT],
      usageByBenefitId: new Map(),
    });
    const promoOnly = applyBenefits({
      serviceType: ServiceKey.FOOD,
      fees: { ...FEES, promoDiscountCentavos: promoCentavos },
      benefits: [],
      usageByBenefitId: new Map(),
    });
    return { planOnly: planOnly.payableCentavos, promoOnly: promoOnly.payableCentavos };
  }

  it('has a case where dropping the plan would cost the customer money', () => {
    // The premise of the whole rule, stated as a test so it cannot quietly
    // stop being true: a ₱20 code against a ₱49 delivery waiver.
    const { planOnly, promoOnly } = bills(2_000);
    expect(promoOnly).toBeGreaterThan(planOnly);
    expect(promoOnly - planOnly).toBe(2_900);
  });

  it('prices both and keeps the cheaper bill', () => {
    // Asserted against the source, because the choice is made in
    // `bestOutcome`, which needs a database to call.
    const checkout = codeOnly('src/lib/pricing/checkout.ts');
    expect(checkout).toMatch(/function bestOutcome/);
    expect(checkout).toMatch(/netCost\(promoOnly\) < netCost\(planOnly\)/);
    expect(checkout).toMatch(/benefits: \[\]/);
    expect(checkout).toMatch(/promoDiscountCentavos: 0/);
  });

  it('counts credit-back in the comparison, at face value', () => {
    // Valuing it at zero would trade a ₱50 credit for a ₱21 discount.
    expect(codeOnly('src/lib/pricing/checkout.ts')).toMatch(
      /outcome\.payableCentavos - outcome\.creditBackCentavos/,
    );
  });

  it('leaves the code unspent when the plan wins', () => {
    // `price.promoDiscountCentavos` is zero in that case, and placement is
    // keyed on it rather than on what the code offered.
    const place = codeOnly('src/lib/orders/place-order.ts');
    expect(place).toMatch(/if \(quote\.price\.promoDiscountCentavos > 0\) \{/);
  });

  it('tells the customer which of the two happened', () => {
    // Four states, not two: the fourth is a valid code that took nothing off.
    expect(
      promoDisplay({ code: 'TARA50', refusal: null, offeredCentavos: 2_000, appliedCentavos: 0 }),
    ).toEqual({ kind: 'outbid', offeredCentavos: 2_000 });
    expect(
      promoDisplay({ code: 'TARA50', refusal: null, offeredCentavos: 2_000, appliedCentavos: 2_000 }),
    ).toEqual({ kind: 'accepted', discountCentavos: 2_000 });
    expect(
      promoDisplay({ code: 'TARA50', refusal: 'WRONG_CITY', offeredCentavos: 0, appliedCentavos: 0 }),
    ).toEqual({ kind: 'refused', refusal: 'WRONG_CITY' });
    expect(
      promoDisplay({ code: '', refusal: null, offeredCentavos: 0, appliedCentavos: 0 }),
    ).toEqual({ kind: 'none' });
  });

  it('says so on the screen when the plan is set aside', () => {
    expect(source('src/components/cart/CheckoutForm.tsx')).toMatch(
      /subscriptionBenefitsDropped/,
    );
    expect(source('src/components/cart/PromoField.tsx')).toMatch(/left the code unused/);
  });
});

// =============================================================================
describe('what a campaign can still cost', () => {
  it('is bounded by the budget when that is the tighter one', () => {
    const exposure = exposureFor(
      { totalRedemptionLimit: 1_000, budgetCentavos: 100_000, maxDiscountCentavos: null, amountCentavos: 5_000 },
      { redemptions: 4, spentCentavos: 20_000 },
    );
    // ₱800 of budget left; 996 uses × ₱50 would be ₱49,800.
    expect(exposure.remainingCentavos).toBe(80_000);
    expect(exposure.remainingRedemptions).toBe(996);
    expect(exposure.unbounded).toBe(false);
  });

  it('is bounded by the count when THAT is the tighter one', () => {
    const exposure = exposureFor(
      { totalRedemptionLimit: 6, budgetCentavos: 10_000_000, maxDiscountCentavos: null, amountCentavos: 5_000 },
      { redemptions: 4, spentCentavos: 20_000 },
    );
    expect(exposure.remainingCentavos).toBe(10_000);
  });

  it('reports an open cheque as unbounded rather than as a big number', () => {
    const exposure = exposureFor(
      { totalRedemptionLimit: null, budgetCentavos: null, maxDiscountCentavos: null, amountCentavos: 5_000 },
      FRESH,
    );
    expect(exposure.unbounded).toBe(true);
    expect(exposure.remainingCentavos).toBeNull();
  });

  it('cannot be talked into a negative remainder by an overspend', () => {
    const exposure = exposureFor(
      { totalRedemptionLimit: 2, budgetCentavos: 10_000, maxDiscountCentavos: null, amountCentavos: 5_000 },
      { redemptions: 9, spentCentavos: 90_000 },
    );
    expect(exposure.remainingCentavos).toBe(0);
    expect(exposure.remainingRedemptions).toBe(0);
  });

  it('refuses to create a code with no bound at all', () => {
    expect(source('src/lib/actions/admin-actions.ts')).toMatch(
      /Set a redemption limit or a budget/,
    );
  });
});

// =============================================================================
describe('the code that makes food free', () => {
  it('spots a fixed amount at or above the minimum', () => {
    expect(giveawayFor({ ...FIFTY_OFF, minimumOrderCentavos: 5_000 }).coversTheFood).toBe(true);
    expect(giveawayFor({ ...FIFTY_OFF, minimumOrderCentavos: 5_001 }).coversTheFood).toBe(false);
  });

  it('treats no minimum as the smallest possible order, not as no risk', () => {
    const giveaway = giveawayFor({ ...FIFTY_OFF, minimumOrderCentavos: 0 });
    expect(giveaway.smallestOrderCentavos).toBe(1);
    expect(giveaway.coversTheFood).toBe(true);
  });

  it('clears a percentage below 100%, whatever its ceiling', () => {
    // 99% of an order is always less than the order, so the ceiling cannot
    // make it free.
    expect(
      giveawayFor({
        kind: PromoKind.PERCENTAGE,
        percentBasisPoints: 9_900,
        amountCentavos: null,
        maxDiscountCentavos: MAX_DISCOUNT_CENTAVOS,
        minimumOrderCentavos: 100,
      }).coversTheFood,
    ).toBe(false);
  });

  it('flags a percentage at 100% whose ceiling reaches the minimum', () => {
    expect(
      giveawayFor({
        kind: PromoKind.PERCENTAGE,
        percentBasisPoints: 10_000,
        amountCentavos: null,
        maxDiscountCentavos: 50_000,
        minimumOrderCentavos: 25_000,
      }).coversTheFood,
    ).toBe(true);
  });

  it('never flags free delivery, which does not touch the food', () => {
    const giveaway = giveawayFor({
      kind: PromoKind.FREE_DELIVERY,
      percentBasisPoints: null,
      amountCentavos: null,
      maxDiscountCentavos: null,
      minimumOrderCentavos: 0,
    });
    expect(giveaway.coversTheFood).toBe(false);
    expect(giveaway.perOrderCentavos).toBeNull();
  });

  it('is shouted about on the console rather than refused', () => {
    // A deliberate acquisition subsidy is a real choice; doing it by accident
    // is not. So the console warns and the reason field records the intent.
    expect(source('src/app/admin/promo/page.tsx')).toMatch(/can make an order free/);
    expect(source('src/lib/actions/admin-actions.ts')).toMatch(/somebody can eat for nothing/);
  });
});

// =============================================================================
describe('tidying what somebody typed', () => {
  it('uppercases and removes internal spaces', () => {
    expect(normalisePromoCode(' tara 50 ')).toBe('TARA50');
  });

  it('does NOT fold confusable characters', () => {
    // The referral alphabet excludes O and 0 so it can strip them. A promo
    // code is chosen by marketing and may legitimately contain either, so
    // folding one onto the other could turn a typo into a DIFFERENT real code.
    expect(normalisePromoCode('TARA0')).toBe('TARA0');
    expect(normalisePromoCode('TARAO')).toBe('TARAO');
    expect(normalisePromoCode('TARA0')).not.toBe(normalisePromoCode('TARAO'));
  });

  it('bounds the length rather than sending 4KB to the database', () => {
    expect(normalisePromoCode('A'.repeat(500))).toHaveLength(40);
  });

  it('does not spend a round trip on something that cannot be a code', () => {
    expect(codeLooksPlausible('AB')).toBe(false);
    expect(codeLooksPlausible('TARA 50')).toBe(false);
    expect(codeLooksPlausible("TARA';DROP")).toBe(false);
    expect(codeLooksPlausible('TARA-50')).toBe(true);
    expect(codeLooksPlausible('TARA50')).toBe(true);
  });

  it('refuses an implausible code before the lookup', () => {
    const resolveModule = codeOnly('src/lib/promo/resolve.ts');
    const findFn = resolveModule.slice(resolveModule.indexOf('export async function findPromoCode'));
    expect(findFn.indexOf('codeLooksPlausible')).toBeLessThan(findFn.indexOf('findUnique'));
  });
});

// =============================================================================
describe('the database enforces the same rules', () => {
  const guards = source('prisma/sql/promo_codes.sql');

  it('requires a ceiling on a percentage', () => {
    expect(guards).toMatch(/promo_percentage_needs_a_ceiling/);
  });

  it('makes each kind carry its own fields', () => {
    expect(guards).toMatch(/promo_kind_carries_its_own_fields/);
  });

  it('keeps the window, the caps and the amounts sane', () => {
    expect(guards).toMatch(/promo_bounds_are_sane/);
    expect(guards).toMatch(/"endsAt" > "startsAt"/);
    expect(guards).toMatch(/"perCustomerLimit" >= 1/);
  });

  it('stores the code already uppercased and trimmed', () => {
    expect(guards).toMatch(/"code" = upper\(btrim\("code"\)\)/);
  });

  it('makes a redemption immutable once written', () => {
    expect(guards).toMatch(/promo_redemption_no_update/);
  });

  it('requires a redemption to have taken something off', () => {
    expect(guards).toMatch(/promo_redemption_takes_something_off/);
  });

  it('refuses to delete a code that has been used', () => {
    // RESTRICT, not Cascade: cascading would erase the record of what a
    // campaign cost while leaving the discount on every order.
    expect(source('prisma/schema.prisma')).toMatch(
      /promoCode\s+PromoCode @relation\(fields: \[promoCodeId\], references: \[id\], onDelete: Restrict\)/,
    );
  });
});

// =============================================================================
describe('creating a campaign is an audited spending decision', () => {
  it('names both actions in the log’s vocabulary', () => {
    for (const action of [
      AdminAction.PROMO_CODE_CREATED,
      AdminAction.PROMO_CODE_ACTIVATION_CHANGED,
    ]) {
      expect(ADMIN_ACTION_LABEL[action].length).toBeGreaterThan(5);
    }
  });

  it('demands a reason and writes an audit row for each', () => {
    const actions = codeOnly('src/lib/actions/admin-actions.ts');
    const bodyOf = (name: string): string => {
      const start = actions.indexOf(`export async function ${name}(`);
      expect(start, `${name} should exist`).toBeGreaterThan(-1);
      const rest = actions.slice(start + 1);
      const end = rest.indexOf('export async function ');
      return end === -1 ? rest : rest.slice(0, end);
    };

    for (const [name, action] of Object.entries({
      createPromoCodeAction: 'PROMO_CODE_CREATED',
      setPromoCodeActiveAction: 'PROMO_CODE_ACTIVATION_CHANGED',
    })) {
      const body = bodyOf(name);
      expect(body).toContain(`AdminAction.${action}`);
      expect(body).toContain("normaliseReason(formData.get('reason'))");
      expect(body).toContain('await recordAdminAction(');
    }
  });

  it('records the caps that were set, not just that something changed', () => {
    const actions = source('src/lib/actions/admin-actions.ts');
    const create = actions.slice(actions.indexOf('createPromoCodeAction'));
    for (const field of [
      'totalRedemptionLimit',
      'budgetCentavos',
      'perCustomerLimit',
      'minimumOrderCentavos',
    ]) {
      expect(create).toMatch(new RegExp(`${field}: row\\.${field}`));
    }
  });

  it('never reuses a code', () => {
    expect(source('src/lib/actions/admin-actions.ts')).toMatch(/Codes are never reused/);
  });

  it('states the worst case back to whoever just typed the caps', () => {
    expect(source('src/lib/actions/admin-actions.ts')).toMatch(/At most \$\{formatCentavos/);
  });
});

// =============================================================================
describe('the checkout field is not a search box', () => {
  it('does not re-quote on every keystroke', () => {
    const field = codeOnly('src/components/cart/PromoField.tsx');
    // The draft is local; only Apply lifts it to the parent.
    expect(field).toMatch(/const \[draft, setDraft\] = useState\(''\)/);
    expect(field).toMatch(/onApply\(normalised\)/);
    // The parent's quote key carries the APPLIED code, not the draft.
    expect(codeOnly('src/components/cart/CheckoutForm.tsx')).toMatch(
      /const quoteKey = JSON\.stringify\(\{[\s\S]*?promoCode,/,
    );
  });

  it('never computes a discount in the browser', () => {
    const field = codeOnly('src/components/cart/PromoField.tsx');
    expect(field).not.toMatch(/resolvePromo\b/);
    expect(field).not.toMatch(/rawDiscountFor/);
  });

  it('lets the client send a code and never a number', () => {
    const place = codeOnly('src/lib/orders/place-order.ts');
    expect(place).toMatch(/promoCode\?: string;/);
    expect(place).not.toMatch(/promoDiscountCentavos\?: number;/);
  });

  it('re-quotes after a refusal so the new total is on screen', () => {
    expect(codeOnly('src/components/cart/CheckoutForm.tsx')).toMatch(
      /result\.code === 'SURGE_CHANGED' \|\| result\.code === 'PROMO_INVALID'/,
    );
  });

  it('turns the refusal into a sentence rather than a stack trace', () => {
    expect(codeOnly('src/lib/actions/checkout-actions.ts')).toMatch(
      /'PromoNoLongerValidError'/,
    );
  });
});

// =============================================================================
describe('never charging more than was shown', () => {
  it('takes the displayed discount as a FLOOR, mirroring the surge ceiling', () => {
    const place = codeOnly('src/lib/orders/place-order.ts');
    expect(place).toMatch(/acceptedPromoDiscountCentavos\?: number;/);
    expect(place).toMatch(
      /quote\.price\.promoDiscountCentavos < input\.acceptedPromoDiscountCentavos/,
    );
    // Refuses by the same named error the consuming half throws, so the
    // action layer and the screen need no second case.
    expect(place).toMatch(/throw new PromoNoLongerValidError\(/);
  });

  it('sends that floor from the screen that displayed it', () => {
    expect(codeOnly('src/components/cart/CheckoutForm.tsx')).toMatch(
      /acceptedPromoDiscountCentavos: quote\?\.price\.promoDiscountCentavos \?\? 0/,
    );
  });

  it('leaves a caller with no screen to place at full price', () => {
    // `undefined` means "charge whatever applies", which is right for a
    // script or a test and wrong for a customer — which is why the form
    // always sends it. Same rule as `acceptedSurgeCentavos`.
    const place = codeOnly('src/lib/orders/place-order.ts');
    expect(place).toMatch(/input\.acceptedPromoDiscountCentavos !== undefined/);
  });
});

// =============================================================================
describe('a popular code must not fail everybody’s checkout', () => {
  it('retries a serialization conflict rather than surfacing it', () => {
    const place = codeOnly('src/lib/orders/place-order.ts');
    expect(place).toMatch(/const MAX_PLACEMENT_ATTEMPTS = \d+;/);
    // P2034 is what Postgres's 40001 arrives as. Counting redemptions across
    // everybody inside a serializable transaction means every checkout on a
    // popular code contends with every other one.
    expect(place).toMatch(/error\.code === 'P2034'/);
    expect(place).toMatch(/isSerializationConflict\(error\)/);
  });

  it('never retries a decision', () => {
    // A code that ran out, surge that moved, credits that fall short: retrying
    // makes the same refusal slower, and for the promo case it would place the
    // order the customer was just refused.
    expect(codeOnly('src/lib/orders/place-order.ts')).toMatch(
      /if \(!isSerializationConflict\(error\)\) throw error;/,
    );
  });

  it('backs off with jitter, so four clients do not re-collide together', () => {
    const place = codeOnly('src/lib/orders/place-order.ts');
    expect(place).toMatch(/Math\.random\(\)/);
  });

  it('lets a persistent conflict reach error monitoring', () => {
    // Deliberately NOT wrapped in a named domain error: past four attempts
    // this is not an expected refusal and somebody should see it.
    const place = codeOnly('src/lib/orders/place-order.ts');
    expect(place).toMatch(/throw lastConflict;/);
    expect(codeOnly('src/lib/actions/checkout-actions.ts')).not.toMatch(
      /PlacementConflictError/,
    );
  });
});

// =============================================================================
describe('the receipt still says why, months later', () => {
  it('names the code on the customer’s order', () => {
    expect(source('src/app/orders/[orderId]/page.tsx')).toMatch(
      /order\.promoRedemption\?\.promoCode\.label/,
    );
  });

  it('stores what the code actually took off, not what its rules say now', () => {
    expect(source('prisma/schema.prisma')).toMatch(/discountCentavos Int/);
    expect(codeOnly('src/lib/promo/consume.ts')).toMatch(
      /const discountCentavos = input\.appliedCentavos/,
    );
  });

  it('leaves the discount as TARA’s cost and not the shop’s', () => {
    // A promo is our marketing spend. Billing the restaurants for it by
    // netting it off their payout would be a quiet transfer nobody agreed to.
    expect(codeOnly('src/lib/settlement/policy.ts')).toMatch(
      /platformNetCentavos: platformCentavos - input\.discountedCentavos/,
    );
  });
});
