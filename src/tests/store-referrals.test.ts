import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NotificationKind,
  SettlementEntryType,
  SettlementParty,
} from '@prisma/client';
import {
  MAX_STORE_REWARD_CENTAVOS,
  STORE_PROGRAMME_OFF,
  STORE_REFUSAL_TEXT,
  STORE_REWARD_REFUSAL_TEXT,
  earningsRemaining,
  hasStoreQualified,
  refusalForStoreAttribution,
  rewardForStoreReferral,
  storeAcquisitionCost,
  storePaysNothing,
  storeProgrammeIsLive,
  type StoreAttributionRefusal,
  type StoreProgrammeFacts,
  type StoreRewardRefusal,
} from '@/lib/referrals/store-policy';
import {
  ENTRY_DIRECTION,
  ENTRY_LABEL,
  bonusTotalLabel,
  entryLabel,
} from '@/lib/settlement/policy';
import { renderNotification } from '@/lib/notifications/templates';

/**
 * Shop referrals.
 *
 * The third programme, and the one with no code. A customer follows a link; a
 * rider types six characters into an application; a shop is created in the
 * console by one of us, so the introduction is **a person's claim** — which
 * moves where the risk lives. The rider tests are about paying the right
 * person once. These are about that too, and additionally about the two things
 * a claim can be wrong in: attributing a shop that was already trading, and
 * attributing it to a shop that has left.
 *
 * The other thing under test here is arithmetic nobody else does: the bonus in
 * BASIS POINTS of the earnings threshold, which is the unit commission is in,
 * so an operator can subtract one from the other.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

/** The file with its comments blanked, same helper as `partner-referrals`. */
function codeOnly(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const LIVE: StoreProgrammeFacts = {
  isActive: true,
  referrerCentavos: 75_000,
  refereeCentavos: 25_000,
  qualifyingEarningsCentavos: 2_000_000,
  monthlyRewardCap: 2,
  lifetimeRewardCap: 8,
};

const programme = (over: Partial<StoreProgrammeFacts> = {}): StoreProgrammeFacts => ({
  ...LIVE,
  ...over,
});

describe('when the shop programme is live', () => {
  it('is off until somebody turns it on', () => {
    expect(storeProgrammeIsLive(STORE_PROGRAMME_OFF)).toBe(false);
    expect(storeProgrammeIsLive(LIVE)).toBe(true);
  });

  it('refuses to be live with no earnings threshold', () => {
    // A zero threshold would pay for a shop being ADDED to the console, which
    // is something we do by hand for a shop that may never sell anything.
    expect(
      storeProgrammeIsLive(programme({ qualifyingEarningsCentavos: 0 })),
    ).toBe(false);
    expect(
      storeProgrammeIsLive(programme({ qualifyingEarningsCentavos: 1 })),
    ).toBe(true);
  });

  it('refuses to be live paying nobody anything', () => {
    expect(
      storeProgrammeIsLive(
        programme({ referrerCentavos: 0, refereeCentavos: 0 }),
      ),
    ).toBe(false);
    expect(
      storeProgrammeIsLive(programme({ referrerCentavos: 0 })),
    ).toBe(true);
  });
});

// --- The claim ---------------------------------------------------------------

describe('which shop may be recorded as having introduced which', () => {
  const facts = (over: {
    programme?: StoreProgrammeFacts;
    referrerVisible?: boolean;
    referrerMissing?: boolean;
    alreadyAttributed?: boolean;
    earnedCentavos?: number;
    sameStore?: boolean;
  } = {}) => ({
    programme: over.programme ?? LIVE,
    referrer: over.referrerMissing
      ? null
      : {
          storeId: over.sameStore ? 'shop-new' : 'shop-old',
          isVisible: over.referrerVisible ?? true,
        },
    referee: {
      storeId: 'shop-new',
      alreadyAttributed: over.alreadyAttributed ?? false,
      earnedCentavos: over.earnedCentavos ?? 0,
    },
  });

  it('accepts a brand new shop introduced by a trading one', () => {
    expect(refusalForStoreAttribution(facts())).toBeNull();
  });

  it('refuses a shop that has already earned anything through TARA', () => {
    // The refusal that matters most, because it is the one an administrator
    // can get wrong in good faith: a shop that has been on the platform a
    // year still looks like a shop somebody could have introduced.
    expect(refusalForStoreAttribution(facts({ earnedCentavos: 1 }))).toBe(
      'ALREADY_TRADING',
    );
    expect(refusalForStoreAttribution(facts({ earnedCentavos: 0 }))).toBeNull();
  });

  it('refuses a shop introducing itself, and a shop that does not exist', () => {
    expect(refusalForStoreAttribution(facts({ sameStore: true }))).toBe(
      'SAME_STORE',
    );
    expect(refusalForStoreAttribution(facts({ referrerMissing: true }))).toBe(
      'SAME_STORE',
    );
  });

  it('refuses an introducer that is not visible on TARA', () => {
    expect(refusalForStoreAttribution(facts({ referrerVisible: false }))).toBe(
      'REFERRER_WITHDRAWN',
    );
  });

  it('refuses a second introduction for the same shop', () => {
    expect(
      refusalForStoreAttribution(facts({ alreadyAttributed: true })),
    ).toBe('ALREADY_ATTRIBUTED');
  });

  it('refuses everybody when the programme is off', () => {
    expect(
      refusalForStoreAttribution(facts({ programme: STORE_PROGRAMME_OFF })),
    ).toBe('PROGRAMME_OFF');
  });

  it('checks the introducer before the introduced shop’s own history', () => {
    // Both are wrong here. The operator picked a withdrawn shop AND this one
    // is already trading; the message names what they can act on first.
    expect(
      refusalForStoreAttribution(
        facts({ referrerVisible: false, earnedCentavos: 500_000 }),
      ),
    ).toBe('REFERRER_WITHDRAWN');
  });

  it('has a sentence for every refusal, and none of them blames the shop', () => {
    const all: StoreAttributionRefusal[] = [
      'PROGRAMME_OFF',
      'SAME_STORE',
      'ALREADY_ATTRIBUTED',
      'ALREADY_TRADING',
      'REFERRER_WITHDRAWN',
    ];
    for (const refusal of all) {
      const text = STORE_REFUSAL_TEXT[refusal];
      expect(text.length).toBeGreaterThan(20);
      expect(text.endsWith('.')).toBe(true);
    }
    expect(Object.keys(STORE_REFUSAL_TEXT).sort()).toEqual([...all].sort());
  });
});

// --- Qualifying by trading ---------------------------------------------------

describe('qualifying by earning', () => {
  it('qualifies at the threshold and not one centavo before it', () => {
    expect(hasStoreQualified(1_999_999, LIVE)).toBe(false);
    expect(hasStoreQualified(2_000_000, LIVE)).toBe(true);
    expect(hasStoreQualified(9_000_000, LIVE)).toBe(true);
  });

  it('never qualifies against a dead programme', () => {
    expect(hasStoreQualified(9_000_000, STORE_PROGRAMME_OFF)).toBe(false);
    expect(
      hasStoreQualified(9_000_000, programme({ isActive: false })),
    ).toBe(false);
  });

  it('counts down for the shop’s own screen, and stops at zero', () => {
    expect(earningsRemaining(0, LIVE)).toBe(2_000_000);
    expect(earningsRemaining(1_360_000, LIVE)).toBe(640_000);
    expect(earningsRemaining(2_000_000, LIVE)).toBe(0);
    expect(earningsRemaining(5_000_000, LIVE)).toBe(0);
  });
});

// --- Paying ------------------------------------------------------------------

describe('what a qualified introduction pays', () => {
  const decide = (over: {
    programme?: StoreProgrammeFacts;
    earnedCentavos?: number;
    rewardedThisMonth?: number;
    rewardedEver?: number;
    referrerIsVisible?: boolean;
  } = {}) =>
    rewardForStoreReferral({
      programme: over.programme ?? LIVE,
      earnedCentavos: over.earnedCentavos ?? 2_000_000,
      rewardedThisMonth: over.rewardedThisMonth ?? 0,
      rewardedEver: over.rewardedEver ?? 0,
      referrerIsVisible: over.referrerIsVisible ?? true,
    });

  it('pays both sides once the shop has traded past the threshold', () => {
    const decision = decide();
    expect(decision.referrerCentavos).toBe(75_000);
    expect(decision.refereeCentavos).toBe(25_000);
    expect(decision.referrerRefusal).toBeNull();
    expect(decision.refereeRefusal).toBeNull();
    expect(storePaysNothing(decision)).toBe(false);
  });

  it('pays nobody before the threshold, and names why', () => {
    const decision = decide({ earnedCentavos: 1_999_999 });
    expect(storePaysNothing(decision)).toBe(true);
    expect(decision.referrerRefusal).toBe('NOT_ENOUGH_EARNINGS');
    expect(decision.refereeRefusal).toBe('NOT_ENOUGH_EARNINGS');
  });

  it('lets a cap refuse the INTRODUCER and still pays the new shop', () => {
    // The new shop sold the food. Refusing it a bonus because of a cap
    // belonging to a business it has never met would be a promise broken by
    // somebody else.
    const monthly = decide({ rewardedThisMonth: 2 });
    expect(monthly.referrerCentavos).toBe(0);
    expect(monthly.referrerRefusal).toBe('MONTHLY_CAP_REACHED');
    expect(monthly.refereeCentavos).toBe(25_000);
    expect(monthly.refereeRefusal).toBeNull();

    const lifetime = decide({ rewardedEver: 8 });
    expect(lifetime.referrerCentavos).toBe(0);
    expect(lifetime.referrerRefusal).toBe('LIFETIME_CAP_REACHED');
    expect(lifetime.refereeCentavos).toBe(25_000);
  });

  it('and the same when the introducer has left the platform', () => {
    const decision = decide({ referrerIsVisible: false });
    expect(decision.referrerCentavos).toBe(0);
    expect(decision.referrerRefusal).toBe('REFERRER_WITHDRAWN');
    expect(decision.refereeCentavos).toBe(25_000);
    expect(decision.refereeRefusal).toBeNull();
    expect(storePaysNothing(decision)).toBe(false);
  });

  it('refuses both when the programme is off, because then there was no promise', () => {
    const decision = decide({ programme: STORE_PROGRAMME_OFF });
    expect(storePaysNothing(decision)).toBe(true);
    expect(decision.referrerRefusal).toBe('PROGRAMME_OFF');
    expect(decision.refereeRefusal).toBe('PROGRAMME_OFF');
  });

  it('names NOTHING_TO_PAY per side rather than pretending to pay zero', () => {
    const noReferee = decide({ programme: programme({ refereeCentavos: 0 }) });
    expect(noReferee.refereeCentavos).toBe(0);
    expect(noReferee.refereeRefusal).toBe('NOTHING_TO_PAY');
    expect(noReferee.referrerCentavos).toBe(75_000);

    const noReferrer = decide({ programme: programme({ referrerCentavos: 0 }) });
    expect(noReferrer.referrerCentavos).toBe(0);
    expect(noReferrer.referrerRefusal).toBe('NOTHING_TO_PAY');
    expect(noReferrer.refereeCentavos).toBe(25_000);
  });

  it('caps each side at the typo ceiling', () => {
    const decision = decide({
      programme: programme({
        referrerCentavos: 5_000_000,
        refereeCentavos: 900_000,
      }),
    });
    expect(decision.referrerCentavos).toBe(MAX_STORE_REWARD_CENTAVOS);
    expect(decision.refereeCentavos).toBe(MAX_STORE_REWARD_CENTAVOS);
  });

  it('has a sentence for every reward refusal', () => {
    const all: StoreRewardRefusal[] = [
      'PROGRAMME_OFF',
      'NOT_ENOUGH_EARNINGS',
      'MONTHLY_CAP_REACHED',
      'LIFETIME_CAP_REACHED',
      'REFERRER_WITHDRAWN',
      'NOTHING_TO_PAY',
    ];
    for (const refusal of all) {
      expect(STORE_REWARD_REFUSAL_TEXT[refusal].length).toBeGreaterThan(20);
    }
    expect(Object.keys(STORE_REWARD_REFUSAL_TEXT).sort()).toEqual(
      [...all].sort(),
    );
  });
});

// --- The arithmetic an operator needs ---------------------------------------

describe('what a shop costs to acquire, in commission’s own units', () => {
  it('expresses the bonus as basis points of the earnings threshold', () => {
    // ₱1,000 of bonus against a ₱20,000 threshold is 5%. If commission is
    // 15%, the trading that qualifies the referral has already paid for it.
    const cost = storeAcquisitionCost(LIVE);
    expect(cost.bothSidesCentavos).toBe(100_000);
    expect(cost.qualifyingEarningsCentavos).toBe(2_000_000);
    expect(cost.costBasisPointsOfEarnings).toBe(500);
  });

  it('rounds the basis points UP, so it never understates the spend', () => {
    const cost = storeAcquisitionCost(
      programme({
        referrerCentavos: 1,
        refereeCentavos: 0,
        qualifyingEarningsCentavos: 3,
      }),
    );
    // 1 / 3 = 3333.33 basis points.
    expect(cost.costBasisPointsOfEarnings).toBe(3334);
  });

  it('does not divide by zero on a programme with no threshold', () => {
    const cost = storeAcquisitionCost(
      programme({ qualifyingEarningsCentavos: 0 }),
    );
    expect(cost.costBasisPointsOfEarnings).toBe(0);
    expect(Number.isFinite(cost.costBasisPointsOfEarnings)).toBe(true);
  });

  it('bounds the introducer side only, and says so by excluding the other', () => {
    const cost = storeAcquisitionCost(LIVE);
    expect(cost.lifetimeLiabilityPerReferrerCentavos).toBe(75_000 * 8);
    // Deliberately NOT both sides: the referee side is bounded by how many new
    // shops exist, not by any cap.
    expect(cost.lifetimeLiabilityPerReferrerCentavos).not.toBe(
      cost.bothSidesCentavos * 8,
    );
  });

  it('agrees with the database ceiling', () => {
    const sql = source('prisma/sql/store_referrals.sql');
    expect(sql).toContain(String(MAX_STORE_REWARD_CENTAVOS));
  });
});

// --- Money, said out loud ----------------------------------------------------

describe('a shop bonus is money, and every sentence says so', () => {
  const CUSTOMER_FACING = [
    'src/components/settlement/StoreReferralPanel.tsx',
    'src/lib/referrals/store-policy.ts',
  ];

  it('never offers a shop credits', () => {
    for (const file of CUSTOMER_FACING) {
      const code = codeOnly(file);
      expect(code).not.toMatch(/credits/i);
      expect(code).not.toMatch(/rewards balance/i);
    }
  });

  it('tells the shop the money is owed rather than already paid', () => {
    const rendered = renderNotification(
      NotificationKind.STORE_REFERRAL_SETTLED,
      { amountCentavos: 75_000, inviteRole: 'REFERRER' },
    );
    expect(rendered.body).toMatch(/owes you/i);
    expect(rendered.body).toMatch(/next payout/i);
    expect(rendered.body).not.toMatch(/credits/i);
  });

  it('says something different to the shop that was introduced', () => {
    const referee = renderNotification(
      NotificationKind.STORE_REFERRAL_SETTLED,
      { amountCentavos: 25_000, inviteRole: 'REFEREE' },
    );
    expect(referee.body).toMatch(/your shop has sold enough/i);
    expect(referee.body).not.toMatch(/a shop you introduced/i);
  });

  it('explains a refusal instead of going quiet', () => {
    const rendered = renderNotification(
      NotificationKind.STORE_REFERRAL_SETTLED,
      {
        amountCentavos: 0,
        inviteRole: 'REFERRER',
        reason: STORE_REWARD_REFUSAL_TEXT.MONTHLY_CAP_REACHED,
      },
    );
    expect(rendered.body).toContain(
      STORE_REWARD_REFUSAL_TEXT.MONTHLY_CAP_REACHED,
    );
    expect(rendered.body).toMatch(/nothing was taken from you/i);
  });

  it('does not promise a code that does not exist', () => {
    const panel = source('src/components/settlement/StoreReferralPanel.tsx');
    expect(panel).toMatch(/no code to share/i);
    expect(codeOnly('src/components/settlement/StoreReferralPanel.tsx')).not.toMatch(
      /share your code|your referral code/i,
    );
  });
});

// --- The ledger --------------------------------------------------------------

describe('the bonus on the settlement ledger', () => {
  it('increases what TARA owes, and is labelled as recruitment', () => {
    // +1: a bonus INCREASES what TARA owes the shop, like the food it sells.
    expect(ENTRY_DIRECTION[SettlementEntryType.REFERRAL_BONUS]).toBe(1);
    expect(ENTRY_LABEL[SettlementEntryType.REFERRAL_BONUS].length).toBeGreaterThan(3);
  });

  it('does not call it an invite on a shop’s statement, because there is no code', () => {
    // The shop's own panel says "There is no code to share" in as many words.
    // A line reading "Invite bonus" above it would name a thing the same
    // screen has just denied exists.
    const forStore = entryLabel(
      SettlementEntryType.REFERRAL_BONUS,
      SettlementParty.STORE,
    );
    expect(forStore).toBe('Referral bonus');
    expect(forStore).not.toMatch(/invite/i);

    // The rider keeps the word, because a rider WAS invited by a code.
    expect(
      entryLabel(
        SettlementEntryType.REFERRAL_BONUS,
        SettlementParty.FLEET_PARTNER,
      ),
    ).toBe('Invite bonus');

    // And every other pair falls through to the general label, so a new entry
    // type needs no override and a new party inherits the wording.
    for (const type of Object.values(SettlementEntryType)) {
      for (const party of Object.values(SettlementParty)) {
        const label = entryLabel(type, party);
        expect(label.length).toBeGreaterThan(3);
        if (type !== SettlementEntryType.REFERRAL_BONUS) {
          expect(label).toBe(ENTRY_LABEL[type]);
        }
      }
      expect(entryLabel(type)).toBe(ENTRY_LABEL[type]);
    }
  });

  it('nor on the tile totalling them, which had the same word', () => {
    // The line label and the tile above it were two separate strings. Fixing
    // one and not the other left a shop's screen saying "Invite bonuses
    // ₱100.00" over a list of lines that said "Referral bonus".
    expect(bonusTotalLabel(SettlementParty.STORE)).toBe('Referral bonuses');
    expect(bonusTotalLabel(SettlementParty.STORE)).not.toMatch(/invite/i);
    expect(bonusTotalLabel(SettlementParty.FLEET_PARTNER)).toBe('Invite bonuses');

    // Every party has one, and it is the plural of that party's line label.
    for (const party of Object.values(SettlementParty)) {
      expect(bonusTotalLabel(party)).toContain(
        entryLabel(SettlementEntryType.REFERRAL_BONUS, party),
      );
    }
  });

  it('is keyed per referral AND per side, so neither side is paid twice', () => {
    const code = codeOnly('src/lib/referrals/store-rewards.ts');
    expect(code).toMatch(/store-referral-\$\{input\.side\}:\$\{input\.referralId\}/);
  });

  it('reads the threshold from the ledger, not from an order count', () => {
    const code = codeOnly('src/lib/referrals/store-rewards.ts');
    expect(code).toMatch(/positionOf\(/);
    expect(code).toMatch(/position\.earnedCentavos/);
    // An order count would be the farmable measure this programme rejects.
    expect(code).not.toMatch(/completedOrderCount|orders\.count/);
  });

  it('claims the row with a compare-and-set, so a race cannot fail an order', () => {
    const code = codeOnly('src/lib/referrals/store-rewards.ts');
    expect(code).toMatch(/updateMany\(/);
    expect(code).toMatch(/status: ReferralStatus\.ATTRIBUTED/);
    expect(code).toMatch(/claimed\.count !== 1/);
  });

  it('carries no orderId, because the order belongs to the other shop', () => {
    const code = codeOnly('src/lib/referrals/store-rewards.ts');
    expect(code).not.toMatch(/orderId/);
  });

  it('pays after the accrual it qualifies on, never before', () => {
    // Anchored on the CALL SITES, not the identifiers: the first version of
    // this test found `accrueOrderSettlement` in the import line at the top of
    // the file, so it stayed green when the call was deleted outright.
    const code = codeOnly('src/lib/orders/maintenance.ts');
    const accrual = code.indexOf('await accrueOrderSettlement(order, tx)');
    const payout = code.indexOf('await payStoreReferralForOrder(');
    expect(accrual).toBeGreaterThan(-1);
    expect(payout).toBeGreaterThan(accrual);
    // And both inside the same transaction: a bonus written outside it would
    // survive a completion that rolled back.
    expect(code).toMatch(
      /payStoreReferralForOrder\(\s*\{ storeId: accrual\.storeId \},\s*tx,?\s*\)/,
    );
  });
});

// --- A person's claim, and the audit that makes it one ----------------------

describe('the attribution is a claim, so it is recorded like one', () => {
  it('demands an actor and a note, in the schema rather than the form', () => {
    const schema = source('prisma/schema.prisma');
    const model = schema.slice(
      schema.indexOf('model StoreReferral {'),
      schema.indexOf('model StoreReferral {') + 2_000,
    );
    expect(model).toMatch(/attributedById\s+String/);
    expect(model).toMatch(/attributionNote\s+String/);
    // Neither is optional: a claim with nobody's name on it is not one.
    expect(model).not.toMatch(/attributedById\s+String\?/);
    expect(model).not.toMatch(/attributionNote\s+String\?/);
  });

  it('shows the refusal to the person who made the claim', () => {
    // The rider version deliberately swallows a bad code so an application is
    // never lost. Here the refusal is the whole point.
    const code = codeOnly('src/lib/referrals/store-attribution.ts');
    expect(code).toMatch(/ok: false/);
    expect(code).toMatch(/message: STORE_REFUSAL_TEXT\[named\]/);

    const action = codeOnly('src/lib/actions/admin-actions.ts');
    expect(action).toMatch(/outcome\.ok[\s\S]{0,120}message: outcome\.message/);
  });

  it('writes an audit row naming the shop, not the programme', () => {
    const action = codeOnly('src/lib/actions/admin-actions.ts');
    const at = action.indexOf('STORE_REFERRAL_ATTRIBUTED');
    expect(at).toBeGreaterThan(-1);
    const window = action.slice(at - 300, at + 400);
    expect(window).toMatch(/subjectType: 'Store'/);
    expect(window).toMatch(/reason/);
  });

  it('tells the operator nothing is owed yet', () => {
    const action = source('src/lib/actions/admin-actions.ts');
    expect(action).toMatch(/Nothing is owed yet/);
  });
});
