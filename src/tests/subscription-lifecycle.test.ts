import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  BenefitType,
  ServiceKey,
  SubscriptionOrigin,
  SubscriptionStatus,
} from '@prisma/client';
import {
  addOneMonth,
  LIVE_SUBSCRIPTION_STATUSES,
} from '@/lib/subscriptions/enrollment';
import { decideRenewal, PAST_DUE_GRACE_DAYS } from '@/lib/subscriptions/renewal';
import {
  NoSubscriptionPaymentRailError,
  isPaidEnrollmentAvailable,
  resolveSubscriptionCharger,
} from '@/lib/subscriptions/payment';
import {
  benefitScopeLabel,
  benefitTerms,
  formatBasisPoints,
} from '@/lib/subscriptions/plans';

/** A benefit row, with only the columns the function under test reads. */
function benefit(overrides: Record<string, unknown> = {}) {
  return {
    type: BenefitType.FREE_DELIVERY,
    percentBasisPoints: null,
    minimumOrderCentavos: null,
    monthlyUsageCap: null,
    maxDiscountCentavos: null,
    monthlyCeilingCentavos: null,
    serviceKeys: [] as ServiceKey[],
    ...overrides,
  } as never;
}

describe('addOneMonth', () => {
  it('keeps the day of the month when the next month has one', () => {
    expect(addOneMonth(new Date('2026-09-07T02:30:00.000Z')).toISOString()).toBe(
      '2026-10-07T02:30:00.000Z',
    );
  });

  it('clamps 31 January to the end of February', () => {
    // 2026 is not a leap year: 28 days.
    expect(addOneMonth(new Date('2026-01-31T00:00:00.000Z')).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('clamps to 29 February in a leap year', () => {
    expect(addOneMonth(new Date('2028-01-31T00:00:00.000Z')).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('clamps 31 to 30 for a 30-day month', () => {
    expect(addOneMonth(new Date('2026-03-31T12:00:00.000Z')).toISOString()).toBe(
      '2026-04-30T12:00:00.000Z',
    );
  });

  it('rolls over the year in December', () => {
    expect(addOneMonth(new Date('2026-12-15T08:45:30.000Z')).toISOString()).toBe(
      '2027-01-15T08:45:30.000Z',
    );
  });

  it('does not drift earlier across a year of renewals', () => {
    // Adding 30 days repeatedly walks the billing date backwards through the
    // calendar; adding a month must not.
    let date = new Date('2026-01-15T00:00:00.000Z');
    for (let i = 0; i < 12; i += 1) {
      date = addOneMonth(date);
    }
    expect(date.toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });
});

describe('renewal policy', () => {
  const renewsAt = new Date('2026-09-07T00:00:00.000Z');
  const justAfter = new Date('2026-09-07T00:01:00.000Z');

  for (const origin of [SubscriptionOrigin.COMPED, SubscriptionOrigin.PROMOTIONAL]) {
    it(`expires a ${origin} subscription at its term rather than renewing it`, () => {
      const outcome = decideRenewal({
        origin,
        status: SubscriptionStatus.ACTIVE,
        renewsAt,
        now: justAfter,
        // Even with a working gateway: a grant is not a subscription we bill.
        canCharge: true,
      });
      expect(outcome.toStatus).toBe(SubscriptionStatus.EXPIRED);
    });
  }

  it('renews a paid subscription when it can be charged', () => {
    expect(
      decideRenewal({
        origin: SubscriptionOrigin.PAID,
        status: SubscriptionStatus.ACTIVE,
        renewsAt,
        now: justAfter,
        canCharge: true,
      }).toStatus,
    ).toBe(SubscriptionStatus.ACTIVE);
  });

  it('marks a paid subscription past due when it cannot', () => {
    expect(
      decideRenewal({
        origin: SubscriptionOrigin.PAID,
        status: SubscriptionStatus.ACTIVE,
        renewsAt,
        now: justAfter,
        canCharge: false,
      }).toStatus,
    ).toBe(SubscriptionStatus.PAST_DUE);
  });

  it('holds a past-due subscription open through the grace period', () => {
    const withinGrace = new Date(
      renewsAt.getTime() + (PAST_DUE_GRACE_DAYS - 1) * 24 * 60 * 60 * 1000,
    );
    expect(
      decideRenewal({
        origin: SubscriptionOrigin.PAID,
        status: SubscriptionStatus.PAST_DUE,
        renewsAt,
        now: withinGrace,
        canCharge: false,
      }).toStatus,
    ).toBe(SubscriptionStatus.PAST_DUE);
  });

  it('expires it once the grace period is spent', () => {
    const afterGrace = new Date(
      renewsAt.getTime() + PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(
      decideRenewal({
        origin: SubscriptionOrigin.PAID,
        status: SubscriptionStatus.PAST_DUE,
        renewsAt,
        now: afterGrace,
        canCharge: false,
      }).toStatus,
    ).toBe(SubscriptionStatus.EXPIRED);
  });

  it('treats ACTIVE and PAST_DUE as the live statuses, and nothing else', () => {
    expect([...LIVE_SUBSCRIPTION_STATUSES].sort()).toEqual(
      [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE].sort(),
    );
  });
});

describe('the payment rail', () => {
  it('refuses to resolve a charger when nothing is configured', () => {
    expect(() => resolveSubscriptionCharger({})).toThrow(NoSubscriptionPaymentRailError);
    expect(isPaidEnrollmentAvailable({})).toBe(false);
  });

  it('refuses a provider it has no implementation for, and names it', () => {
    const env = { SUBSCRIPTION_PAYMENT_PROVIDER: 'gcash' };
    expect(() => resolveSubscriptionCharger(env)).toThrow(/gcash/);
    // Still unavailable: a named provider with no adapter is not a rail.
    expect(isPaidEnrollmentAvailable(env)).toBe(false);
  });

  it('explains itself in terms of the credits constraint', () => {
    const message = new NoSubscriptionPaymentRailError().message;
    expect(message).toMatch(/orders only/);
    expect(message).toMatch(/COMPED|PROMOTIONAL/);
  });
});

describe('benefit terms, read off the columns', () => {
  it('states the minimum order and the monthly cap for free delivery', () => {
    const terms = benefitTerms(
      benefit({
        type: BenefitType.FREE_DELIVERY,
        minimumOrderCentavos: 29900,
        monthlyUsageCap: 8,
      }),
    );
    expect(terms.join(' · ')).toContain('₱299.00');
    expect(terms.join(' · ')).toContain('8x');
  });

  it('says so when free delivery has no cap', () => {
    const terms = benefitTerms(
      benefit({ type: BenefitType.FREE_DELIVERY, minimumOrderCentavos: 0 }),
    );
    expect(terms.join(' · ')).toMatch(/No monthly limit/);
  });

  it('states the percentage and the per-order ceiling for a discount', () => {
    const terms = benefitTerms(
      benefit({
        type: BenefitType.DISCOUNT_PERCENT,
        percentBasisPoints: 500,
        maxDiscountCentavos: 10000,
      }),
    );
    expect(terms.join(' · ')).toContain('5% off');
    expect(terms.join(' · ')).toContain('₱100.00');
  });

  it('says credit-back arrives after the order, not at checkout', () => {
    const terms = benefitTerms(
      benefit({
        type: BenefitType.CREDIT_BACK_PERCENT,
        percentBasisPoints: 200,
        monthlyCeilingCentavos: 20000,
      }),
    );
    expect(terms.join(' · ')).toContain('2%');
    expect(terms.join(' · ')).toContain('₱200.00');
    expect(terms.join(' · ')).toMatch(/after the order/);
  });

  it('formats basis points without inventing precision', () => {
    expect(formatBasisPoints(200)).toBe('2%');
    expect(formatBasisPoints(500)).toBe('5%');
    expect(formatBasisPoints(1250)).toBe('12.5%');
  });

  it('distinguishes "every service" from a list of one', () => {
    const names = new Map([[ServiceKey.FOOD, 'Food']]);
    expect(benefitScopeLabel(benefit({ serviceKeys: [] }), names)).toBe('Every service');
    expect(benefitScopeLabel(benefit({ serviceKeys: [ServiceKey.FOOD] }), names)).toBe(
      'Food',
    );
  });
});

/**
 * The wallet's hard constraint is that credits are spendable on orders only.
 * A subscription charge taken from the ledger would break it, so the
 * subscription layer must not be able to reach the ledger at all — a rule worth
 * enforcing mechanically, because "charge it to their credits" is the obvious
 * shortcut the first time someone wants a paid plan to work.
 */
describe('subscriptions cannot spend credits', () => {
  it('has no path from the subscription layer to the ledger', async () => {
    const dir = path.resolve(__dirname, '..', 'lib', 'subscriptions');
    const files = (await readdir(dir)).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      const imports = source.match(/from '[^']+'/g) ?? [];
      expect(
        imports.filter((line) => line.includes('wallet')),
        `${file} imports the credits ledger`,
      ).toEqual([]);
      expect(source, `${file} calls a ledger writer`).not.toMatch(
        /recordWalletTransaction|grantCredit|refundToCredits/,
      );
    }
  });
});
