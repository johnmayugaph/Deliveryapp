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
  BENEFIT_CONFERRING_STATUSES,
  LIVE_SUBSCRIPTION_STATUSES,
} from '@/lib/subscriptions/enrollment';
import {
  INVOICE_STATE_CONSOLE_TEXT,
  INVOICE_STATE_TEXT,
  RECOVERY_DAYS,
  addOneMonth,
  decideLapse,
  firstPeriodFor,
  invoiceState,
  isCollectable,
  manilaDateLabel,
  nextRenewsAt,
  renewalInvoiceIsDue,
  renewalPeriodFor,
} from '@/lib/subscriptions/billing-policy';
import {
  NoSubscriptionPaymentRailError,
  isPaidEnrollmentAvailable,
  resolveSubscriptionRail,
  subscriptionRailStatus,
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

describe('lapse policy', () => {
  const renewsAt = new Date('2026-09-07T00:00:00.000Z');
  const justAfter = new Date('2026-09-07T00:01:00.000Z');
  const base = {
    status: SubscriptionStatus.ACTIVE,
    origin: SubscriptionOrigin.PAID,
    renewsAt,
    hasCollectableInvoice: true,
    now: justAfter,
  };

  it('holds while the term still has time on it', () => {
    const beforeTheEnd = new Date(renewsAt.getTime() - 1000);
    expect(decideLapse({ ...base, now: beforeTheEnd }).action).toBe('HOLD');
  });

  for (const origin of [SubscriptionOrigin.COMPED, SubscriptionOrigin.PROMOTIONAL]) {
    it(`ends a ${origin} subscription at its term rather than renewing it`, () => {
      // A grant does not renew itself, and it is not billed, so there is
      // never an invoice to wait for.
      expect(
        decideLapse({ ...base, origin, hasCollectableInvoice: false }).action,
      ).toBe('END');
    });
  }

  it('lapses a paid subscription whose bill is still outstanding', () => {
    // LAPSE, not END: the benefits have already stopped (the pricing engine
    // needs renewsAt > now), and the door stays open for a late payment.
    const decision = decideLapse(base);
    expect(decision.action).toBe('LAPSE');
    expect(decision.reason).toMatch(/still restores/);
  });

  it('holds that door open through the recovery window', () => {
    const withinRecovery = new Date(
      renewsAt.getTime() + (RECOVERY_DAYS - 1) * 24 * 60 * 60 * 1000,
    );
    expect(decideLapse({ ...base, now: withinRecovery }).action).toBe('LAPSE');
  });

  it('ends it once the recovery window is spent', () => {
    const afterRecovery = new Date(
      renewsAt.getTime() + RECOVERY_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(decideLapse({ ...base, now: afterRecovery }).action).toBe('END');
  });

  it('ends a term that ran out with nothing left to collect', () => {
    // Cancelled mid-period, or the bill was voided. Waiting out the recovery
    // window would leave a dead row looking live to every screen.
    expect(decideLapse({ ...base, hasCollectableInvoice: false }).action).toBe('END');
  });

  it('gives an unpaid FIRST period no recovery window at all', () => {
    // Nothing was ever bought and no benefit was ever conferred; the only
    // thing the row does is block a second attempt. Letting it go promptly is
    // the kinder outcome.
    const decision = decideLapse({
      ...base,
      status: SubscriptionStatus.PENDING_PAYMENT,
    });
    expect(decision.action).toBe('END');
    expect(decision.reason).toMatch(/first payment never arrived/);
  });

  it('never decides anything about benefits', () => {
    // The load-bearing ordering: benefits are gated by the pricing engine on
    // `status = ACTIVE` and `renewsAt > now`, so they stop at the boundary
    // whether or not the sweep has run. This function tidies a record.
    const policy = readFileSync(
      path.join(process.cwd(), 'src/lib/subscriptions/billing-policy.ts'),
      'utf8',
    );
    expect(policy).toMatch(/Deliberately does NOT decide anything about benefits/);
  });
});

describe('billing periods', () => {
  const addMonth = addOneMonth;

  it('bills the period that starts when the current one ends', () => {
    const renewsAt = new Date('2026-09-07T00:00:00.000Z');
    const period = renewalPeriodFor(renewsAt, addMonth);
    expect(period.periodStart).toEqual(renewsAt);
    expect(period.periodEnd).toEqual(new Date('2026-10-07T00:00:00.000Z'));
    // Due ON the boundary — the honest deadline, because that is when the
    // benefits stop.
    expect(period.dueAt).toEqual(renewsAt);
  });

  it('clamps a month-end renewal rather than drifting it', () => {
    // 31 January renews 28 February, not 3 March. Adding 30 days would drift
    // the billing date earlier every month until somebody is billed twice in
    // one calendar month.
    expect(addOneMonth(new Date('2026-01-31T09:00:00.000Z'))).toEqual(
      new Date('2026-02-28T09:00:00.000Z'),
    );
    // And it does not then stay on the 28th: the next one is 28 March, which
    // is the accepted cost of clamping.
    expect(addOneMonth(new Date('2026-02-28T09:00:00.000Z'))).toEqual(
      new Date('2026-03-28T09:00:00.000Z'),
    );
  });

  it('issues inside the lead window, and still issues after it', () => {
    const renewsAt = new Date('2026-09-30T00:00:00.000Z');
    const wellBefore = new Date('2026-09-01T00:00:00.000Z');
    const insideWindow = new Date('2026-09-25T00:00:00.000Z');
    const afterTheBoundary = new Date('2026-10-05T00:00:00.000Z');

    expect(renewalInvoiceIsDue(renewsAt, wellBefore)).toBe(false);
    expect(renewalInvoiceIsDue(renewsAt, insideWindow)).toBe(true);
    // The case a `now === boundary - 7 days` test would miss: a sweep that did
    // not run for a week must still raise the bill rather than skip a period.
    expect(renewalInvoiceIsDue(renewsAt, afterTheBoundary)).toBe(true);
  });

  it('gives a first invoice hours, not days', () => {
    const now = new Date('2026-09-07T00:00:00.000Z');
    const period = firstPeriodFor(now, addMonth);
    expect(period.dueAt).toEqual(new Date('2026-09-09T00:00:00.000Z'));
  });

  it('keeps a punctual renewal continuous', () => {
    const currentRenewsAt = new Date('2026-09-30T00:00:00.000Z');
    const paidEarly = new Date('2026-09-25T12:00:00.000Z');
    expect(
      nextRenewsAt({ currentRenewsAt, settledAt: paidEarly, addMonth }),
    ).toEqual(new Date('2026-10-30T00:00:00.000Z'));
  });

  it('gives a LATE payer a full month rather than a stub', () => {
    // Three days late gets a month from the payment, not twenty-seven days
    // from the boundary. Billing them for a month and giving them part of it
    // would charge a late payer more per day than a punctual one — and the
    // reason they were late is often that our own confirmation was slow.
    const currentRenewsAt = new Date('2026-09-30T00:00:00.000Z');
    const paidLate = new Date('2026-10-03T00:00:00.000Z');
    expect(
      nextRenewsAt({ currentRenewsAt, settledAt: paidLate, addMonth }),
    ).toEqual(new Date('2026-11-03T00:00:00.000Z'));
  });
});

describe('what state a bill is in', () => {
  const now = new Date('2026-09-10T00:00:00.000Z');
  const invoice = (over: Record<string, unknown> = {}) => ({
    dueAt: new Date('2026-09-12T00:00:00.000Z'),
    submittedAt: null,
    settledAt: null,
    voidedAt: null,
    ...over,
  }) as never;

  it('is OPEN before the due date and OVERDUE after it', () => {
    expect(invoiceState(invoice(), now)).toBe('OPEN');
    expect(invoiceState(invoice(), new Date('2026-09-13T00:00:00.000Z'))).toBe(
      'OVERDUE',
    );
  });

  it('shows AWAITING_REVIEW rather than OVERDUE once they have sent it', () => {
    // The human reason this branch is ordered the way it is: somebody who has
    // sent the money and is waiting on us must not be shown "overdue". They
    // did their part; it is our queue that is behind.
    const submitted = invoice({ submittedAt: new Date('2026-09-11T00:00:00.000Z') });
    expect(invoiceState(submitted, new Date('2026-09-20T00:00:00.000Z'))).toBe(
      'AWAITING_REVIEW',
    );
  });

  it('lets SETTLED beat everything', () => {
    const paid = invoice({
      settledAt: new Date('2026-09-11T00:00:00.000Z'),
      submittedAt: new Date('2026-09-11T00:00:00.000Z'),
    });
    expect(invoiceState(paid, new Date('2027-01-01T00:00:00.000Z'))).toBe('SETTLED');
  });

  it('counts exactly three states as still collectable', () => {
    const states = ['OPEN', 'AWAITING_REVIEW', 'OVERDUE', 'SETTLED', 'VOID'] as const;
    expect(states.filter(isCollectable)).toEqual([
      'OPEN',
      'AWAITING_REVIEW',
      'OVERDUE',
    ]);
  });
});

describe('the payment rail', () => {
  const FULL = {
    PAYMENT_TRANSFER_LABEL: 'GCash',
    PAYMENT_TRANSFER_ACCOUNT_NAME: 'TARA Delivery',
    PAYMENT_TRANSFER_ACCOUNT_NUMBER: '09171234567',
  };

  it('has no rail when nothing is configured, and says so rather than throwing', () => {
    // Null is a supported state: grants need no rail, and an app with no plan
    // for sale is fully usable. Same choice `resolvePaymentRail` makes.
    expect(resolveSubscriptionRail({})).toBeNull();
    expect(isPaidEnrollmentAvailable({})).toBe(false);
  });

  it('switches OFF on a half-filled configuration rather than guessing', () => {
    // The case that matters. An account name with no number would offer a
    // subscription and then be unable to say where to send the money.
    for (const key of Object.keys(FULL)) {
      const partial = { ...FULL, [key]: '' };
      expect(resolveSubscriptionRail(partial), `missing ${key}`).toBeNull();
      expect(subscriptionRailStatus(partial).missing).toContain(key);
    }
  });

  it('collects by transfer, confirmed by a person, when configured', () => {
    const rail = resolveSubscriptionRail(FULL);
    expect(rail).not.toBeNull();
    expect(rail!.mode).toBe('REQUESTED');
    expect(rail!.settlement).toBe('HUMAN');
    expect(rail!.customerLabel).toBe('GCash');
    // REQUESTED means it cannot charge anybody. The absence of the method is
    // the check, so a caller cannot try and catch its way into a charge.
    expect(rail!.collect).toBeUndefined();
    expect(subscriptionRailStatus(FULL).needsHumanConfirmation).toBe(true);
  });

  it('refuses a provider it has no implementation for, and names it', () => {
    const env = { ...FULL, SUBSCRIPTION_PAYMENT_PROVIDER: 'gcash' };
    // Throws rather than falling back to the manual rail: a deployment that
    // believes it has automatic billing and quietly has manual billing finds
    // out a month later, from a customer.
    expect(() => resolveSubscriptionRail(env)).toThrow(/gcash/);
    expect(isPaidEnrollmentAvailable(env)).toBe(false);
    expect(subscriptionRailStatus(env).configured).toBe(false);
  });

  it('tells an operator what to set, not what is philosophically impossible', () => {
    // The old message said no rail could ever bill a monthly fee, on the
    // grounds that credits are spendable on orders only. That was true when
    // credits were the only alternative to cash and is not true now — so the
    // sentence names the three variables instead.
    const message = new NoSubscriptionPaymentRailError().message;
    expect(message).toMatch(/PAYMENT_TRANSFER_ACCOUNT_NUMBER/);
    expect(message).toMatch(/confirmed by hand/);
    expect(message).toMatch(/COMPED/);
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

/**
 * Which statuses are alive, and which of those actually confer anything.
 *
 * The two lists are deliberately different, and the difference is the whole
 * content of the paid rail: a PENDING_PAYMENT or PAST_DUE subscription is live
 * — it holds the one-live-subscription slot, the sweep looks at it, it appears
 * on the customer's screen — and confers NOTHING, because the pricing engine
 * filters on ACTIVE. Collapsing them would either give away unpaid months or
 * make an unpaid signup invisible to the billing sweep.
 */
describe('live statuses versus benefit-conferring statuses', () => {
  it('treats an unpaid enrolment and an unpaid renewal as live', () => {
    expect(LIVE_SUBSCRIPTION_STATUSES).toContain(SubscriptionStatus.PENDING_PAYMENT);
    expect(LIVE_SUBSCRIPTION_STATUSES).toContain(SubscriptionStatus.ACTIVE);
    expect(LIVE_SUBSCRIPTION_STATUSES).toContain(SubscriptionStatus.PAST_DUE);
  });

  it('and treats a cancelled or expired one as history', () => {
    expect(LIVE_SUBSCRIPTION_STATUSES).not.toContain(SubscriptionStatus.CANCELLED);
    expect(LIVE_SUBSCRIPTION_STATUSES).not.toContain(SubscriptionStatus.EXPIRED);
  });

  it('confers benefits on exactly one status', () => {
    expect([...BENEFIT_CONFERRING_STATUSES]).toEqual([SubscriptionStatus.ACTIVE]);
  });

  it('never confers on a status that is not live', () => {
    for (const status of BENEFIT_CONFERRING_STATUSES) {
      expect(LIVE_SUBSCRIPTION_STATUSES).toContain(status);
    }
  });

  it('leaves live statuses that confer nothing — the point of the split', () => {
    const liveButUnpaid = LIVE_SUBSCRIPTION_STATUSES.filter(
      (status) => !BENEFIT_CONFERRING_STATUSES.includes(status),
    );
    // If this ever becomes empty, somebody has made an unpaid enrolment
    // confer benefits, which is a month of the product given away.
    expect(liveButUnpaid).toEqual([
      SubscriptionStatus.PENDING_PAYMENT,
      SubscriptionStatus.PAST_DUE,
    ]);
  });
});

/**
 * Two sentences per state, because there are two audiences.
 *
 * Found in a browser: the console's status pill read "We are checking your
 * transfer" — the customer's wording — to the person whose job was to do the
 * checking. It told them somebody else had it in hand.
 */
describe('how a bill state is worded', () => {
  const states = Object.keys(INVOICE_STATE_TEXT) as (keyof typeof INVOICE_STATE_TEXT)[];

  it('covers the same states in both voices', () => {
    expect(states.length).toBe(5);
    expect(Object.keys(INVOICE_STATE_CONSOLE_TEXT).sort()).toEqual([...states].sort());
  });

  it('never addresses the customer on the console screen', () => {
    for (const state of states) {
      expect(
        INVOICE_STATE_CONSOLE_TEXT[state],
        `the console wording for ${state} speaks to the customer`,
      ).not.toMatch(/\byour\b|\bwe\b/i);
    }
  });

  it('and says something different where the audience differs', () => {
    // "Says they have paid" versus "We are checking your transfer": the state
    // where the two sides are doing opposite things.
    expect(INVOICE_STATE_CONSOLE_TEXT.AWAITING_REVIEW).not.toBe(
      INVOICE_STATE_TEXT.AWAITING_REVIEW,
    );
  });

  it('keeps the wording that is the same in both, the same', () => {
    // Nobody needs two ways to say "Paid".
    expect(INVOICE_STATE_CONSOLE_TEXT.SETTLED).toBe(INVOICE_STATE_TEXT.SETTLED);
  });
});

/**
 * The date on a bill, in the timezone the customer lives in.
 *
 * Manila is UTC+8 with no daylight saving, so an evening-UTC instant is already
 * the next day here. A label rendered in UTC would tell somebody their money is
 * due on the 11th when their phone says the 12th — and this is the one date in
 * the app that decides whether a subscription survives.
 */
describe('manilaDateLabel', () => {
  it('renders the Manila day, not the UTC one', () => {
    // 17:00 UTC on the 11th is 01:00 on the 12th in Manila.
    expect(manilaDateLabel(new Date('2026-09-11T17:00:00.000Z'))).toBe('September 12');
    expect(manilaDateLabel(new Date('2026-09-11T15:00:00.000Z'))).toBe('September 11');
  });

  it('names a month rather than counting days, so it survives being read late', () => {
    expect(manilaDateLabel(new Date('2026-01-31T04:00:00.000Z'))).toBe('January 31');
    expect(manilaDateLabel(new Date('2026-01-31T04:00:00.000Z'))).not.toMatch(/day|soon/i);
  });
});

/**
 * The first payment buys a month from the payment, not from the deadline.
 *
 * Separate from the renewal cases because `currentRenewsAt` means something
 * different on a new enrolment: it is the 48-hour payment deadline, not a
 * boundary anybody has bought. Found by a live-database script — the term ran
 * a month and two days, and contradicted `startedAt` on the same row.
 */
describe('the first payment', () => {
  const addMonth = addOneMonth;

  it('runs the month from the payment, not from the deadline', () => {
    const deadline = new Date('2026-09-10T00:00:00.000Z');
    const paid = new Date('2026-09-08T04:00:00.000Z');
    expect(
      nextRenewsAt({
        currentRenewsAt: deadline,
        settledAt: paid,
        addMonth,
        isFirstPayment: true,
      }),
    ).toEqual(new Date('2026-10-08T04:00:00.000Z'));
  });

  it('gives the same month to somebody who pays at the deadline', () => {
    const deadline = new Date('2026-09-10T00:00:00.000Z');
    const early = nextRenewsAt({
      currentRenewsAt: deadline,
      settledAt: new Date('2026-09-08T00:00:00.000Z'),
      addMonth,
      isFirstPayment: true,
    });
    const atTheWire = nextRenewsAt({
      currentRenewsAt: deadline,
      settledAt: deadline,
      addMonth,
      isFirstPayment: true,
    });
    // Both get a month. Paying early must not buy extra days, which is what
    // taking the later of the two dates did.
    expect(atTheWire.getTime() - early.getTime()).toBe(2 * 24 * 3600_000);
    expect(early).toEqual(new Date('2026-10-08T00:00:00.000Z'));
  });

  it('and a renewal still extends from the boundary it paid for', () => {
    // The flag must not change the renewal rule: an early payer keeps the days
    // they have already bought.
    const boundary = new Date('2026-09-30T00:00:00.000Z');
    expect(
      nextRenewsAt({
        currentRenewsAt: boundary,
        settledAt: new Date('2026-09-27T00:00:00.000Z'),
        addMonth,
      }),
    ).toEqual(new Date('2026-10-30T00:00:00.000Z'));
  });
});
