import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotificationKind, SettlementEntryType } from '@prisma/client';
import {
  MAX_PARTNER_REWARD_CENTAVOS,
  PARTNER_PROGRAMME_OFF,
  PARTNER_REFUSAL_TEXT,
  PARTNER_REWARD_REFUSAL_TEXT,
  acquisitionCost,
  deliveriesRemaining,
  hasQualified,
  partnerProgrammeIsLive,
  paysNothing,
  refusalForPartnerAttribution,
  rewardForPartnerReferral,
  type PartnerAttributionRefusal,
  type PartnerProgrammeFacts,
  type PartnerRewardRefusal,
} from '@/lib/referrals/partner-policy';
import { ENTRY_DIRECTION, ENTRY_LABEL } from '@/lib/settlement/policy';
import { renderNotification } from '@/lib/notifications/templates';

/**
 * Rider invites.
 *
 * The customer programme pays credits, which can only ever reduce a future
 * bill. This one pays MONEY, into what TARA owes a rider, and that changes
 * what the tests have to be about: not "can somebody farm this" — collecting
 * requires passing verification and completing real deliveries — but "does it
 * pay the right person the right amount, once, and does every screen tell them
 * the truth about which currency it is."
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

/**
 * The file with its comments blanked out, same helper as `settlement.test.ts`.
 *
 * The first version of the "never says credits" test below matched string
 * literals in the raw source, and every apostrophe in the prose — "the
 * customer programme's" — opened a literal that swallowed the next paragraph.
 * The comments here discuss credits deliberately and at length; the ban is on
 * what reaches a rider's screen.
 */
function codeOnly(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const LIVE: PartnerProgrammeFacts = {
  isActive: true,
  referrerCentavos: 50_000,
  refereeCentavos: 25_000,
  qualifyingDeliveries: 20,
  monthlyRewardCap: 3,
  lifetimeRewardCap: 10,
};

describe('when the rider programme is live', () => {
  it('is off until somebody turns it on', () => {
    expect(partnerProgrammeIsLive(PARTNER_PROGRAMME_OFF)).toBe(false);
    expect(partnerProgrammeIsLive(LIVE)).toBe(true);
  });

  it('refuses to be live with no delivery threshold', () => {
    // Zero deliveries would pay for registering an account, which is paying
    // for owning a SIM card — exactly what the customer programme refuses by
    // never paying the referrer at signup.
    expect(partnerProgrammeIsLive({ ...LIVE, qualifyingDeliveries: 0 })).toBe(false);
  });

  it('refuses to be live paying nobody anything', () => {
    expect(
      partnerProgrammeIsLive({ ...LIVE, referrerCentavos: 0, refereeCentavos: 0 }),
    ).toBe(false);
    // One side is enough.
    expect(partnerProgrammeIsLive({ ...LIVE, refereeCentavos: 0 })).toBe(true);
  });
});

describe('who may be attributed to a rider code', () => {
  const referrer = {
    fleetPartnerId: 'partner-ana',
    userId: 'user-ana',
    isBlocked: false,
    isSuspended: false,
  };
  const referee = {
    userId: 'user-ben',
    alreadyReferred: false,
    completedDeliveryCount: 0,
  };
  const facts = (over: Record<string, unknown> = {}) => ({
    programme: LIVE,
    referrer,
    codeOwnerExists: true,
    referee,
    ...over,
  });

  it('accepts a new rider with somebody else’s code', () => {
    expect(refusalForPartnerAttribution(facts())).toBeNull();
  });

  it('distinguishes a code nobody owns from a customer’s code', () => {
    // Both resolve to "no referring rider", and the difference is the only
    // thing that tells the applicant whether to check their typing or to stop
    // expecting a bonus.
    expect(
      refusalForPartnerAttribution(facts({ referrer: null, codeOwnerExists: false })),
    ).toBe('UNKNOWN_CODE');
    expect(
      refusalForPartnerAttribution(facts({ referrer: null, codeOwnerExists: true })),
    ).toBe('NOT_A_RIDER_CODE');
  });

  it('refuses their own code', () => {
    expect(
      refusalForPartnerAttribution(
        facts({ referee: { ...referee, userId: referrer.userId } }),
      ),
    ).toBe('OWN_CODE');
  });

  it('refuses a blocked or suspended referrer, separately', () => {
    expect(
      refusalForPartnerAttribution(
        facts({ referrer: { ...referrer, isBlocked: true } }),
      ),
    ).toBe('REFERRER_BLOCKED');
    expect(
      refusalForPartnerAttribution(
        facts({ referrer: { ...referrer, isSuspended: true } }),
      ),
    ).toBe('REFERRER_SUSPENDED');
  });

  it('refuses a second code, and a rider who has already delivered', () => {
    expect(
      refusalForPartnerAttribution(
        facts({ referee: { ...referee, alreadyReferred: true } }),
      ),
    ).toBe('ALREADY_REFERRED');
    // A referral pays for bringing somebody who was not here. An existing
    // rider cannot be introduced by anybody.
    expect(
      refusalForPartnerAttribution(
        facts({ referee: { ...referee, completedDeliveryCount: 1 } }),
      ),
    ).toBe('NOT_A_NEW_RIDER');
  });

  it('refuses everybody when the programme is off', () => {
    expect(
      refusalForPartnerAttribution(facts({ programme: PARTNER_PROGRAMME_OFF })),
    ).toBe('PROGRAMME_OFF');
  });

  it('does not leak the referrer’s account state to the applicant', () => {
    // Blocked and suspended are separate branches so an operator can count
    // them, and read almost identically so a stranger typing a code cannot
    // learn which one it is.
    expect(PARTNER_REFUSAL_TEXT.REFERRER_BLOCKED).not.toMatch(/block|suspend/i);
    expect(PARTNER_REFUSAL_TEXT.REFERRER_SUSPENDED).not.toMatch(/block|suspend/i);
  });

  it('has a sentence for every refusal', () => {
    const branches: PartnerAttributionRefusal[] = [
      'PROGRAMME_OFF',
      'UNKNOWN_CODE',
      'OWN_CODE',
      'NOT_A_RIDER_CODE',
      'ALREADY_REFERRED',
      'NOT_A_NEW_RIDER',
      'REFERRER_BLOCKED',
      'REFERRER_SUSPENDED',
    ];
    for (const branch of branches) {
      expect(PARTNER_REFUSAL_TEXT[branch].length, branch).toBeGreaterThan(10);
    }
  });
});

describe('qualifying by delivering', () => {
  it('qualifies at the threshold and not one before it', () => {
    expect(hasQualified(19, LIVE)).toBe(false);
    expect(hasQualified(20, LIVE)).toBe(true);
    expect(hasQualified(21, LIVE)).toBe(true);
  });

  it('never qualifies against a dead programme', () => {
    expect(hasQualified(500, PARTNER_PROGRAMME_OFF)).toBe(false);
  });

  it('counts down for the rider’s own screen, and stops at zero', () => {
    expect(deliveriesRemaining(0, LIVE)).toBe(20);
    expect(deliveriesRemaining(19, LIVE)).toBe(1);
    expect(deliveriesRemaining(20, LIVE)).toBe(0);
    expect(deliveriesRemaining(40, LIVE)).toBe(0);
  });
});

describe('what a qualified invite pays', () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    programme: LIVE,
    completedDeliveries: 20,
    rewardedThisMonth: 0,
    rewardedEver: 0,
    referrerIsBlocked: false,
    referrerIsSuspended: false,
    ...over,
  });

  it('pays both sides once the deliveries are done', () => {
    const decision = rewardForPartnerReferral(facts());
    expect(decision.referrerCentavos).toBe(50_000);
    expect(decision.refereeCentavos).toBe(25_000);
    expect(decision.referrerRefusal).toBeNull();
    expect(decision.refereeRefusal).toBeNull();
    expect(paysNothing(decision)).toBe(false);
  });

  it('pays nobody before the threshold', () => {
    const decision = rewardForPartnerReferral(facts({ completedDeliveries: 19 }));
    expect(paysNothing(decision)).toBe(true);
    expect(decision.referrerRefusal).toBe('NOT_ENOUGH_DELIVERIES');
    expect(decision.refereeRefusal).toBe('NOT_ENOUGH_DELIVERIES');
  });

  /**
   * The design decision this whole module turns on.
   *
   * A cap belongs to the inviter. If hitting it refused the whole referral, a
   * new rider who was told "₱250 after twenty deliveries", and who then
   * delivered twenty times, would get nothing because of something a different
   * person did — invisible to them and not their fault.
   */
  it('lets a cap refuse the INVITER and still pays the new rider', () => {
    const monthly = rewardForPartnerReferral(facts({ rewardedThisMonth: 3 }));
    expect(monthly.referrerCentavos).toBe(0);
    expect(monthly.referrerRefusal).toBe('MONTHLY_CAP_REACHED');
    expect(monthly.refereeCentavos).toBe(25_000);
    expect(monthly.refereeRefusal).toBeNull();
    expect(paysNothing(monthly)).toBe(false);

    const lifetime = rewardForPartnerReferral(facts({ rewardedEver: 10 }));
    expect(lifetime.referrerCentavos).toBe(0);
    expect(lifetime.referrerRefusal).toBe('LIFETIME_CAP_REACHED');
    expect(lifetime.refereeCentavos).toBe(25_000);
  });

  it('and the same for a blocked or suspended inviter', () => {
    // A rider suspended for a bad reason should not also cost their invitee a
    // bonus they earned by working.
    for (const state of ['referrerIsBlocked', 'referrerIsSuspended'] as const) {
      const decision = rewardForPartnerReferral(facts({ [state]: true }));
      expect(decision.referrerCentavos, state).toBe(0);
      expect(decision.refereeCentavos, state).toBe(25_000);
    }
  });

  it('refuses both when the programme is off, because then there is no promise', () => {
    const decision = rewardForPartnerReferral(
      facts({ programme: PARTNER_PROGRAMME_OFF }),
    );
    expect(paysNothing(decision)).toBe(true);
    expect(decision.referrerRefusal).toBe('PROGRAMME_OFF');
    expect(decision.refereeRefusal).toBe('PROGRAMME_OFF');
  });

  it('names NOTHING_TO_PAY per side rather than pretending to pay zero', () => {
    const noReferee = rewardForPartnerReferral(
      facts({ programme: { ...LIVE, refereeCentavos: 0 } }),
    );
    expect(noReferee.refereeRefusal).toBe('NOTHING_TO_PAY');
    expect(noReferee.referrerCentavos).toBe(50_000);

    const noReferrer = rewardForPartnerReferral(
      facts({ programme: { ...LIVE, referrerCentavos: 0 } }),
    );
    expect(noReferrer.referrerRefusal).toBe('NOTHING_TO_PAY');
    expect(noReferrer.refereeCentavos).toBe(25_000);
  });

  it('caps each side at the typo ceiling', () => {
    const decision = rewardForPartnerReferral(
      facts({
        programme: {
          ...LIVE,
          referrerCentavos: MAX_PARTNER_REWARD_CENTAVOS + 100_000,
          refereeCentavos: MAX_PARTNER_REWARD_CENTAVOS + 1,
        },
      }),
    );
    expect(decision.referrerCentavos).toBe(MAX_PARTNER_REWARD_CENTAVOS);
    expect(decision.refereeCentavos).toBe(MAX_PARTNER_REWARD_CENTAVOS);
  });

  it('has a sentence for every reward refusal', () => {
    const branches: PartnerRewardRefusal[] = [
      'PROGRAMME_OFF',
      'NOT_ENOUGH_DELIVERIES',
      'MONTHLY_CAP_REACHED',
      'LIFETIME_CAP_REACHED',
      'REFERRER_BLOCKED',
      'REFERRER_SUSPENDED',
      'NOTHING_TO_PAY',
    ];
    for (const branch of branches) {
      expect(PARTNER_REWARD_REFUSAL_TEXT[branch].length, branch).toBeGreaterThan(10);
    }
  });
});

describe('what a rider costs to acquire', () => {
  it('adds both sides and spreads them over the work', () => {
    const cost = acquisitionCost(LIVE);
    expect(cost.bothSidesCentavos).toBe(75_000);
    expect(cost.qualifyingDeliveries).toBe(20);
    expect(cost.perQualifyingDeliveryCentavos).toBe(3_750);
  });

  it('rounds the per-delivery figure UP, so it never understates the spend', () => {
    const cost = acquisitionCost({
      ...LIVE,
      referrerCentavos: 10_001,
      refereeCentavos: 0,
      qualifyingDeliveries: 3,
    });
    // 10001 / 3 = 3333.67
    expect(cost.perQualifyingDeliveryCentavos).toBe(3_334);
  });

  it('does not divide by zero on a programme with no threshold', () => {
    expect(
      acquisitionCost({ ...LIVE, qualifyingDeliveries: 0 })
        .perQualifyingDeliveryCentavos,
    ).toBe(0);
  });

  it('bounds the inviter side only, and says so by excluding the other', () => {
    // referrer 500 × lifetime cap 10. The referee side is bounded by how many
    // new riders exist rather than by any cap, so including it would look like
    // a bound and would not be one.
    expect(acquisitionCost(LIVE).lifetimeLiabilityPerReferrerCentavos).toBe(500_000);
  });

  it('agrees with the database ceiling', () => {
    const guards = source('prisma/sql/partner_referrals.sql');
    expect(guards).toContain(String(MAX_PARTNER_REWARD_CENTAVOS));
    // And the guard that stops a live programme paying on signup.
    expect(guards).toMatch(/"qualifyingDeliveries" >= 1/);
  });
});

/**
 * The currency is the whole point, and it is the easiest thing to get wrong by
 * copying a sentence from next door. A rider who reads "credits" will look for
 * them on a screen that does not apply to them, and a rider who reads "paid"
 * will look for money that has not been transferred yet.
 */
describe('a rider bonus is money, and every sentence says so', () => {
  /**
   * Tested against the exported VALUES rather than by parsing the source.
   *
   * The first version regexed string literals out of these files, which broke
   * twice: an apostrophe in a comment opened a literal that ran on for
   * paragraphs, and then an apostrophe in JSX prose did the same. Both were
   * the test being clever about a question it could ask directly.
   */
  it('never offers a rider credits in a refusal', () => {
    for (const [branch, text] of Object.entries(PARTNER_REFUSAL_TEXT)) {
      expect(text.toLowerCase(), branch).not.toContain('credit');
    }
    for (const [branch, text] of Object.entries(PARTNER_REWARD_REFUSAL_TEXT)) {
      expect(text.toLowerCase(), branch).not.toContain('credit');
    }
  });

  it('tells the rider the money is owed rather than paid', () => {
    const rendered = renderNotification(NotificationKind.PARTNER_REFERRAL_SETTLED, {
      amountCentavos: 50_000,
      inviteRole: 'REFERRER',
    });
    expect(rendered.body).toMatch(/owes you/i);
    expect(rendered.body).toMatch(/payout/i);
    expect(rendered.body.toLowerCase()).not.toContain('credit');
    // "has been paid" would be a lie: nothing has left a bank account.
    expect(rendered.body).not.toMatch(/\bhas been paid\b/i);
    expect(rendered.sms.toLowerCase()).not.toContain('credit');
  });

  it('says something different to the rider who was invited', () => {
    const inviter = renderNotification(NotificationKind.PARTNER_REFERRAL_SETTLED, {
      amountCentavos: 50_000,
      inviteRole: 'REFERRER',
    });
    const invited = renderNotification(NotificationKind.PARTNER_REFERRAL_SETTLED, {
      amountCentavos: 25_000,
      inviteRole: 'REFEREE',
    });
    expect(invited.body).not.toBe(inviter.body);
    expect(inviter.body).toMatch(/rider you invited/i);
    expect(invited.body).toMatch(/you have completed/i);
  });

  it('explains a refusal instead of going quiet', () => {
    const rendered = renderNotification(NotificationKind.PARTNER_REFERRAL_SETTLED, {
      amountCentavos: 0,
      inviteRole: 'REFERRER',
      reason: PARTNER_REWARD_REFUSAL_TEXT.MONTHLY_CAP_REACHED,
    });
    expect(rendered.body).toContain(PARTNER_REWARD_REFUSAL_TEXT.MONTHLY_CAP_REACHED);
  });

  it('and the rider’s own screen contrasts the two currencies out loud', () => {
    // The one place "credits" SHOULD appear in rider-facing copy: saying which
    // of the two this is not. A rider who assumes credits will go looking for
    // them on a screen that does not apply to them.
    const screen = codeOnly('src/app/fleet/invite/page.tsx');
    expect(screen).toMatch(/money.{0,40}not credits/is);
  });
});

describe('the bonus on the settlement ledger', () => {
  it('increases what TARA owes, and is labelled as recruitment', () => {
    expect(ENTRY_DIRECTION[SettlementEntryType.REFERRAL_BONUS]).toBe(1);
    // Not "Earned": a rider must be able to tell the ₱500 they got for
    // bringing a friend from the ₱500 they got for riding.
    expect(ENTRY_LABEL[SettlementEntryType.REFERRAL_BONUS]).not.toBe(
      ENTRY_LABEL[SettlementEntryType.ORDER_EARNINGS],
    );
  });

  it('is keyed per referral AND per side, so neither side is paid twice', () => {
    const rewards = source('src/lib/referrals/partner-rewards.ts');
    expect(rewards).toMatch(/partner-referral-\$\{input\.side\}:\$\{input\.referralId\}/);
  });

  it('carries no orderId, and says why in the schema', () => {
    const rewards = source('src/lib/referrals/partner-rewards.ts');
    // The accrual helper must not pass one: a line on the inviter's statement
    // naming somebody else's delivery would be a lie on the one screen they
    // read.
    const accrue = /async function accrue\([\s\S]*?\n}/.exec(rewards)?.[0] ?? '';
    expect(accrue).toContain('recordSettlementEntry');
    expect(accrue).not.toMatch(/^\s*orderId:/m);
    expect(source('prisma/schema.prisma')).toMatch(
      /REFERRAL_BONUS[\s\S]{0,40}A signed correction|deliberately NOT tied to an order/,
    );
  });
});
