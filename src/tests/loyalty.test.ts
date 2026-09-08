import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminAction, LoyaltyEntryType } from '@prisma/client';
import {
  MAX_POINTS_PER_PESO_BASIS_POINTS,
  PROGRAMME_OFF,
  REDEMPTION_REFUSAL_TEXT,
  effectiveGivebackBasisPoints,
  expiryFor,
  largestRedemption,
  multiplierFor,
  outstandingLiabilityCentavos,
  pointsForOrder,
  pointsValueCentavos,
  programmeIsLive,
  quoteRedemption,
  tierFor,
  tierWindowStart,
  type ProgrammeFacts,
  type RedemptionRefusal,
  type TierFacts,
} from '@/lib/loyalty/policy';
import { signedPointsFor, InvalidLoyaltyEntryError } from '@/lib/loyalty/ledger';
import { ADMIN_ACTION_LABEL } from '@/lib/admin/access';

/**
 * Loyalty points.
 *
 * Two ideas carry this file.
 *
 * **Points are not a second currency.** They convert to credits, and credits
 * are the one thing a customer can spend. Anything here that let points pay for
 * an order directly, or created credits without consuming points, would be the
 * defect worth catching.
 *
 * **Redemption is the only place a CUSTOMER causes credits to exist.** A
 * referral needs somebody else to sign up and order; a promo needs an
 * administrator; this needs one tap. So the arithmetic is tested at its
 * boundaries and the concurrency is tested against a real database next door.
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

/** One point per peso, 100 points to the peso back, blocks of 500. */
const LIVE: ProgrammeFacts = {
  isActive: true,
  pointsPerPesoBasisPoints: 10_000,
  pointsPerPesoRedeemed: 100,
  redemptionBlockPoints: 500,
  expiryMonths: 12,
  tierWindowMonths: 12,
};

const LADDER: TierFacts[] = [
  { id: 'suki', name: 'Suki', thresholdPoints: 0, earnMultiplierBasisPoints: 10_000, blurb: 'Everybody starts here' },
  { id: 'tapat', name: 'Tapat', thresholdPoints: 5_000, earnMultiplierBasisPoints: 12_500, blurb: 'Earns a quarter faster' },
  { id: 'haligi', name: 'Haligi', thresholdPoints: 20_000, earnMultiplierBasisPoints: 15_000, blurb: 'Earns half again' },
];

describe('off by default', () => {
  it('ships off and earns nothing', () => {
    expect(programmeIsLive(PROGRAMME_OFF)).toBe(false);
    expect(pointsForOrder(PROGRAMME_OFF, { subtotalCentavos: 100_000 }, null)).toBe(0);
  });

  it('an absent row reads as off rather than as a default rate', () => {
    expect(codeOnly('src/lib/loyalty/programme.ts')).toMatch(
      /if \(!row\) return PROGRAMME_OFF/,
    );
  });

  it('is not live merely because it is switched on', () => {
    // A zero earn rate shows a balance that can never grow; a zero redemption
    // rate shows one that can never be spent. Both are worse than saying no.
    expect(programmeIsLive({ ...PROGRAMME_OFF, isActive: true })).toBe(false);
    expect(
      programmeIsLive({ ...LIVE, pointsPerPesoRedeemed: 0 }),
    ).toBe(false);
    expect(programmeIsLive({ ...LIVE, redemptionBlockPoints: 0 })).toBe(false);
  });
});

describe('earning', () => {
  it('earns on the subtotal at the configured rate', () => {
    expect(pointsForOrder(LIVE, { subtotalCentavos: 35_000 }, null)).toBe(350);
  });

  it('earns on the FOOD only, never the rider’s money', () => {
    // The delivery fee, surge and tip are the rider's. Rewarding a customer in
    // proportion to what we paid somebody else is both odd and gameable: a
    // distant address would earn more than a near one for the same food.
    const earning = codeOnly('src/lib/loyalty/policy.ts');
    const fn = earning.slice(earning.indexOf('export function pointsForOrder'));
    expect(fn).toMatch(/order\.subtotalCentavos/);
    expect(fn).not.toMatch(/deliveryFeeCentavos|surgeCentavos|tipCentavos/);
  });

  it('rounds down, never up', () => {
    // A customer short of a point never notices. One given a point they had
    // not earned makes the balance disagree with the rule that produced it —
    // and rounding up across a million orders is a cost nobody chose.
    expect(pointsForOrder(LIVE, { subtotalCentavos: 35_099 }, null)).toBe(350);
    expect(
      pointsForOrder({ ...LIVE, pointsPerPesoBasisPoints: 15_000 }, { subtotalCentavos: 3_00 }, null),
    ).toBe(4); // 3 pesos × 1.5 = 4.5, floored
  });

  it('earns nothing on an order worth nothing', () => {
    expect(pointsForOrder(LIVE, { subtotalCentavos: 0 }, null)).toBe(0);
    expect(pointsForOrder(LIVE, { subtotalCentavos: 99 }, null)).toBe(0);
  });

  it('multiplies by the tier in force', () => {
    expect(pointsForOrder(LIVE, { subtotalCentavos: 40_000 }, LADDER[0]!)).toBe(400);
    expect(pointsForOrder(LIVE, { subtotalCentavos: 40_000 }, LADDER[1]!)).toBe(500);
    expect(pointsForOrder(LIVE, { subtotalCentavos: 40_000 }, LADDER[2]!)).toBe(600);
  });

  it('treats no tier as no change', () => {
    expect(multiplierFor(null)).toBe(1);
  });

  it('reads the tier once, at the moment of earning', () => {
    // The lesson `settlement/earnings.ts` learned about rider pay: a derived
    // figure recomputed on read rewrites itself whenever the formula changes.
    // Points are stored when earned and never recalculated.
    const earning = codeOnly('src/lib/loyalty/earning.ts');
    expect(earning).toMatch(/type: LoyaltyEntryType\.EARNED/);
    expect(earning).toMatch(/idempotencyKey: `loyalty-earn:\$\{order\.id\}`/);
  });
});

describe('tiers', () => {
  it('puts a new customer in the base tier', () => {
    expect(tierFor(LADDER, 0).current?.name).toBe('Suki');
    expect(tierFor(LADDER, 0).next?.name).toBe('Tapat');
    expect(tierFor(LADDER, 0).pointsToNext).toBe(5_000);
  });

  it('promotes at exactly the threshold', () => {
    expect(tierFor(LADDER, 4_999).current?.name).toBe('Suki');
    expect(tierFor(LADDER, 5_000).current?.name).toBe('Tapat');
  });

  it('reports nothing above the top', () => {
    const top = tierFor(LADDER, 999_999);
    expect(top.current?.name).toBe('Haligi');
    expect(top.next).toBeNull();
    expect(top.pointsToNext).toBe(0);
  });

  it('handles a ladder given out of order', () => {
    const shuffled = [LADDER[2]!, LADDER[0]!, LADDER[1]!];
    expect(tierFor(shuffled, 5_000).current?.name).toBe('Tapat');
  });

  it('reports no tier when no ladder is configured', () => {
    // Not an error: a programme can earn points with no status attached.
    expect(tierFor([], 10_000).current).toBeNull();
  });

  it('is calculated from points EARNED, not from the balance', () => {
    // Redeeming must not demote somebody. Spending points is the thing the
    // programme wants; a tier that punished it would teach people to hoard,
    // and then teach them the programme is a trick.
    const programme = codeOnly('src/lib/loyalty/programme.ts');
    const fn = programme.slice(programme.indexOf('export async function pointsEarnedInWindow'));
    expect(fn).toMatch(/type: LoyaltyEntryType\.EARNED/);
    expect(fn).not.toMatch(/pointsBalance/);
  });

  it('uses a rolling window, not a lifetime', () => {
    // A tier nobody can lose is not a reason to order again.
    const now = new Date('2026-09-08T00:00:00.000Z');
    expect(tierWindowStart(LIVE, now).toISOString()).toBe('2025-09-08T00:00:00.000Z');
  });

  it('never has a zero-length window, whatever the row says', () => {
    const now = new Date('2026-09-08T00:00:00.000Z');
    const start = tierWindowStart({ ...LIVE, tierWindowMonths: 0 }, now);
    expect(start.getTime()).toBeLessThan(now.getTime());
  });

  it('changes only the earn rate, never a bill', () => {
    // Deliberately not a fourth discount mechanism: this app already has
    // three, and each interacts with the others inside applyBenefits.
    const schema = source('prisma/schema.prisma');
    const model = schema.slice(schema.indexOf('model LoyaltyTier'));
    expect(model).toMatch(/earnMultiplierBasisPoints/);
    expect(model.slice(0, model.indexOf('}'))).not.toMatch(
      /freeDelivery|discountCentavos|percentBasisPoints/,
    );
    // And nothing loyalty-shaped appears in the checkout arithmetic.
    expect(codeOnly('src/lib/pricing/benefits.ts')).not.toMatch(/loyalty|tier/i);
    expect(codeOnly('src/lib/pricing/checkout.ts')).not.toMatch(/loyalty|tier/i);
  });
});

describe('redeeming', () => {
  it('converts a whole block at the configured rate', () => {
    expect(
      quoteRedemption(LIVE, { pointsRequested: 500, pointsAvailable: 1_437 }),
    ).toEqual({ pointsSpent: 500, centavosGranted: 500, refusal: null });
  });

  it('refuses a part-block rather than silently flooring it', () => {
    // Somebody who asks for 700 should be told it will be 500, not quietly
    // given 500 and left wondering where the rest went.
    expect(
      quoteRedemption(LIVE, { pointsRequested: 700, pointsAvailable: 1_437 }).refusal,
    ).toBe('NOT_A_WHOLE_BLOCK');
  });

  it('refuses more than is held', () => {
    expect(
      quoteRedemption(LIVE, { pointsRequested: 1_500, pointsAvailable: 1_437 }).refusal,
    ).toBe('NOT_ENOUGH_POINTS');
  });

  it('refuses nothing, and negatives', () => {
    expect(quoteRedemption(LIVE, { pointsRequested: 0, pointsAvailable: 500 }).refusal).toBe(
      'NOTHING_REQUESTED',
    );
    expect(quoteRedemption(LIVE, { pointsRequested: -500, pointsAvailable: 500 }).refusal).toBe(
      'NOTHING_REQUESTED',
    );
  });

  it('refuses while the programme is off', () => {
    expect(
      quoteRedemption(PROGRAMME_OFF, { pointsRequested: 500, pointsAvailable: 5_000 }).refusal,
    ).toBe('PROGRAMME_OFF');
  });

  it('offers the largest whole block a balance allows', () => {
    expect(largestRedemption(LIVE, 1_437)).toEqual({
      pointsSpent: 1_000,
      centavosGranted: 1_000,
      refusal: null,
    });
  });

  it('offers nothing below one block, and says which refusal', () => {
    expect(largestRedemption(LIVE, 499).refusal).toBe('NOT_ENOUGH_POINTS');
  });

  it('leaves no fraction of a centavo, at any rate', () => {
    for (const rate of [1, 3, 7, 100, 250]) {
      for (const block of [rate, rate * 2, rate * 13]) {
        const quote = quoteRedemption(
          { ...LIVE, pointsPerPesoRedeemed: rate, redemptionBlockPoints: block },
          { pointsRequested: block, pointsAvailable: block },
        );
        expect(Number.isInteger(quote.centavosGranted)).toBe(true);
      }
    }
  });

  it('names every refusal it can return', () => {
    const refusals: RedemptionRefusal[] = [
      'PROGRAMME_OFF',
      'NOT_ENOUGH_POINTS',
      'NOT_A_WHOLE_BLOCK',
      'NOTHING_REQUESTED',
    ];
    for (const refusal of refusals) {
      expect(REDEMPTION_REFUSAL_TEXT[refusal].length).toBeGreaterThan(10);
    }
    expect(Object.keys(REDEMPTION_REFUSAL_TEXT).sort()).toEqual([...refusals].sort());
  });

  it('keeps the confirmation on screen after the balance drops', () => {
    // Found in a browser. The redeem control used to render only when a
    // redemption was available, with the page showing a "you need more
    // points" line otherwise — so redeeming dropped the balance below a block,
    // the refresh replaced the control with that line, and the success message
    // went with it. The points moved, the credits moved, and the customer was
    // told nothing, which is indistinguishable from a tap that failed.
    const component = codeOnly('src/components/loyalty/RedeemPoints.tsx');
    // One component owns both states, so its own result survives the refresh.
    expect(component).toMatch(/offer \? \(/);
    expect(component).toMatch(/blockPoints > 0/);
    expect(component).toMatch(/role="alert"/);
    const page = codeOnly('src/app/points/page.tsx');
    // And the page no longer chooses between the control and a paragraph.
    expect(page).not.toMatch(/summary\.offer\.refusal === null \? \(\s*<RedeemPoints/);
    expect(page).toMatch(/<RedeemPoints/);
  });

  it('shows a balance in pesos alongside the points, always', () => {
    // A screen saying "1,437 points" alone asks the customer to do the
    // programme's arithmetic, and their guess will be wrong in whichever
    // direction disappoints them.
    expect(pointsValueCentavos(LIVE, 1_437)).toBe(1_437);
    expect(pointsValueCentavos(PROGRAMME_OFF, 1_437)).toBe(0);
    const page = codeOnly('src/app/points/page.tsx');
    expect(page).toMatch(/valueCentavos/);
  });
});

describe('the sign is derived from the type', () => {
  it('makes earning positive and spending negative', () => {
    expect(signedPointsFor(LoyaltyEntryType.EARNED, 100)).toBe(100);
    expect(signedPointsFor(LoyaltyEntryType.REDEEMED, 100)).toBe(-100);
    expect(signedPointsFor(LoyaltyEntryType.EXPIRED, 100)).toBe(-100);
  });

  it('refuses a caller that tries to supply the sign itself', () => {
    // What makes "spending points added to a balance" unrepresentable rather
    // than merely unlikely.
    expect(() => signedPointsFor(LoyaltyEntryType.REDEEMED, -100)).toThrow(
      InvalidLoyaltyEntryError,
    );
    expect(() => signedPointsFor(LoyaltyEntryType.EARNED, -100)).toThrow(
      InvalidLoyaltyEntryError,
    );
  });

  it('lets an adjustment go either way, but not nowhere', () => {
    expect(signedPointsFor(LoyaltyEntryType.ADJUSTED, -250)).toBe(-250);
    expect(signedPointsFor(LoyaltyEntryType.ADJUSTED, 250)).toBe(250);
    expect(() => signedPointsFor(LoyaltyEntryType.ADJUSTED, 0)).toThrow(
      InvalidLoyaltyEntryError,
    );
  });

  it('refuses a fraction of a point', () => {
    expect(() => signedPointsFor(LoyaltyEntryType.EARNED, 1.5)).toThrow(
      InvalidLoyaltyEntryError,
    );
  });

  it('agrees with the sign guard in the database', () => {
    const guards = source('prisma/sql/loyalty.sql');
    expect(guards).toMatch(/'EARNED' AND "points" > 0/);
    expect(guards).toMatch(/'REDEEMED', 'EXPIRED'\) AND "points" < 0/);
    expect(guards).toMatch(/'ADJUSTED' AND "points" <> 0/);
  });
});

describe('the ledger keeps the same rules as the other three', () => {
  it('is append-only, with the same escape hatch', () => {
    const guards = source('prisma/sql/loyalty.sql');
    expect(guards).toMatch(/loyalty_entry_no_update/);
    expect(guards).toMatch(/loyalty_entry_no_delete/);
    expect(guards).toMatch(/tara\.allow_purge/);
  });

  it('writes the balance in exactly one place, derived from the sum', () => {
    const ledger = codeOnly('src/lib/loyalty/ledger.ts');
    expect((ledger.match(/loyaltyAccount\.update\(/g) ?? []).length).toBe(2);
    expect(ledger).toMatch(/const priorBalance = await sumLedger\(tx, account\.id\)/);
    // The one other update is the reconciler, which also writes the sum.
    expect(ledger).toMatch(/export async function reconcileLoyaltyBalance/);
  });

  it('reads the balance from the ledger, not the cached column', () => {
    const ledger = codeOnly('src/lib/loyalty/ledger.ts');
    const fn = ledger.slice(ledger.indexOf('export async function recordLoyaltyEntry'));
    expect(fn).toMatch(/sumLedger\(tx, account\.id\)/);
  });

  it('runs at serializable, because two taps can race', () => {
    const ledger = codeOnly('src/lib/loyalty/ledger.ts');
    expect(ledger).toMatch(/TransactionIsolationLevel\.Serializable/);
    expect(codeOnly('src/lib/loyalty/redemption.ts')).toMatch(
      /TransactionIsolationLevel\.Serializable/,
    );
  });

  it('cannot go negative, in code and in the database', () => {
    expect(codeOnly('src/lib/loyalty/ledger.ts')).toMatch(
      /if \(nextBalance < 0\)[\s\S]{0,80}InsufficientPointsError/,
    );
    expect(source('prisma/sql/loyalty.sql')).toMatch(
      /loyalty_account_balance_non_negative/,
    );
  });

  it('has no updatedAt on the entries', () => {
    const schema = stripComments(source('prisma/schema.prisma'));
    const start = schema.indexOf('model LoyaltyEntry {');
    const model = schema.slice(start, schema.indexOf('}', start));
    expect(model).toMatch(/createdAt/);
    expect(model).not.toMatch(/updatedAt/);
  });

  it('reports a replay rather than letting a caller guess', () => {
    // The caller's first version compared the row's createdAt against the
    // clock, which is wrong under clock skew and wrong in the direction that
    // double-counts.
    expect(codeOnly('src/lib/loyalty/ledger.ts')).toMatch(/replayed: true/);
    expect(codeOnly('src/lib/loyalty/earning.ts')).toMatch(/earned: !result\.replayed/);
  });
});

describe('points become money only through the credits ledger', () => {
  it('grants credits through the wallet’s own write function', () => {
    const redemption = codeOnly('src/lib/loyalty/redemption.ts');
    expect(redemption).toMatch(/recordWalletTransaction\(/);
    expect(redemption).not.toMatch(/balanceCentavos:/);
    expect(redemption).not.toMatch(/wallet\.update/);
  });

  it('links the two rows, so neither can exist alone', () => {
    const guards = source('prisma/sql/loyalty.sql');
    expect(guards).toMatch(/loyalty_entry_redeemed_names_its_credit/);
    // And nothing but a redemption may claim a credits row: an EARNED row
    // pointing at one would mean points had been paid out twice.
    expect(guards).toMatch(/loyalty_entry_only_redemption_has_credit/);
  });

  it('never lets points pay for an order directly', () => {
    // There is one spendable balance and one place that spends it.
    for (const file of ['src/lib/orders/place-order.ts', 'src/lib/pricing/checkout.ts']) {
      expect(codeOnly(file)).not.toMatch(/loyalty|points/i);
    }
  });

  it('requires an order behind every point earned', () => {
    expect(source('prisma/sql/loyalty.sql')).toMatch(
      /loyalty_entry_earned_needs_order/,
    );
    expect(codeOnly('src/lib/loyalty/ledger.ts')).toMatch(
      /EARNED requires a relatedOrderId/,
    );
  });

  it('says the credits constraints out loud on the points screen', () => {
    const page = source('src/app/points/page.tsx').replace(/\s+/g, ' ');
    expect(page).toContain('only be spent on orders in this app');
    expect(page).toContain('cannot be sent to anybody or turned back into cash');
  });
});

describe('expiry', () => {
  it('sets a date only when the programme says so', () => {
    const earnedAt = new Date('2026-09-08T00:00:00.000Z');
    expect(expiryFor(LIVE, earnedAt)?.toISOString()).toBe('2027-09-08T00:00:00.000Z');
    expect(expiryFor({ ...LIVE, expiryMonths: 0 }, earnedAt)).toBeNull();
  });

  it('only ever attaches to earned points', () => {
    expect(source('prisma/sql/loyalty.sql')).toMatch(
      /loyalty_entry_only_earned_expires/,
    );
    expect(codeOnly('src/lib/loyalty/ledger.ts')).toMatch(
      /Only earned points expire/,
    );
  });

  it('consumes the OLDEST earnings with what has been spent', () => {
    // Otherwise somebody who redeems promptly finds their remainder expiring
    // on the oldest earning's clock — punishing the behaviour the programme
    // rewards.
    const expiry = codeOnly('src/lib/loyalty/expiry.ts');
    expect(expiry).toMatch(/orderBy: \{ expiresAt: 'asc' \}/);
    expect(expiry).toMatch(/alreadyGone -= earning\.points/);
  });

  it('walks the netting in exactly one place', () => {
    // It was written out twice — once for "what has expired" and once for
    // "what expires next" — which is two chances to net differently and no
    // way to notice.
    const expiry = codeOnly('src/lib/loyalty/expiry.ts');
    expect((expiry.match(/let alreadyGone/g) ?? []).length).toBe(1);
    expect(expiry).toMatch(/async function livePortions/);
  });

  it('warns before it happens, not after', () => {
    // A balance that quietly shrank is indistinguishable from a bug.
    expect(codeOnly('src/lib/loyalty/expiry.ts')).toMatch(
      /export async function nextExpiryFor/,
    );
    expect(codeOnly('src/app/points/page.tsx')).toMatch(/nextExpiry/);
  });

  it('runs on the sweep, and skips entirely when nothing expires', () => {
    const sweep = codeOnly('src/lib/orders/maintenance.ts');
    expect(sweep).toMatch(/await expireLoyaltyPoints\(\)/);
    const expiry = codeOnly('src/lib/loyalty/expiry.ts');
    expect(expiry).toMatch(/if \(programme\.expiryMonths <= 0\) return/);
  });
});

describe('what the programme costs', () => {
  it('reports the giveback as a percentage of food value', () => {
    // The number an operator needs, from two rates pointing in opposite
    // directions — easy to get wrong by a factor of ten.
    expect(effectiveGivebackBasisPoints(LIVE)).toBe(100); // 1%
    expect(
      effectiveGivebackBasisPoints({ ...LIVE, pointsPerPesoBasisPoints: 20_000 }),
    ).toBe(200); // 2 points per peso at 100 to the peso = 2%
    expect(effectiveGivebackBasisPoints(PROGRAMME_OFF)).toBe(0);
  });

  it('reports the outstanding liability in pesos', () => {
    expect(outstandingLiabilityCentavos(LIVE, 250_000)).toBe(250_000);
  });

  it('agrees with the earn-rate ceiling the database enforces', () => {
    expect(source('prisma/sql/loyalty.sql')).toContain(
      `<= ${MAX_POINTS_PER_PESO_BASIS_POINTS}`,
    );
  });

  it('puts the liability and the expiry setting on one screen', () => {
    // With no expiry that figure only ever goes up, and it grows fastest among
    // customers who stopped ordering.
    const page = codeOnly('src/app/admin/loyalty/page.tsx');
    expect(page).toMatch(/liabilityCentavos/);
    expect(page).toMatch(/expiryMonths === 0/);
    expect(page).toMatch(/role="alert"/);
  });

  it('shows points nobody can ever redeem', () => {
    // A large stranded total means the block size is too high and the
    // programme is quietly not paying out.
    const page = codeOnly('src/app/admin/loyalty/page.tsx');
    expect(page).toMatch(/strandedAccounts/);
    expect(codeOnly('src/lib/admin/loyalty.ts')).toMatch(
      /lt: programme\.redemptionBlockPoints/,
    );
  });

  it('counts tier holders once, not once per tier', () => {
    // The first version was a count per tier with a duplicated object key, so
    // every tier reported the same number — the same wrong figure down the
    // column, which reads as data rather than as a bug.
    const admin = codeOnly('src/lib/admin/loyalty.ts');
    expect(admin).toMatch(/groupBy\(\{\s*by: \['accountId'\]/);
    expect(admin).toMatch(/tierFor\(ladder, earned\)/);
  });
});

describe('changing the programme is an audited decision', () => {
  it('names all three actions in the log’s vocabulary', () => {
    for (const action of [
      AdminAction.LOYALTY_PROGRAMME_CHANGED,
      AdminAction.LOYALTY_TIER_CHANGED,
      AdminAction.LOYALTY_POINTS_ADJUSTED,
    ]) {
      expect(ADMIN_ACTION_LABEL[action].length).toBeGreaterThan(5);
    }
  });

  it('demands a reason and records before and after', () => {
    const actions = codeOnly('src/lib/actions/admin-actions.ts');
    // Sliced on CODE landmarks, not on a section comment: `codeOnly` strips
    // comments, so slicing to '// --- Referrals' ran to the end of the file
    // and counted every other action's reason too.
    const loyalty = actions.slice(
      actions.indexOf('setLoyaltyProgrammeAction'),
      actions.indexOf('setReferralProgrammeAction'),
    );
    expect(loyalty.length).toBeGreaterThan(500);
    expect(loyalty).not.toMatch(/farmerMargin/);
    expect(
      (loyalty.match(/normaliseReason\(formData\.get\('reason'\)\)/g) ?? []).length,
    ).toBe(2);
    expect(loyalty).toMatch(/AdminAction\.LOYALTY_PROGRAMME_CHANGED/);
    expect(loyalty).toMatch(/AdminAction\.LOYALTY_TIER_CHANGED/);
    expect(loyalty).toMatch(/detail: \{ before, after: data \}/);
  });

  it('refuses a block that is not a whole number of pesos', () => {
    // Otherwise every redemption leaves a fraction of a centavo somewhere.
    expect(source('src/lib/actions/admin-actions.ts')).toMatch(
      /is not a whole number of pesos/,
    );
  });

  it('refuses a live programme that cannot earn or cannot pay', () => {
    expect(source('src/lib/actions/admin-actions.ts')).toMatch(
      /A live programme needs an earn rate, a redemption rate and a block/,
    );
  });

  it('refuses a tier with no explanation attached', () => {
    // "You are Suki" on its own tells a customer nothing.
    expect(source('src/lib/actions/admin-actions.ts')).toMatch(
      /on its own tells a customer nothing/,
    );
  });
});

describe('points earn where the money already goes', () => {
  it('earns inside the completion transaction, beside settlement and referrals', () => {
    const sweep = codeOnly('src/lib/orders/maintenance.ts');
    const completion = sweep.slice(sweep.indexOf('export async function completeOrder'));
    const accrual = completion.indexOf('accrueOrderSettlement');
    const points = completion.indexOf('earnPointsForOrder');
    expect(accrual).toBeGreaterThan(-1);
    expect(points).toBeGreaterThan(accrual);
    expect(sweep).toMatch(/await earnPointsForOrder\(order, tx\)/);
  });

  it('is not wired into placement, where nothing has been delivered', () => {
    expect(codeOnly('src/lib/orders/place-order.ts')).not.toMatch(
      /earnPointsForOrder/,
    );
  });
});
