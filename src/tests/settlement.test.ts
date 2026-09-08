import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PaymentMethod,
  SettlementEntryType,
  SettlementParty,
} from '@prisma/client';
import {
  COLLECTED_BY,
  ENTRY_DIRECTION,
  ENTRY_LABEL,
  InvalidCommissionError,
  InvalidSettlementEntryError,
  MAX_COMMISSION_BASIS_POINTS,
  SettlementDoesNotBalanceError,
  arisesFromOneOrder,
  assertCommissionInRange,
  collectorFor,
  commissionCentavos,
  describePosition,
  grossOrderCentavos,
  isAccrual,
  owedToPlatformCentavos,
  payableCentavos,
  positionFrom,
  referenceIsRequired,
  settlementSideFor,
  signedSettlementAmount,
  splitOrderValue,
} from '@/lib/settlement/policy';
import { partnerEarningsCentavos } from '@/lib/fleet/offer-policy';

/**
 * Settlement.
 *
 * One idea carries this file: **every centavo of an order belongs to exactly
 * one party.** A settlement feature whose parts do not sum is one that quietly
 * loses somebody's money, and "quietly" is the problem — nobody notices until
 * a shop adds up its own week and disagrees.
 *
 * The second idea is that the direction depends on who physically collected.
 * On a cash order the rider holds the whole total, so they owe TARA; on a
 * prepaid order TARA owes them. Same ledger, opposite sign.
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

const ALL_METHODS = Object.values(PaymentMethod);
const ALL_TYPES = Object.values(SettlementEntryType);

/** A representative order: ₱350 of food, ₱39 delivery, ₱10 service fee. */
const PLAIN = {
  subtotalCentavos: 35_000,
  deliveryFeeCentavos: 3_900,
  serviceFeeCentavos: 1_000,
  smallOrderFeeCentavos: 0,
  surgeCentavos: 0,
  tipCentavos: 0,
  totalCentavos: 39_900,
};

describe('every centavo belongs to exactly one party', () => {
  it('splits a plain order into three shares that sum to the gross', () => {
    const split = splitOrderValue({
      order: PLAIN,
      riderCentavos: partnerEarningsCentavos(PLAIN),
      commissionBasisPoints: 0,
      discountedCentavos: 0,
    });

    expect(split.storeCentavos).toBe(35_000);
    expect(split.riderCentavos).toBe(3_900);
    expect(split.platformCentavos).toBe(1_000);
    expect(
      split.storeCentavos + split.riderCentavos + split.platformCentavos,
    ).toBe(split.grossCentavos);
  });

  it('holds for every combination of fees, tips and commission', () => {
    // The invariant is the feature. Exhaustive over the shapes an order can
    // actually take, because a fee that belongs to nobody is invisible until
    // somebody reconciles a month by hand.
    const subtotals = [0, 1, 4_999, 35_000, 250_000];
    const fees = [0, 1_000, 3_900];
    const tips = [0, 2_000, 10_000];
    const surges = [0, 1_500];
    const smalls = [0, 2_000];
    const rates = [0, 1, 250, 1_337, MAX_COMMISSION_BASIS_POINTS];

    for (const subtotalCentavos of subtotals) {
      for (const deliveryFeeCentavos of fees) {
        for (const tipCentavos of tips) {
          for (const surgeCentavos of surges) {
            for (const smallOrderFeeCentavos of smalls) {
              for (const commissionBasisPoints of rates) {
                const order = {
                  subtotalCentavos,
                  deliveryFeeCentavos,
                  serviceFeeCentavos: 1_000,
                  smallOrderFeeCentavos,
                  surgeCentavos,
                  tipCentavos,
                  totalCentavos: 0,
                };
                const split = splitOrderValue({
                  order,
                  riderCentavos: partnerEarningsCentavos(order),
                  commissionBasisPoints,
                  discountedCentavos: 0,
                });

                const label = JSON.stringify({ order, commissionBasisPoints });
                expect(
                  split.storeCentavos + split.riderCentavos + split.platformCentavos,
                  label,
                ).toBe(grossOrderCentavos(order));
                // And nobody is assigned a negative share.
                expect(split.storeCentavos, label).toBeGreaterThanOrEqual(0);
                expect(split.riderCentavos, label).toBeGreaterThanOrEqual(0);
                expect(split.platformCentavos, label).toBeGreaterThanOrEqual(0);
              }
            }
          }
        }
      }
    }
  });

  it('gives the platform the REMAINDER rather than its own formula', () => {
    // This is what makes the split exhaustive by construction: a fee added to
    // the schema next year lands in the platform's share automatically rather
    // than belonging to nobody. Asserted against the code because the property
    // is structural — a test over today's fields cannot see a field that does
    // not exist yet.
    const policy = codeOnly('src/lib/settlement/policy.ts');
    expect(policy).toMatch(
      /platformCentavos = grossCentavos - storeCentavos - riderCentavos/,
    );
  });

  it('refuses to return a split that does not balance', () => {
    // Unreachable today, and kept for the day somebody gives the platform its
    // own formula.
    expect(
      () =>
        splitOrderValue({
          order: PLAIN,
          // More than the whole order: the rider's share cannot be satisfied.
          riderCentavos: 100_000,
          commissionBasisPoints: 0,
          discountedCentavos: 0,
        }),
      // Caught as a negative platform share rather than an unbalanced sum,
      // which is the same defect arriving one line earlier.
    ).toThrow(SettlementDoesNotBalanceError);
  });
});

describe('the gross is not what the customer paid', () => {
  it('ignores discounts, so a waiver never comes out of a partner’s pay', () => {
    // A subscription that waives the delivery fee still owes the rider the
    // fee. TARA absorbs it. Computing settlement on `totalCentavos` would
    // silently pay the rider nothing for that ride.
    const waived = { ...PLAIN, totalCentavos: 36_000 };
    const split = splitOrderValue({
      order: waived,
      riderCentavos: partnerEarningsCentavos(waived),
      commissionBasisPoints: 0,
      discountedCentavos: 3_900,
    });

    expect(split.riderCentavos).toBe(3_900);
    expect(split.grossCentavos).toBe(39_900);
    // TARA's share carries the cost of the waiver.
    expect(split.platformNetCentavos).toBe(1_000 - 3_900);
    expect(split.platformNetCentavos).toBeLessThan(0);
  });

  it('lets the platform lose money on an order, and says so', () => {
    // A heavily promoted order is a real loss and the number should be
    // negative rather than clamped. Clamping is how a business loses money it
    // cannot see.
    const split = splitOrderValue({
      order: PLAIN,
      riderCentavos: partnerEarningsCentavos(PLAIN),
      commissionBasisPoints: 0,
      discountedCentavos: 20_000,
    });
    expect(split.platformNetCentavos).toBe(-19_000);
  });

  it('counts credits spent as a cost at redemption', () => {
    // Credits were granted for nothing and are spent on real food a shop must
    // be paid for. The cost lands when they are redeemed, which is here.
    const split = splitOrderValue({
      order: PLAIN,
      riderCentavos: 3_900,
      commissionBasisPoints: 0,
      discountedCentavos: 5_000,
    });
    expect(split.storeCentavos).toBe(35_000);
    expect(split.platformNetCentavos).toBe(1_000 - 5_000);
  });
});

describe('commission', () => {
  it('is zero by default so switching settlement on invents no revenue', () => {
    const schema = source('prisma/schema.prisma');
    expect(schema).toMatch(/commissionBasisPoints Int @default\(0\)/);
  });

  it('applies to the food and nothing else', () => {
    const split = splitOrderValue({
      order: { ...PLAIN, tipCentavos: 10_000 },
      riderCentavos: partnerEarningsCentavos({ ...PLAIN, tipCentavos: 10_000 }),
      commissionBasisPoints: 1_000, // 10%
      discountedCentavos: 0,
    });
    // 10% of ₱350, and not a centavo of the ₱100 tip or the ₱39 fee.
    expect(split.storeCentavos).toBe(35_000 - 3_500);
    expect(split.riderCentavos).toBe(3_900 + 10_000);
  });

  it('rounds in the shop’s favour', () => {
    // 1 basis point of ₱49.99 is 0.4999 centavos. It stays with the shop.
    // Over thousands of orders it costs TARA a few pesos and can never be
    // described as shaving money off a partner.
    expect(commissionCentavos(4_999, 1)).toBe(0);
    expect(commissionCentavos(4_999, 250)).toBe(124); // 124.975 floored
  });

  it('refuses a rate that is a typo rather than a deal', () => {
    for (const bad of [-1, 5_001, 10_000, 2.5, Number.NaN]) {
      expect(() => assertCommissionInRange(bad), String(bad)).toThrow(
        InvalidCommissionError,
      );
    }
    for (const good of [0, 1, 250, MAX_COMMISSION_BASIS_POINTS]) {
      expect(() => assertCommissionInRange(good), String(good)).not.toThrow();
    }
  });

  it('is capped in the database as well', () => {
    const guards = source('prisma/sql/settlement_append_only.sql');
    expect(guards).toMatch(/store_commission_in_range/);
    expect(guards).toMatch(new RegExp(`<= ${MAX_COMMISSION_BASIS_POINTS}`));
  });
});

describe('who is holding the money', () => {
  it('puts a cash order in the rider’s pocket', () => {
    expect(collectorFor(PaymentMethod.CASH_ON_DELIVERY)).toBe('RIDER');
  });

  it('puts a prepaid order and a credits order in ours', () => {
    expect(collectorFor(PaymentMethod.MANUAL_TRANSFER)).toBe('PLATFORM');
    // Nothing was collected from anybody — the customer spent credits we
    // granted — and the shop and rider are still owed real money by us.
    expect(collectorFor(PaymentMethod.WALLET_CREDIT)).toBe('PLATFORM');
  });

  it('has an answer for every method', () => {
    // A new instrument defaulting to the wrong pocket is money in the wrong
    // person's hands.
    for (const method of ALL_METHODS) {
      expect(Object.keys(COLLECTED_BY), method).toContain(method);
      expect(['RIDER', 'PLATFORM']).toContain(COLLECTED_BY[method]);
    }
  });
});

describe('a cash order leaves the rider owing money', () => {
  it('nets earnings against what they collected', () => {
    // The case the whole ledger exists for. ₱399 collected, ₱39 earned.
    const position = positionFrom([
      { type: SettlementEntryType.ORDER_EARNINGS, amountCentavos: 3_900 },
      { type: SettlementEntryType.CASH_COLLECTED, amountCentavos: -39_900 },
    ]);
    expect(position.balanceCentavos).toBe(-36_000);
    expect(settlementSideFor(position)).toBe('THEY_OWE');
    expect(owedToPlatformCentavos(position)).toBe(36_000);
    // And nothing is payable to somebody already holding our money.
    expect(payableCentavos(position)).toBe(0);
  });

  it('returns to square when they hand the cash in', () => {
    const position = positionFrom([
      { type: SettlementEntryType.ORDER_EARNINGS, amountCentavos: 3_900 },
      { type: SettlementEntryType.CASH_COLLECTED, amountCentavos: -39_900 },
      { type: SettlementEntryType.CASH_REMITTED, amountCentavos: 36_000 },
    ]);
    expect(position.balanceCentavos).toBe(0);
    expect(settlementSideFor(position)).toBe('SQUARE');
  });

  it('leaves a prepaid order owed TO the rider', () => {
    const position = positionFrom([
      { type: SettlementEntryType.ORDER_EARNINGS, amountCentavos: 3_900 },
    ]);
    expect(position.balanceCentavos).toBe(3_900);
    expect(settlementSideFor(position)).toBe('WE_OWE');
    expect(payableCentavos(position)).toBe(3_900);
  });

  it('keeps the categories honest', () => {
    const position = positionFrom([
      { type: SettlementEntryType.ORDER_EARNINGS, amountCentavos: 3_900 },
      { type: SettlementEntryType.CASH_COLLECTED, amountCentavos: -39_900 },
      { type: SettlementEntryType.CASH_REMITTED, amountCentavos: 30_000 },
      { type: SettlementEntryType.PAYOUT_SENT, amountCentavos: -1_000 },
      { type: SettlementEntryType.ADJUSTMENT, amountCentavos: 500 },
    ]);
    expect(position.earnedCentavos).toBe(3_900);
    expect(position.collectedCentavos).toBe(39_900);
    expect(position.remittedCentavos).toBe(30_000);
    expect(position.paidOutCentavos).toBe(1_000);
    // The adjustment counts in the balance and in no category: it is by
    // definition the case the categories did not anticipate.
    expect(position.balanceCentavos).toBe(3_900 - 39_900 + 30_000 - 1_000 + 500);
  });
});

describe('the direction of an entry comes from its type', () => {
  it('has a direction for every type', () => {
    for (const type of ALL_TYPES) {
      expect(Object.keys(ENTRY_DIRECTION), type).toContain(type);
      expect([-1, 1]).toContain(ENTRY_DIRECTION[type]);
    }
  });

  it('makes earnings and remittances positive, payouts and collection negative', () => {
    expect(signedSettlementAmount(SettlementEntryType.ORDER_EARNINGS, 3_900)).toBe(3_900);
    expect(signedSettlementAmount(SettlementEntryType.CASH_REMITTED, 3_900)).toBe(3_900);
    expect(signedSettlementAmount(SettlementEntryType.CASH_COLLECTED, 3_900)).toBe(-3_900);
    expect(signedSettlementAmount(SettlementEntryType.PAYOUT_SENT, 3_900)).toBe(-3_900);
  });

  it('refuses a signed amount on a fixed-direction type', () => {
    // A caller who can pick the sign can book a payout as an earning, and
    // nobody notices until a partner complains.
    expect(() =>
      signedSettlementAmount(SettlementEntryType.PAYOUT_SENT, -3_900),
    ).toThrow(InvalidSettlementEntryError);
  });

  it('lets an adjustment go either way, because a correction does', () => {
    expect(signedSettlementAmount(SettlementEntryType.ADJUSTMENT, 500)).toBe(500);
    expect(signedSettlementAmount(SettlementEntryType.ADJUSTMENT, -500)).toBe(-500);
  });

  it('refuses zero and fractions of a centavo', () => {
    expect(() => signedSettlementAmount(SettlementEntryType.ADJUSTMENT, 0)).toThrow(
      InvalidSettlementEntryError,
    );
    expect(() =>
      signedSettlementAmount(SettlementEntryType.ORDER_EARNINGS, 12.5),
    ).toThrow(InvalidSettlementEntryError);
  });

  it('agrees with the database CHECK constraint', () => {
    const guards = source('prisma/sql/settlement_append_only.sql');
    for (const type of ALL_TYPES) {
      expect(guards, type).toContain(type);
    }
    expect(guards).toMatch(
      /'ORDER_EARNINGS', 'CASH_REMITTED', 'REFERRAL_BONUS'\) AND "amountCentavos" > 0/,
    );
    expect(guards).toMatch(
      /'CASH_COLLECTED', 'PAYOUT_SENT'\) AND "amountCentavos" < 0/,
    );
  });

  /**
   * An invite bonus is the first entry that is written by the system and has
   * no order behind it, which used to be the same thing. The two lists that
   * used to be one are asserted separately here, because collapsing them again
   * would either demand an order a bonus cannot supply or demand an actor the
   * system cannot name.
   */
  it('treats an invite bonus as an accrual that names no order', () => {
    expect(isAccrual(SettlementEntryType.REFERRAL_BONUS)).toBe(true);
    expect(arisesFromOneOrder(SettlementEntryType.REFERRAL_BONUS)).toBe(false);
    expect(referenceIsRequired(SettlementEntryType.REFERRAL_BONUS)).toBe(false);
    // And the two order-derived types still demand one.
    expect(arisesFromOneOrder(SettlementEntryType.ORDER_EARNINGS)).toBe(true);
    expect(arisesFromOneOrder(SettlementEntryType.CASH_COLLECTED)).toBe(true);
  });

  it('adds an invite bonus to what we owe, and not to what riding earned', () => {
    const position = positionFrom([
      { type: SettlementEntryType.ORDER_EARNINGS, amountCentavos: 8_000 },
      { type: SettlementEntryType.REFERRAL_BONUS, amountCentavos: 50_000 },
    ]);
    expect(position.balanceCentavos).toBe(58_000);
    expect(position.bonusCentavos).toBe(50_000);
    // The whole reason it has its own field: a rider comparing what they
    // earned against the jobs they rode must not find recruitment in it.
    expect(position.earnedCentavos).toBe(8_000);
  });

  it('lets a bonus be paid out like anything else we owe', () => {
    const position = positionFrom([
      { type: SettlementEntryType.REFERRAL_BONUS, amountCentavos: 50_000 },
    ]);
    // No separate payment path: the money joins the balance and leaves in the
    // payout somebody records.
    expect(payableCentavos(position)).toBe(50_000);
    expect(settlementSideFor(position)).toBe('WE_OWE');
  });

  it('and the guards let it through with no actor and no order', () => {
    const guards = source('prisma/sql/settlement_append_only.sql');
    expect(guards).toMatch(
      /settlement_entry_actor_required[\s\S]*'REFERRAL_BONUS'/,
    );
    // Guard 6 lists only the order-derived types, so a bonus with no order is
    // accepted. If REFERRAL_BONUS ever appears in that CHECK, every bonus
    // fails at the database.
    const accrualNeedsOrder = /settlement_entry_accrual_needs_order CHECK \(([\s\S]*?)\);/.exec(
      guards,
    );
    expect(accrualNeedsOrder?.[1]).not.toContain('REFERRAL_BONUS');
  });
});

describe('nothing in this app moves money', () => {
  it('demands a reference on everything a person asserts', () => {
    // A payout, a remittance and an adjustment all claim something happened
    // outside this system. The reference is the only thing that makes the
    // claim checkable against a statement later.
    expect(referenceIsRequired(SettlementEntryType.PAYOUT_SENT)).toBe(true);
    expect(referenceIsRequired(SettlementEntryType.CASH_REMITTED)).toBe(true);
    expect(referenceIsRequired(SettlementEntryType.ADJUSTMENT)).toBe(true);
    // Accruals need none: the order is the reference.
    expect(referenceIsRequired(SettlementEntryType.ORDER_EARNINGS)).toBe(false);
    expect(referenceIsRequired(SettlementEntryType.CASH_COLLECTED)).toBe(false);
  });

  it('separates what the system writes from what a person claims', () => {
    expect(isAccrual(SettlementEntryType.ORDER_EARNINGS)).toBe(true);
    expect(isAccrual(SettlementEntryType.CASH_COLLECTED)).toBe(true);
    expect(isAccrual(SettlementEntryType.PAYOUT_SENT)).toBe(false);
  });

  it('says so on the partner’s own screen', () => {
    // A partner who expects the app to pay them will not chase a payout that
    // never arrives.
    const panel = source('src/components/settlement/PositionPanel.tsx');
    expect(panel).toMatch(/does not send money from inside the app/);
  });

  it('says so in the console too', () => {
    const page = source('src/app/admin/settlement/page.tsx');
    expect(page).toMatch(/Send the money first/);
    expect(page).toMatch(/Nothing here moves money/);
  });

  it('caps a payout at what is owed', () => {
    // Paying past the balance is an unrecorded loan the next accrual silently
    // swallows, and on a rider holding our cash it is handing money to
    // somebody already in debt to us.
    const ledger = codeOnly('src/lib/settlement/ledger.ts');
    expect(ledger).toMatch(/PayoutExceedsBalanceError/);
    expect(ledger).toMatch(/if \(-signedAmount > ceiling\)/);
    // Read inside the transaction, so a concurrent accrual cannot make it
    // stale.
    expect(ledger).toMatch(/TransactionIsolationLevel\.Serializable/);
  });
});

describe('the ledger keeps its own rules', () => {
  it('is append-only, with the same escape hatch as the other two', () => {
    const guards = source('prisma/sql/settlement_append_only.sql');
    expect(guards).toMatch(/settlement_entry_no_update/);
    expect(guards).toMatch(/settlement_entry_no_delete/);
    expect(guards).toMatch(/tara\.allow_purge/);
  });

  it('has no updatedAt', () => {
    const schema = stripComments(source('prisma/schema.prisma'));
    const start = schema.indexOf('model SettlementEntry {');
    const model = schema.slice(start, schema.indexOf('}', start));
    expect(model).toMatch(/createdAt/);
    expect(model).not.toMatch(/updatedAt/);
  });

  it('belongs to exactly one party, agreeing with its own column', () => {
    // A row whose `party` says STORE while carrying a fleetPartnerId would net
    // into the wrong person's balance.
    const guards = source('prisma/sql/settlement_append_only.sql');
    expect(guards).toMatch(/settlement_entry_exactly_one_party/);
    expect(guards).toMatch(/"party" = 'STORE' AND "storeId" IS NOT NULL AND "fleetPartnerId" IS NULL/);
  });

  it('does not cache the balance, and says why', () => {
    // The other two ledgers cache; this one deliberately does not, and the
    // reason has to survive somebody "making it consistent".
    const ledger = source('src/lib/settlement/ledger.ts');
    expect(ledger).toMatch(/Never cached, unlike a credits balance/);
    expect(codeOnly('src/lib/settlement/ledger.ts')).not.toMatch(
      /settlementBalanceCentavos/,
    );
  });

  it('accrues idempotently, keyed to the order and the party', () => {
    // A completion that runs twice pays once.
    const accrual = codeOnly('src/lib/settlement/accrual.ts');
    expect(accrual).toMatch(/settle-store:\$\{order\.id\}/);
    expect(accrual).toMatch(/settle-rider:\$\{order\.id\}/);
    expect(accrual).toMatch(/settle-cash:\$\{order\.id\}/);
  });

  it('accrues inside the completion transaction', () => {
    // An order that completed with no accrual is a shop that cooked food
    // nobody recorded owing it for.
    const maintenance = codeOnly('src/lib/orders/maintenance.ts');
    expect(maintenance).toMatch(/await accrueOrderSettlement\(order, tx\)/);
  });
});

describe('one definition of what a rider earns', () => {
  it('uses the same function the fleet screens show them', () => {
    // Two functions computing "what the rider earns" is how the app promises
    // one figure and settles another.
    const accrual = codeOnly('src/lib/settlement/accrual.ts');
    expect(accrual).toMatch(/partnerEarningsCentavos\(order\)/);
    // And the split takes it as an input rather than recomputing it.
    expect(codeOnly('src/lib/settlement/policy.ts')).not.toMatch(
      /riderCentavos =\s*input\.order\.deliveryFeeCentavos/,
    );
  });

  it('gives the surge to the rider, taking it off the platform', () => {
    // The pay decision, seen from the settlement side. The split needed NO
    // change for this: the platform takes the remainder, so moving surge into
    // `partnerEarningsCentavos` moved it across on its own. That is the
    // remainder design paying for itself.
    const surged = { ...PLAIN, surgeCentavos: 2_500 };
    const split = splitOrderValue({
      order: surged,
      riderCentavos: partnerEarningsCentavos(surged),
      commissionBasisPoints: 0,
      discountedCentavos: 0,
    });

    expect(split.riderCentavos).toBe(3_900 + 2_500);
    // The platform keeps only the service fee.
    expect(split.platformCentavos).toBe(1_000);
    // And the shop is untouched by any of it.
    expect(split.storeCentavos).toBe(35_000);
    expect(
      split.storeCentavos + split.riderCentavos + split.platformCentavos,
    ).toBe(split.grossCentavos);
  });

  it('still balances when a surged order has nobody to deliver it', () => {
    // Surge on an undelivered order falls to the platform rather than
    // vanishing — the remainder again.
    const surged = { ...PLAIN, surgeCentavos: 2_500 };
    const split = splitOrderValue({
      order: surged,
      riderCentavos: 0,
      commissionBasisPoints: 0,
      discountedCentavos: 0,
    });
    expect(split.platformCentavos).toBe(1_000 + 3_900 + 2_500);
    expect(
      split.storeCentavos + split.riderCentavos + split.platformCentavos,
    ).toBe(split.grossCentavos);
  });

  it('pays nothing to a rider on an order nobody delivered', () => {
    const split = splitOrderValue({
      order: PLAIN,
      riderCentavos: 0,
      commissionBasisPoints: 0,
      discountedCentavos: 0,
    });
    expect(split.riderCentavos).toBe(0);
    // The fee falls to the platform rather than vanishing.
    expect(split.platformCentavos).toBe(1_000 + 3_900);
  });
});

describe('the money is not on the client', () => {
  it('keeps the settlement policy free of server-only imports', () => {
    // Six features have now had a page 500 by reaching `next/headers` through
    // a chain that started in a module a client component imports. The fleet
    // tab bar imports this one.
    const policy = codeOnly('src/lib/settlement/policy.ts');
    expect(policy).not.toMatch(/next\/headers/);
    expect(policy).not.toMatch(/from '@\/lib\/prisma'/);
    expect(policy).not.toMatch(/from '@\/lib\/auth\//);
  });

  it('has words for every entry type a partner can be shown', () => {
    for (const type of ALL_TYPES) {
      expect(ENTRY_LABEL[type], type).toBeTruthy();
    }
  });

  it('tells a rider holding cash that it is not theirs', () => {
    const holding = positionFrom([
      { type: SettlementEntryType.CASH_COLLECTED, amountCentavos: -39_900 },
    ]);
    const sentence = describePosition(holding, SettlementParty.FLEET_PARTNER);
    expect(sentence).toMatch(/belongs to TARA/);
    expect(sentence).toMatch(/Hand it in/);
    // A shop in debt gets a different, plainer sentence: it never collected
    // anything at a door.
    expect(describePosition(holding, SettlementParty.STORE)).not.toMatch(/Hand it in/);
  });
});

describe('what settlement does NOT claim to do', () => {
  it('keeps the shop’s takings off the counter screen', () => {
    // Whoever works the till accepts orders; what the business is owed is the
    // owner's business.
    const page = source('src/app/merchant/[storeId]/payouts/page.tsx');
    expect(page).toMatch(/StoreRole\.MANAGER/);
  });

  it('does not pretend a rate change rewrites settled orders', () => {
    const page = source('src/app/admin/settlement/page.tsx');
    expect(page).toMatch(/future orders only/i);
  });
});

describe('a pay-rule change cannot restate history', () => {
  it('reads a settled job from the ledger, not from today’s rule', () => {
    // The failure this prevents: every screen showing a rider their finished
    // jobs used to RECOMPUTE earnings from `partnerEarningsCentavos`, so the
    // moment surge moved to riders, every job they had ever done silently
    // restated itself — a figure that was never accrued and never paid.
    //
    // That is the settlement ledger's own failure mode arriving from the
    // opposite direction: an app promising one number and settling another.
    const earnings = codeOnly('src/lib/settlement/earnings.ts');
    expect(earnings).toMatch(/accruedEarningsByOrder/);
    expect(earnings).toMatch(/type: SettlementEntryType\.ORDER_EARNINGS/);

    const partner = codeOnly('src/lib/fleet/partner.ts');
    // Both the job list AND the today/week totals.
    expect(partner).toMatch(/earningsFor\(order, accrued\)/);
    expect(partner).toMatch(/earningsFor\(row, accrued\)/);
  });

  it('falls back to the rule only for jobs with no ledger row', () => {
    // Orders completed before the ledger existed have none, and have to show
    // something. Safe today because no order carries surge, so the old rule
    // and the new one agree on every one of them.
    const earnings = codeOnly('src/lib/settlement/earnings.ts');
    expect(earnings).toMatch(/settled \?\? partnerEarningsCentavos\(order\)/);
  });

  it('still computes from the rule for a job in flight', () => {
    // An unsettled job has no accrual to read, and quoting the current rule is
    // exactly right there — it is what the rider will be paid.
    const partner = codeOnly('src/lib/fleet/partner.ts');
    const activeJob = partner.slice(partner.indexOf('export async function getActiveJob'));
    const body = activeJob.slice(0, activeJob.indexOf('\nexport '));
    expect(body).toMatch(/earningsCentavos: partnerEarningsCentavos\(order\)/);
  });

  it('selects surge in the query that sums a rider’s week', () => {
    // The near-miss: that query used to select only the fee and the tip, so
    // once surge became the rider's it would have been missing from the totals
    // while appearing on the job list. Two figures on one screen, disagreeing.
    const partner = codeOnly('src/lib/fleet/partner.ts');
    expect(partner).toMatch(/surgeCentavos: true/);
  });

  it('attributes only earnings to a job, not adjustments', () => {
    // An adjustment belongs on a partner's statement. Filing it against a job
    // would say that job paid it.
    const earnings = codeOnly('src/lib/settlement/earnings.ts');
    expect(earnings).not.toMatch(/ADJUSTMENT/);
  });
});

describe('what surge still does not do', () => {
  it('is set by nothing, and the docs say so', () => {
    // The rule now sends surge to riders. Nothing decides when surge applies
    // or how much — `quoteOrderPrice` accepts it and no caller passes it — so
    // this governs orders that do not exist yet. Recorded here so the next
    // person does not go looking for the pricing logic.
    const checkout = codeOnly('src/lib/pricing/checkout.ts');
    expect(checkout).toMatch(/surgeCentavos: input\.surgeCentavos \?\? 0/);

    const placeOrder = codeOnly('src/lib/orders/place-order.ts');
    // Placement passes through whatever the quote produced and invents nothing.
    expect(placeOrder).toMatch(/surgeCentavos: quote\.price\.surgeCentavos/);
    expect(placeOrder).not.toMatch(/surgeCentavos: \d/);
  });
});
