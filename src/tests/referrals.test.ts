import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminAction, NotificationChannel, NotificationKind } from '@prisma/client';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_REWARD_CENTAVOS,
  PROGRAMME_OFF,
  REFUSAL_TEXT,
  REWARD_REFUSAL_TEXT,
  codeFromBytes,
  codeLooksValid,
  farmerMargin,
  lifetimeLiabilityPerReferrer,
  normaliseCode,
  programmeIsLive,
  refusalForAttribution,
  rewardForReferral,
  type AttributionRefusal,
  type ProgrammeFacts,
  type RewardRefusal,
} from '@/lib/referrals/policy';
import { monthStart } from '@/lib/referrals/rewards';
import { KIND_POLICY } from '@/lib/notifications/policy';
import { ADMIN_ACTION_LABEL } from '@/lib/admin/access';

/**
 * Referrals.
 *
 * One idea carries this file: **referrals are the only path by which credits
 * come into existence at the invitation of a user.** Every other grant is
 * caused by an order completing or by an administrator acting against their own
 * name. So the tests are mostly refusals, and the ones that are not are about
 * whether the amounts an operator picks make self-referral profitable.
 *
 * What is deliberately NOT tested is fraud detection, because there is none to
 * test. Two accounts held by one person are, to the database, two people —
 * phone numbers are cheap, no device identity is held, and address matching
 * would refuse the households that routinely share an address here. The
 * defences are structural: credits cannot be cashed out, the inviter is paid
 * only for a delivered order, and the caps bound the rest.
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

/** A programme somebody sensible would run: ₱50 each side, ₱200 minimum. */
const SENSIBLE: ProgrammeFacts = {
  isActive: true,
  refereeCentavos: 5_000,
  referrerCentavos: 5_000,
  minimumOrderCentavos: 20_000,
  monthlyRewardCap: 3,
  lifetimeRewardCap: 10,
};

describe('the code alphabet', () => {
  it('excludes both members of every confusable pair', () => {
    // A code is read off one phone and typed into another, usually by somebody
    // who did not choose it. Excluding BOTH members is what lets
    // `normaliseCode` strip rather than guess.
    for (const character of ['O', '0', 'I', '1', 'L', 'S']) {
      expect(CODE_ALPHABET, `${character} must not be in the alphabet`).not.toContain(
        character,
      );
    }
  });

  it('is big enough that six characters is not crowded', () => {
    expect(CODE_ALPHABET.length ** CODE_LENGTH).toBeGreaterThan(100_000_000);
  });

  it('has no duplicate characters', () => {
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });
});

describe('reading a code a human typed', () => {
  it('accepts it with spaces, dashes and lower case', () => {
    expect(normaliseCode('abc-234')).toBe('ABC234');
    expect(normaliseCode(' ABC 234 ')).toBe('ABC234');
  });

  it('pulls the code out of a pasted link', () => {
    expect(normaliseCode('https://tara.ph/?ref=ABC234')).toBe('ABC234');
    expect(normaliseCode('https://tara.ph/stores/x?city=1&ref=ABC234')).toBe('ABC234');
  });

  it('does NOT fold a confusable onto a different valid code', () => {
    // The bug this replaced: mapping 0→O→Q and S→5 turned a typo into another
    // real code, which would attribute somebody to a stranger who happens to
    // own it. Stripping leaves it the wrong length, so the person is told.
    expect(normaliseCode('ABC23O')).toBe('ABC23');
    expect(codeLooksValid(normaliseCode('ABC23O'))).toBe(false);
    expect(normaliseCode('S23456')).toBe('23456');
    expect(codeLooksValid(normaliseCode('S23456'))).toBe(false);
  });

  it('rejects anything that is not the right shape', () => {
    expect(codeLooksValid('ABC23')).toBe(false);
    expect(codeLooksValid('ABC2345')).toBe(false);
    expect(codeLooksValid('')).toBe(false);
    expect(codeLooksValid('ABC23O')).toBe(false);
  });

  it('accepts a real code', () => {
    expect(codeLooksValid('ABC234')).toBe(true);
  });
});

describe('minting a code', () => {
  it('produces a valid code from enough bytes', () => {
    const bytes = new Uint8Array(64).map((_unused, index) => (index * 7) % 256);
    const code = codeFromBytes(bytes);
    expect(code).toHaveLength(CODE_LENGTH);
    expect(codeLooksValid(code)).toBe(true);
  });

  it('discards the biased tail rather than folding it back', () => {
    // 256 is not a multiple of 30, so `byte % 30` would make the first six
    // letters meaningfully likelier. Rejection sampling instead: bytes at or
    // above the largest multiple of 30 contribute nothing.
    const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
    const rejected = new Uint8Array(20).fill(limit);
    expect(codeFromBytes(rejected)).toBe('');
  });

  it('comes back short rather than wrong when given too few bytes', () => {
    // The caller checks the length; producing a 3-character "code" silently
    // would put an unusable code in somebody's account.
    expect(codeFromBytes(new Uint8Array([0, 1, 2])).length).toBeLessThan(CODE_LENGTH);
  });
});

describe('off by default', () => {
  it('ships off, paying nothing', () => {
    expect(programmeIsLive(PROGRAMME_OFF)).toBe(false);
    expect(PROGRAMME_OFF.refereeCentavos).toBe(0);
    expect(PROGRAMME_OFF.referrerCentavos).toBe(0);
  });

  it('an absent row reads as off rather than as a default offer', () => {
    const programme = codeOnly('src/lib/referrals/programme.ts');
    expect(programme).toMatch(/if \(!row\) return PROGRAMME_OFF/);
  });

  it('is not live merely because it is switched on', () => {
    // A programme on with both amounts at zero is a code that earns nothing,
    // and showing somebody an invite screen for it is worse than saying no.
    expect(
      programmeIsLive({ ...PROGRAMME_OFF, isActive: true }),
    ).toBe(false);
  });

  it('refuses every attribution while off', () => {
    expect(
      refusalForAttribution({
        programme: PROGRAMME_OFF,
        referrer: { id: 'a', isBlocked: false },
        referee: { id: 'b', alreadyReferred: false, completedOrderCount: 0 },
      }),
    ).toBe('PROGRAMME_OFF');
  });
});

describe('who may be attributed', () => {
  const facts = (over: Partial<Parameters<typeof refusalForAttribution>[0]>) =>
    refusalForAttribution({
      programme: SENSIBLE,
      referrer: { id: 'ana', isBlocked: false },
      referee: { id: 'ben', alreadyReferred: false, completedOrderCount: 0 },
      ...over,
    });

  it('allows a genuinely new customer', () => {
    expect(facts({})).toBeNull();
  });

  it('refuses somebody using their own code', () => {
    expect(
      facts({ referee: { id: 'ana', alreadyReferred: false, completedOrderCount: 0 } }),
    ).toBe('OWN_CODE');
  });

  it('refuses an account that already used a code', () => {
    expect(
      facts({ referee: { id: 'ben', alreadyReferred: true, completedOrderCount: 0 } }),
    ).toBe('ALREADY_REFERRED');
  });

  it('refuses an existing customer, whatever link they clicked', () => {
    // Without this, two existing customers refer each other and both collect —
    // self-referral with an extra step and no SIM cards needed.
    expect(
      facts({ referee: { id: 'ben', alreadyReferred: false, completedOrderCount: 1 } }),
    ).toBe('NOT_A_NEW_CUSTOMER');
  });

  it('refuses a blocked referrer', () => {
    expect(facts({ referrer: { id: 'ana', isBlocked: true } })).toBe(
      'REFERRER_BLOCKED',
    );
  });

  it('refuses a code that matches nobody', () => {
    expect(facts({ referrer: null })).toBe('UNKNOWN_CODE');
  });

  it('names every refusal it can return', () => {
    const refusals: AttributionRefusal[] = [
      'PROGRAMME_OFF',
      'UNKNOWN_CODE',
      'OWN_CODE',
      'ALREADY_REFERRED',
      'NOT_A_NEW_CUSTOMER',
      'REFERRER_BLOCKED',
    ];
    for (const refusal of refusals) {
      expect(REFUSAL_TEXT[refusal].length).toBeGreaterThan(10);
    }
    expect(Object.keys(REFUSAL_TEXT).sort()).toEqual([...refusals].sort());
  });
});

describe('paying the inviter', () => {
  const facts = (over: Partial<Parameters<typeof rewardForReferral>[0]> = {}) =>
    rewardForReferral({
      programme: SENSIBLE,
      orderCentavos: 25_000,
      rewardedThisMonth: 0,
      rewardedEver: 0,
      referrerIsBlocked: false,
      ...over,
    });

  it('pays the configured amount for a qualifying order', () => {
    expect(facts()).toEqual({ payCentavos: 5_000, refusal: null });
  });

  it('pays nothing for an order below the minimum', () => {
    expect(facts({ orderCentavos: 19_999 }).refusal).toBe('ORDER_TOO_SMALL');
  });

  it('pays at exactly the minimum', () => {
    expect(facts({ orderCentavos: 20_000 }).refusal).toBeNull();
  });

  it('stops at the monthly cap', () => {
    expect(facts({ rewardedThisMonth: 3 }).refusal).toBe('MONTHLY_CAP_REACHED');
    expect(facts({ rewardedThisMonth: 2 }).refusal).toBeNull();
  });

  it('stops at the lifetime cap', () => {
    expect(facts({ rewardedThisMonth: 0, rewardedEver: 10 }).refusal).toBe(
      'LIFETIME_CAP_REACHED',
    );
  });

  it('pays a blocked referrer nothing', () => {
    expect(facts({ referrerIsBlocked: true }).refusal).toBe('REFERRER_BLOCKED');
  });

  it('never exceeds the hard ceiling, whatever the row says', () => {
    const silly = { ...SENSIBLE, referrerCentavos: 900_000 };
    expect(facts({ programme: silly }).payCentavos).toBe(MAX_REWARD_CENTAVOS);
  });

  it('agrees with the ceiling the database enforces', () => {
    expect(source('prisma/sql/referrals.sql')).toContain(
      `<= ${MAX_REWARD_CENTAVOS}`,
    );
  });

  it('tests the order’s own worth, not what the customer paid', () => {
    // Otherwise a referee spends their welcome credits, drops a ₱250 order
    // under a ₱200 minimum, and costs their inviter the reward. A customer's
    // discount is not evidence about the order's size.
    const rewards = codeOnly('src/lib/referrals/rewards.ts');
    expect(rewards).toMatch(/orderCentavos: grossOrderCentavos\(order\)/);
    expect(rewards).not.toMatch(/orderCentavos: order\.totalCentavos/);
  });

  it('counts referrals PAID, not attributed, against the caps', () => {
    // An enthusiast whose ten friends signed up and none ordered has been paid
    // for none, and should not be out of allowance for other people's inaction.
    const rewards = codeOnly('src/lib/referrals/rewards.ts');
    const monthly = rewards.slice(rewards.indexOf('rewardedThisMonth'));
    expect(monthly).toMatch(/status: ReferralStatus\.REWARDED/);
  });

  it('names every reward refusal', () => {
    const refusals: RewardRefusal[] = [
      'PROGRAMME_OFF',
      'ORDER_TOO_SMALL',
      'MONTHLY_CAP_REACHED',
      'LIFETIME_CAP_REACHED',
      'REFERRER_BLOCKED',
      'NOTHING_TO_PAY',
    ];
    for (const refusal of refusals) {
      expect(REWARD_REFUSAL_TEXT[refusal].length).toBeGreaterThan(10);
    }
    expect(Object.keys(REWARD_REFUSAL_TEXT).sort()).toEqual([...refusals].sort());
  });
});

describe('whether self-referral pays', () => {
  it('costs money at sensible amounts', () => {
    const margin = farmerMargin(SENSIBLE);
    expect(margin.bothSidesCentavos).toBe(10_000);
    // ₱100 collected against a ₱200 order they had to buy.
    expect(margin.netCentavos).toBe(-10_000);
    expect(margin.farmingPays).toBe(false);
  });

  it('pays when the amounts exceed the minimum order', () => {
    const generous = {
      ...SENSIBLE,
      refereeCentavos: 15_000,
      referrerCentavos: 15_000,
      minimumOrderCentavos: 20_000,
    };
    const margin = farmerMargin(generous);
    expect(margin.netCentavos).toBe(10_000);
    expect(margin.farmingPays).toBe(true);
  });

  it('pays outright with no minimum order at all', () => {
    const margin = farmerMargin({ ...SENSIBLE, minimumOrderCentavos: 0 });
    expect(margin.farmingPays).toBe(true);
    expect(margin.netCentavos).toBe(10_000);
  });

  it('breaks even exactly when both sides equal the minimum', () => {
    const margin = farmerMargin({ ...SENSIBLE, minimumOrderCentavos: 10_000 });
    expect(margin.netCentavos).toBe(0);
    // Break-even is not "pays": a farmer at zero has done work for nothing.
    expect(margin.farmingPays).toBe(false);
  });

  it('counts the welcome credits as usable against the qualifying order', () => {
    // Which is why a generous REFEREE reward with a low minimum is the
    // dangerous combination, not a generous inviter reward alone.
    const margin = farmerMargin(SENSIBLE);
    expect(margin.outlayCentavos).toBe(15_000);
  });

  it('bounds one account’s lifetime cost by the cap', () => {
    expect(lifetimeLiabilityPerReferrer(SENSIBLE)).toBe(50_000);
    expect(lifetimeLiabilityPerReferrer(PROGRAMME_OFF)).toBe(0);
  });

  it('is put in front of the operator rather than left to be discovered', () => {
    const page = codeOnly('src/app/admin/referrals/page.tsx');
    expect(page).toMatch(/margin\.farmingPays/);
    expect(page).toMatch(/role="alert"/);
    // And the action warns on save, not only on the next page load.
    const actions = source('src/lib/actions/admin-actions.ts');
    expect(actions).toMatch(/somebody referring themselves nets/);
  });
});

describe('the month a cap resets on', () => {
  it('is the first of the month in Manila, not in UTC', () => {
    // 1 March 07:00 UTC is 15:00 on the 1st in Manila, so the month boundary
    // is February's end in UTC terms — an hour that a UTC month start would
    // put in the wrong month.
    const manilaFirstOfMarch = new Date('2026-03-01T07:00:00.000Z');
    expect(monthStart(manilaFirstOfMarch).toISOString()).toBe(
      '2026-02-28T16:00:00.000Z',
    );
  });

  it('puts the last hour of a Manila month in that month', () => {
    // 31 March 23:30 Manila is 15:30 UTC on the 31st.
    const lastHour = new Date('2026-03-31T15:30:00.000Z');
    expect(monthStart(lastHour).toISOString()).toBe('2026-02-28T16:00:00.000Z');
  });

  it('rolls over on the Manila boundary', () => {
    // 1 April 00:30 Manila is 31 March 16:30 UTC.
    const justAfter = new Date('2026-03-31T16:30:00.000Z');
    expect(monthStart(justAfter).toISOString()).toBe('2026-03-31T16:00:00.000Z');
  });
});

describe('there is no path from a referral to cash', () => {
  it('grants through the one ledger function, never a balance field', () => {
    for (const file of [
      'src/lib/referrals/attribution.ts',
      'src/lib/referrals/rewards.ts',
    ]) {
      const text = codeOnly(file);
      expect(text).toMatch(/grantCredit\(/);
      expect(text).not.toMatch(/balanceCentavos:/);
      expect(text).not.toMatch(/wallet\.update|walletUpdate/);
    }
  });

  it('grants only the one credit type meant for it', () => {
    for (const file of [
      'src/lib/referrals/attribution.ts',
      'src/lib/referrals/rewards.ts',
    ]) {
      expect(codeOnly(file)).toMatch(/type: 'REFERRAL_BONUS'/);
    }
  });

  it('is idempotent per referral, on both sides', () => {
    // A retried completion must not pay twice, and a retried attribution must
    // not grant twice.
    expect(codeOnly('src/lib/referrals/attribution.ts')).toMatch(
      /idempotencyKey: `referral-referee:\$\{referral\.id\}`/,
    );
    expect(codeOnly('src/lib/referrals/rewards.ts')).toMatch(
      /idempotencyKey: `referral-referrer:\$\{referral\.id\}`/,
    );
  });

  it('says the constraints out loud on the invite screen', () => {
    // A customer should never discover these at the moment they are counting
    // on the opposite.
    // Whitespace-normalised: the copy wraps across JSX lines, and a regex that
    // depends on where the wrap falls breaks on a reformat.
    const page = source('src/app/invite/page.tsx').replace(/\s+/g, ' ');
    expect(page).toContain('only be spent on orders in the app');
    expect(page).toContain('cannot be sent to anybody or turned back into cash');
  });

  it('keeps the ledger sign forced in SQL for this type too', () => {
    expect(source('prisma/sql/wallet_append_only.sql')).toMatch(
      /'PROMO_CREDIT', 'REFUND', 'REFERRAL_BONUS'/,
    );
  });
});

describe('attribution is a fact, not a field', () => {
  it('is immutable in the database', () => {
    // An attribution that could be rewritten would let a second referrer claim
    // an account after its first order completed, which is the whole game.
    const guards = source('prisma/sql/referrals.sql');
    expect(guards).toMatch(/referral_no_reattribution/);
    expect(guards).toMatch(/referral_attribution_is_immutable/);
    // While still allowing the reward columns to be filled in.
    expect(guards).toMatch(/Reward columns may be filled in/);
  });

  it('refuses self-referral and double attribution in the database', () => {
    const guards = source('prisma/sql/referrals.sql');
    expect(guards).toMatch(/referral_not_self/);
    expect(guards).toMatch(/"referrerId" <> "refereeId"/);
    expect(codeOnly('prisma/schema.prisma')).toMatch(/refereeId String @unique/);
  });

  it('will not record a payment with no order behind it', () => {
    const guards = source('prisma/sql/referrals.sql');
    expect(guards).toMatch(/referral_reward_names_its_order/);
  });

  it('will not record a refusal with no reason', () => {
    expect(source('prisma/sql/referrals.sql')).toMatch(
      /referral_refusal_has_a_reason/,
    );
  });

  it('allows only one programme row', () => {
    expect(source('prisma/sql/referrals.sql')).toMatch(
      /referral_programme_singleton/,
    );
  });
});

describe('the code survives the signup it triggers', () => {
  it('is parked in a cookie by the middleware', () => {
    // A shared link is opened by somebody with no account. What follows is a
    // login, an SMS round trip and an onboarding form — three navigations that
    // all lose the query string.
    const middleware = codeOnly('src/middleware.ts');
    expect(middleware).toMatch(/captureReferralCode/);
    expect(middleware).toMatch(/searchParams\.get\('ref'\)/);
    expect(middleware).toMatch(/httpOnly: true/);
  });

  it('lets the FIRST link win, not the last', () => {
    // Otherwise anybody could overwrite a pending attribution by sending a
    // second link.
    expect(codeOnly('src/middleware.ts')).toMatch(
      /if \(request\.cookies\.has\(REFERRAL_COOKIE\)\) return response/,
    );
  });

  it('does not capture a code for an account that already exists', () => {
    expect(codeOnly('src/middleware.ts')).toMatch(
      /if \(request\.cookies\.has\(SESSION_COOKIE\)\) return response/,
    );
  });

  it('bounds and strips the value before storing it', () => {
    const middleware = codeOnly('src/middleware.ts');
    expect(middleware).toMatch(/\.slice\(0, 32\)/);
    expect(middleware).toMatch(/CODE_ALPHABET_PATTERN/);
  });

  it('is captured on the login redirect too, not only on public pages', () => {
    // The most likely shape of a shared link is a deep one ("look at this
    // shop"), which bounces to /login before any page renders.
    const middleware = codeOnly('src/middleware.ts');
    expect(middleware).toMatch(
      /captureReferralCode\(request, NextResponse\.redirect\(login\)\)/,
    );
  });

  it('is claimed at onboarding and never blocks it', () => {
    const auth = codeOnly('src/lib/actions/auth-actions.ts');
    expect(auth).toMatch(/await claimReferralCookie\(user\.id\)/);
    const attribution = codeOnly('src/lib/referrals/attribution.ts');
    // Wrapped, because a stale code must not stop somebody finishing signup.
    const claim = attribution.slice(attribution.indexOf('claimReferralCookie'));
    expect(claim).toMatch(/try \{/);
    expect(claim).toMatch(/\} catch \{/);
  });

  it('offers a way in for somebody who was told the code, not sent it', () => {
    // Which is most of them: a code read out or typed into a group chat never
    // passes through the cookie.
    expect(codeOnly('src/lib/actions/referral-actions.ts')).toMatch(
      /enterReferralCodeAction/,
    );
    expect(codeOnly('src/components/referrals/EnterCode.tsx')).toMatch(
      /normaliseCode\(value\)/,
    );
  });
});

describe('the inviter is paid on a completed order, not a placed one', () => {
  it('runs inside the completion transaction', () => {
    // A completion that paid a referral in a separate step could pay twice or
    // not at all.
    const sweep = codeOnly('src/lib/orders/maintenance.ts');
    expect(sweep).toMatch(/await payReferrerForOrder\(order, tx\)/);
    const completion = sweep.slice(
      sweep.indexOf('export async function completeOrder'),
    );
    expect(completion.indexOf('payReferrerForOrder')).toBeGreaterThan(-1);
  });

  it('is not wired into placement, where nothing has been delivered yet', () => {
    expect(codeOnly('src/lib/orders/place-order.ts')).not.toMatch(
      /payReferrerForOrder/,
    );
  });

  it('settles a refusal terminally rather than leaving it pending forever', () => {
    const rewards = codeOnly('src/lib/referrals/rewards.ts');
    expect(rewards).toMatch(/status: ReferralStatus\.NOT_REWARDED/);
    expect(rewards).toMatch(/blockedReason: REWARD_REFUSAL_TEXT\[decision\.refusal\]/);
  });

  it('tells the inviter either way', () => {
    // Somebody who shared a code and watched a friend order deserves to know
    // why nothing arrived; an unexplained absence is how this becomes a
    // support queue.
    const rewards = codeOnly('src/lib/referrals/rewards.ts');
    expect((rewards.match(/tellReferrer\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(KIND_POLICY[NotificationKind.REFERRAL_SETTLED].channels).not.toContain(
      NotificationChannel.SMS,
    );
  });
});

describe('changing the programme is an audited decision', () => {
  it('is named in the audit log’s vocabulary', () => {
    expect(
      ADMIN_ACTION_LABEL[AdminAction.REFERRAL_PROGRAMME_CHANGED].length,
    ).toBeGreaterThan(5);
  });

  it('demands a reason and records what changed', () => {
    const actions = codeOnly('src/lib/actions/admin-actions.ts');
    const referral = actions.slice(actions.indexOf('setReferralProgrammeAction'));
    expect(referral).toMatch(/normaliseReason\(formData\.get\('reason'\)\)/);
    expect(referral).toMatch(/AdminAction\.REFERRAL_PROGRAMME_CHANGED/);
    expect(referral).toMatch(/before:/);
    expect(referral).toMatch(/after: data/);
  });

  it('refuses a live programme that can never pay', () => {
    const actions = source('src/lib/actions/admin-actions.ts');
    expect(actions).toMatch(/A live programme needs both caps above zero/);
    expect(actions).toMatch(/A live programme has to pay somebody something/);
  });
});
