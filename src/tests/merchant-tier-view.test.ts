import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TierBenefitType } from '@prisma/client';
import {
  MAX_TIER_PRIORITY_WEIGHT,
  type TierBenefitFacts,
} from '@/lib/loyalty/tier-benefits';
import { StoreRole } from '@prisma/client';
import { tabsFor } from '@/lib/merchant/roles';
import { splitOrderValue } from '@/lib/settlement/policy';
import {
  MERCHANT_RELEVANCE,
  MIN_ORDERS_FOR_A_SHARE,
  anyTierJumpsTheQueue,
  merchantTierViews,
  shareIsMeaningful,
  type TierLadderRow,
} from '@/lib/merchant/tier-view';

/**
 * What a loyalty tier looks like from behind the counter.
 *
 * The shop's two questions are "does this come out of my money" and "does it
 * change what happens in my kitchen", and the answers are no and — for exactly
 * one benefit — yes. These tests guard the second answer hardest, because it
 * is the one where a screen could quietly mislead a shop about a queue it
 * cannot see.
 */

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

const tier = (
  name: string,
  thresholdPoints: number,
  benefits: TierBenefitFacts[],
): TierLadderRow => ({ id: `tier_${name}`, name, thresholdPoints, benefits });

// --- Which of the shop's questions each benefit answers ---------------------

describe('every benefit type is classified for a shop', () => {
  it('covers the enum, so a seventh type forces the decision', () => {
    for (const type of ALL_TYPES) {
      expect(MERCHANT_RELEVANCE[type]).toBeDefined();
    }
    expect(Object.keys(MERCHANT_RELEVANCE).sort()).toEqual([...ALL_TYPES].sort());
  });

  it('classifies exactly one benefit as touching the kitchen', () => {
    // If a second one ever does, the paragraph explaining the rider queue is
    // no longer the whole story and this test is the reminder.
    const kitchen = ALL_TYPES.filter(
      (type) => MERCHANT_RELEVANCE[type] === 'AFFECTS_THE_KITCHEN',
    );
    expect(kitchen).toEqual([TierBenefitType.DISPATCH_PRIORITY]);
  });

  it('classifies all three bill benefits as the platform paying', () => {
    expect(MERCHANT_RELEVANCE[TierBenefitType.FREE_DELIVERY]).toBe('PLATFORM_PAYS');
    expect(MERCHANT_RELEVANCE[TierBenefitType.DISCOUNT_PERCENT]).toBe('PLATFORM_PAYS');
    expect(MERCHANT_RELEVANCE[TierBenefitType.CREDIT_BACK_PERCENT]).toBe(
      'PLATFORM_PAYS',
    );
  });
});

// --- The claim the screen exists to make, checked against the code ----------

describe('a tier discount really does not reduce the shop payout', () => {
  /**
   * The screen tells a shop, in bold, that a customer's status never makes its
   * payout smaller. This is where that claim is checked.
   *
   * The first version of this test read `accrual.ts` and asserted the source
   * contained `amountCentavos: split.storeCentavos`. It passed against a
   * mutant that wrote `split.storeCentavos - order.loyaltyDiscountCentavos` —
   * because that string still contains the one being matched. A regex over
   * source cannot express "and nothing else"; arithmetic can.
   */
  const order = {
    subtotalCentavos: 50_000,
    deliveryFeeCentavos: 5_000,
    serviceFeeCentavos: 1_000,
    smallOrderFeeCentavos: 0,
    surgeCentavos: 0,
    tipCentavos: 2_000,
    totalCentavos: 58_000,
  };
  const split = (discountedCentavos: number) =>
    splitOrderValue({
      order,
      riderCentavos: 6_000,
      commissionBasisPoints: 1_500,
      discountedCentavos,
    });

  it('pays the shop the same whether the customer had a status or not', () => {
    const noBenefit = split(0);
    const withTierDiscount = split(7_500);

    expect(withTierDiscount.storeCentavos).toBe(noBenefit.storeCentavos);
    // 15% of ₱500 is ₱75, so the shop is owed ₱425 either way.
    expect(noBenefit.storeCentavos).toBe(42_500);
    // The rider is untouched too — the fee nobody was charged is still theirs.
    expect(withTierDiscount.riderCentavos).toBe(noBenefit.riderCentavos);
  });

  it('takes the whole discount out of the platform’s net, and only there', () => {
    const noBenefit = split(0);
    const withTierDiscount = split(7_500);

    expect(noBenefit.platformNetCentavos - withTierDiscount.platformNetCentavos).toBe(
      7_500,
    );
    // The gross is what the order is worth to everybody, before TARA gives
    // any of it away, so a discount cannot move it.
    expect(withTierDiscount.grossCentavos).toBe(noBenefit.grossCentavos);
  });

  it('holds for a discount large enough to exceed the platform’s share', () => {
    // A generous tier can cost TARA more than it made on the order. The shop's
    // payout is still the shop's payout — the platform's NET goes negative,
    // which is the honest place for it to go.
    const generous = split(20_000);
    expect(generous.storeCentavos).toBe(42_500);
    expect(generous.platformNetCentavos).toBeLessThan(0);
  });

  it('feeds every discount, the loyalty one included, into that one input', () => {
    // The arithmetic above is only reached if `accrueOrderSettlement` actually
    // passes the platform's whole cost. That wiring has no return value to
    // assert on, so it is checked where it lives — but against the shared
    // function's NAME rather than a copy of its body, so extracting or
    // reordering the sum cannot break this test for nothing.
    const accrual = readFileSync(
      path.join(process.cwd(), 'src/lib/settlement/accrual.ts'),
      'utf8',
    );
    expect(accrual).toMatch(/discountedCentavos: platformAbsorbedCentavos\(order\)/);
  });
});

// --- Turning the ladder into what a shop sees -------------------------------

describe('the ladder, as a shop reads it', () => {
  it('splits a tier’s benefits into the two groups', () => {
    const views = merchantTierViews([
      tier('Tapat', 2_000, [
        benefit({ type: TierBenefitType.FREE_DELIVERY, monthlyUsageCap: 4 }),
        benefit({ type: TierBenefitType.DISPATCH_PRIORITY, priorityWeight: 10 }),
      ]),
    ]);

    expect(views).toHaveLength(1);
    expect(views[0]!.platformPays.map((row) => row.type)).toEqual([
      TierBenefitType.FREE_DELIVERY,
    ]);
    expect(views[0]!.affectsTheKitchen.map((row) => row.type)).toEqual([
      TierBenefitType.DISPATCH_PRIORITY,
    ]);
  });

  it('says nothing about the perks that are between TARA and the customer', () => {
    // A shop can do nothing with either, and two unusable lines on a screen
    // read between orders is how a screen stops being read at all.
    const views = merchantTierViews([
      tier('Suki', 500, [
        benefit({ type: TierBenefitType.DISCOUNT_PERCENT, percentBasisPoints: 500 }),
        benefit({ type: TierBenefitType.SUPPORT_PRIORITY, priorityWeight: 15 }),
        benefit({ type: TierBenefitType.POINTS_NEVER_EXPIRE }),
      ]),
    ]);
    const shown = [
      ...views[0]!.platformPays,
      ...views[0]!.affectsTheKitchen,
    ].map((row) => row.type);
    expect(shown).toEqual([TierBenefitType.DISCOUNT_PERCENT]);
  });

  it('drops a tier a shop is told nothing about', () => {
    // Not listed empty: a row saying a tier exists and does nothing visible
    // here is noise, and the numbers panel already covers "how many of my
    // orders come from regulars".
    const views = merchantTierViews([
      tier('Quiet', 100, [
        benefit({ type: TierBenefitType.POINTS_NEVER_EXPIRE }),
        benefit({ type: TierBenefitType.SUPPORT_PRIORITY, priorityWeight: 20 }),
      ]),
      tier('Loud', 900, [
        benefit({ type: TierBenefitType.DISCOUNT_PERCENT, percentBasisPoints: 500 }),
      ]),
    ]);
    expect(views.map((view) => view.name)).toEqual(['Loud']);
  });

  it('orders the ladder by threshold, whatever order it arrives in', () => {
    const views = merchantTierViews([
      tier('Tapat', 2_000, [benefit({ type: TierBenefitType.FREE_DELIVERY })]),
      tier('Suki', 500, [benefit({ type: TierBenefitType.DISCOUNT_PERCENT })]),
    ]);
    expect(views.map((view) => view.name)).toEqual(['Suki', 'Tapat']);
  });

  it('is empty for an empty ladder, rather than inventing a tier', () => {
    expect(merchantTierViews([])).toEqual([]);
  });
});

// --- The head start, which is the number that could mislead -----------------

describe('the head start the screen prints', () => {
  it('is read through the dispatcher’s own function, ceiling included', () => {
    /**
     * A shop told "up to 4000 minutes of head start" would reasonably conclude
     * a suki always goes first, which is not what the dispatcher does — it
     * clamps to MAX_TIER_PRIORITY_WEIGHT. Printing the raw column would make
     * the screen promise a different queue from the one that runs.
     */
    const views = merchantTierViews([
      tier('Tapat', 2_000, [
        benefit({ type: TierBenefitType.DISPATCH_PRIORITY, priorityWeight: 4_000 }),
      ]),
    ]);
    expect(views[0]!.dispatchHeadStartMinutes).toBe(MAX_TIER_PRIORITY_WEIGHT);
  });

  it('is zero when the tier confers no dispatch priority', () => {
    const views = merchantTierViews([
      tier('Suki', 500, [
        benefit({ type: TierBenefitType.DISCOUNT_PERCENT, percentBasisPoints: 500 }),
      ]),
    ]);
    expect(views[0]!.dispatchHeadStartMinutes).toBe(0);
  });

  it('treats a misconfigured priority row as no head start', () => {
    // priorityWeight is nullable, and a DISPATCH_PRIORITY row without one is
    // refused by the SQL guard — but a screen must not print "up to NaN".
    const views = merchantTierViews([
      tier('Odd', 700, [
        benefit({ type: TierBenefitType.DISPATCH_PRIORITY, priorityWeight: null }),
        benefit({ type: TierBenefitType.FREE_DELIVERY }),
      ]),
    ]);
    expect(views[0]!.dispatchHeadStartMinutes).toBe(0);
  });
});

describe('when the queue explanation is shown', () => {
  it('is shown only when some tier actually reorders the queue', () => {
    const withBoost = merchantTierViews([
      tier('Tapat', 2_000, [
        benefit({ type: TierBenefitType.DISPATCH_PRIORITY, priorityWeight: 10 }),
      ]),
    ]);
    const billOnly = merchantTierViews([
      tier('Suki', 500, [
        benefit({ type: TierBenefitType.DISCOUNT_PERCENT, percentBasisPoints: 500 }),
      ]),
    ]);

    expect(anyTierJumpsTheQueue(withBoost)).toBe(true);
    // On a ladder of bill benefits alone, that paragraph would be inventing a
    // worry about something that is not happening.
    expect(anyTierJumpsTheQueue(billOnly)).toBe(false);
    expect(anyTierJumpsTheQueue([])).toBe(false);
  });

  it('is not shown for a priority row the dispatcher would ignore', () => {
    const views = merchantTierViews([
      tier('Odd', 700, [
        benefit({ type: TierBenefitType.DISPATCH_PRIORITY, priorityWeight: 0 }),
        benefit({ type: TierBenefitType.FREE_DELIVERY }),
      ]),
    ]);
    expect(anyTierJumpsTheQueue(views)).toBe(false);
  });
});

// --- What crosses the boundary to a shop -----------------------------------

describe('what a shop is told about a customer', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src/lib/merchant/tier-customers.ts'),
    'utf8',
  );

  it('sends the tier NAME and nothing else per customer', () => {
    /**
     * A shop seeing a regular's status is the point — recognising a suki is
     * what a carinderia has always done. A shop seeing their points balance,
     * their benefits, or how close they are to the next tier is a different
     * thing entirely, and none of it is the shop's business.
     */
    const returnsNames = /Promise<Map<string, string>>/;
    expect(source).toMatch(returnsNames);
    expect(source).toMatch(/names\.set\(account\.userId, current\.name\)/);
    // No balance, no benefit rows, no distance-to-next crossing the boundary.
    expect(source).not.toMatch(/pointsToNext/);
    expect(source).not.toMatch(/getPointsBalance/);
    expect(source).not.toMatch(/benefits:/);
  });

  it('short-circuits before querying when no programme is running', () => {
    // Every deployment until somebody creates one, and this runs on the
    // busiest screen in the app.
    expect(source).toMatch(/if \(!programme\.isActive\) return names;/);
    expect(source).toMatch(/if \(ladder\.length === 0\) return names;/);
  });

  it('reports the discount already absorbed even with the programme off', () => {
    // Zeroing it would make the screen lie about money that really did come
    // off customers' bills on this shop's orders.
    expect(source).toMatch(/programmeIsOn: false/);
    expect(source).toMatch(/would make the screen lie about the past/);
  });
});

// --- The share, which the browser showed as over-precise ------------------

describe('when a share is worth stating as a percentage', () => {
  it('withholds a percentage until there are enough orders for one', () => {
    /**
     * The browser rendered "67%" against three orders. Arithmetically right,
     * and it reads as a finding about the business — while one more order in
     * either direction moves it by more than thirty points.
     */
    expect(shareIsMeaningful(3)).toBe(false);
    expect(shareIsMeaningful(MIN_ORDERS_FOR_A_SHARE - 1)).toBe(false);
    expect(shareIsMeaningful(MIN_ORDERS_FOR_A_SHARE)).toBe(true);
    expect(shareIsMeaningful(0)).toBe(false);
  });

  it('sets the floor high enough that one order cannot swing it far', () => {
    // One order in twenty is five points. One in three is thirty-three.
    expect(100 / MIN_ORDERS_FOR_A_SHARE).toBeLessThanOrEqual(5);
  });
});

// --- Who can open what, which the browser answered wrongly ----------------

describe('the back-office tabs and the role each screen needs', () => {
  const tabs = readFileSync(
    path.join(process.cwd(), 'src/components/merchant/MerchantTabs.tsx'),
    'utf8',
  );
  const payouts = readFileSync(
    path.join(process.cwd(), 'src/app/merchant/[storeId]/payouts/page.tsx'),
    'utf8',
  );

  it('hides only the tab a STAFF member genuinely cannot open', () => {
    /**
     * Measured in a browser: with a STAFF session, Payouts answered **500** —
     * `requireStoreAccess(…, MANAGER)` threw and nothing caught it, so
     * somebody working the counter tapped a visible tab and got "Something on
     * our side broke". `InsufficientStoreRoleError` is a deliberate expected
     * refusal, so the error page recorded nothing either.
     *
     * The first fix marked Staff and Settings MANAGER too, which was wrong:
     * both admit a STAFF member and degrade to read-only via `canRevoke` and
     * `canEdit`. Hiding them would have removed screens that work.
     */
    // Asked of the map rather than of the component's source: the list moved
    // to `merchant/roles.ts` so the staff screen could explain what a role
    // grants without a second copy of the answer. `tabsFor` is the same
    // function the tab bar calls.
    const staffTabs = tabsFor(StoreRole.STAFF).map((tab) => tab.key);
    const managerTabs = tabsFor(StoreRole.MANAGER).map((tab) => tab.key);
    expect(staffTabs).not.toContain('payouts');
    expect(managerTabs).toContain('payouts');
    expect(staffTabs).toContain('staff');
    expect(staffTabs).toContain('settings');
    expect(staffTabs).toContain('regulars');
  });

  it('reads the ladder from the module that has no database in it', () => {
    // `merchant/access.ts` reaches Prisma and the session. Importing it from a
    // client component is a 500 on render — the trap the purity test guards.
    expect(tabs).toMatch(/from '@\/lib\/merchant\/roles'/);
    expect(tabs).not.toMatch(/from '@\/lib\/merchant\/access'/);
  });

  it('makes the payouts screen refuse rather than throw', () => {
    // Hidden tab or not, the URL can be typed, or bookmarked from when the
    // person was a manager. `notFound()` is what the layout one level up
    // already does for the same reason.
    expect(payouts).toMatch(/try \{[\s\S]{0,200}requireStoreAccess\(storeId, StoreRole\.MANAGER\)/);
    expect(payouts).toMatch(/\} catch \{[\s\S]{0,40}notFound\(\);/);
  });
});
