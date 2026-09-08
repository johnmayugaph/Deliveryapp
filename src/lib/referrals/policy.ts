/**
 * Referrals: the rules, with no database and no clock.
 *
 * Referrals are the only path in this app by which credits come into existence
 * **at the invitation of a user.** Every other grant is caused by an order
 * completing, or by an administrator acting with a reason against their own
 * name. That makes this the one feature where a stranger can make credits
 * appear, and it is why almost everything below is a refusal rather than a
 * calculation.
 *
 * ### What actually stops abuse, and what only looks like it does
 *
 * The obvious attack is self-referral: one person, a drawer of SIM cards, an
 * account per card. A `referrerId <> refereeId` check catches the naive version
 * and nothing else — two accounts held by one person are, to the database, two
 * people. There is no honest way to tell them apart. Phone numbers are cheap,
 * we hold no device identity, and address matching would refuse mostly-honest
 * cases: households in the Philippines routinely share an address, and a
 * feature that accuses a mother and her daughter of fraud is worse than one
 * that pays them both.
 *
 * So the defence is not detection. It is three structural facts:
 *
 *  1. **The reward is credits**, and credits cannot be topped up, transferred
 *     or cashed out — they only reduce a future bill. A farmer's payoff is
 *     discounted food, not money.
 *  2. **The referrer is paid only when the referee's first order COMPLETES**,
 *     and only above a minimum order value. Farming therefore costs a real
 *     order that was really paid for and really delivered.
 *  3. **Caps.** Per month and for life, per referrer. This is what turns an
 *     unbounded liability into a budget, and it is the only mechanism here that
 *     works without needing to know who anybody is.
 *
 * Which leaves one number that decides whether the whole thing is farmable, and
 * it is not mine to pick: the amounts. `farmerMargin` below computes what a
 * person using their own SIM cards nets per account at a given pair of amounts,
 * so the console can show an operator the arithmetic of their own choice
 * instead of leaving them to discover it in a month's ledger.
 *
 * Pure: imports nothing but types.
 */

/**
 * The alphabet a code is drawn from.
 *
 * No O, 0, I, 1, L or S — a code is read off one phone screen and typed into
 * another, usually by somebody who did not choose it, and "was that an O or a
 * zero" is a support ticket rather than a signup. Digits 2-9 and the letters
 * that cannot be confused for them.
 *
 * Excluding BOTH members of each confusable pair is what makes `normaliseCode`
 * able to strip rather than guess: since no valid code contains an O, a typed O
 * cannot be silently read as some other real code.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ23456789';

/** Six characters from a 30-letter alphabet: about 729 million codes. */
export const CODE_LENGTH = 6;

/**
 * The most one side of a referral may be worth, in centavos.
 *
 * Mirrors `referral_programme_sane` in `prisma/sql/referrals.sql`, and a test
 * asserts they agree. ₱500 is a guard against a typo rather than a policy — a
 * referral worth more than a large order is a decimal point in the wrong place,
 * and a typo here is a liability against every account on the platform at once.
 */
export const MAX_REWARD_CENTAVOS = 50_000;

/** The programme's shape, structurally, so a Prisma row passes straight in. */
export interface ProgrammeFacts {
  isActive: boolean;
  refereeCentavos: number;
  referrerCentavos: number;
  minimumOrderCentavos: number;
  monthlyRewardCap: number;
  lifetimeRewardCap: number;
}

/** Nothing configured. Referrals are off, and every read gets this. */
export const PROGRAMME_OFF: ProgrammeFacts = {
  isActive: false,
  refereeCentavos: 0,
  referrerCentavos: 0,
  minimumOrderCentavos: 0,
  monthlyRewardCap: 0,
  lifetimeRewardCap: 0,
};

/**
 * True when the programme can actually pay anybody.
 *
 * Active is not enough: a programme switched on with both amounts at zero is a
 * code that earns nothing, and showing somebody an invite screen for it is
 * worse than telling them referrals are off.
 */
export function programmeIsLive(programme: ProgrammeFacts): boolean {
  return (
    programme.isActive &&
    (programme.refereeCentavos > 0 || programme.referrerCentavos > 0)
  );
}

// --- Codes -------------------------------------------------------------------

/**
 * Tidies a code a human typed or pasted.
 *
 * Uppercases, pulls the code out of a pasted link, and STRIPS everything that
 * is not in the alphabet — spaces, dashes somebody added for readability, the
 * rest of a URL.
 *
 * It deliberately does not "helpfully" fold confusable characters onto the
 * alphabet. The first version of this function mapped `0`→`O`→`Q` and `S`→`5`,
 * reasoning that somebody who types O for Q has misread rather than mistyped.
 * That is true and the fix was still wrong: `Q` and `5` are themselves valid
 * code characters, so the mapping could silently turn a typo into a DIFFERENT
 * VALID CODE — and attribute somebody to a stranger who happens to own it. The
 * alphabet exists to remove that ambiguity; guessing on top of it puts the
 * ambiguity back with a worse failure mode.
 *
 * So a code with a confusable in it comes back the wrong length, fails
 * `codeLooksValid`, and the person is told it does not look right — which is a
 * dead end they can escape by looking again, rather than a wrong answer they
 * cannot see.
 */
export function normaliseCode(raw: string): string {
  const upper = raw.toUpperCase();
  // A pasted link: take the ref parameter's value if one is in there.
  const fromLink = /[?&]REF=([A-Z0-9]+)/.exec(upper);
  const source = fromLink?.[1] ?? upper;

  return [...source].filter((character) => CODE_ALPHABET.includes(character)).join('');
}

/** Whether a normalised code is the right shape to bother looking up. */
export function codeLooksValid(code: string): boolean {
  return (
    code.length === CODE_LENGTH &&
    [...code].every((character) => CODE_ALPHABET.includes(character))
  );
}

/**
 * Builds a code from random bytes.
 *
 * Takes the bytes rather than generating them, so the caller supplies the CSPRNG
 * and this stays pure and testable. Rejection sampling rather than a modulo:
 * 256 is not a multiple of 30, so `byte % 30` would make the first six letters
 * of the alphabet meaningfully likelier — which is not a security problem at
 * this size, but it is a bias nobody would choose on purpose and the fix costs
 * one comparison.
 */
export function codeFromBytes(bytes: Uint8Array): string {
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let code = '';
  for (const byte of bytes) {
    if (byte >= limit) continue;
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    if (code.length === CODE_LENGTH) break;
  }
  return code;
}

// --- Eligibility -------------------------------------------------------------

/** Why an attribution was refused. Every branch named, none silent. */
export type AttributionRefusal =
  /** The programme is off, or pays nothing. */
  | 'PROGRAMME_OFF'
  /** The code does not match any account. */
  | 'UNKNOWN_CODE'
  /** Somebody scanned their own code. */
  | 'OWN_CODE'
  /** This account was already attributed to somebody. */
  | 'ALREADY_REFERRED'
  /** Not a new customer: they have ordered before. */
  | 'NOT_A_NEW_CUSTOMER'
  /** The referrer's account is blocked. */
  | 'REFERRER_BLOCKED';

export interface AttributionFacts {
  programme: ProgrammeFacts;
  /** The account that owns the code, or null when no code matched. */
  referrer: { id: string; isBlocked: boolean } | null;
  referee: { id: string; alreadyReferred: boolean; completedOrderCount: number };
}

/**
 * Whether this account may be attributed to this code.
 *
 * `NOT_A_NEW_CUSTOMER` is the one worth explaining. A referral is payment for
 * bringing somebody who was not here — so an account that has already ordered
 * cannot be introduced, whatever link they clicked. Without it, two existing
 * customers could refer each other and both collect, which is self-referral
 * with an extra step and no SIM cards required.
 */
export function refusalForAttribution(
  facts: AttributionFacts,
): AttributionRefusal | null {
  if (!programmeIsLive(facts.programme)) return 'PROGRAMME_OFF';
  if (facts.referrer === null) return 'UNKNOWN_CODE';
  if (facts.referrer.id === facts.referee.id) return 'OWN_CODE';
  if (facts.referrer.isBlocked) return 'REFERRER_BLOCKED';
  if (facts.referee.alreadyReferred) return 'ALREADY_REFERRED';
  if (facts.referee.completedOrderCount > 0) return 'NOT_A_NEW_CUSTOMER';
  return null;
}

/** One sentence per refusal, compile-enforced over every branch. */
export const REFUSAL_TEXT: Readonly<Record<AttributionRefusal, string>> = {
  PROGRAMME_OFF: 'Invites are not running at the moment.',
  UNKNOWN_CODE: 'That invite code does not match anybody.',
  OWN_CODE: 'That is your own invite code.',
  ALREADY_REFERRED: 'This account already used an invite code.',
  NOT_A_NEW_CUSTOMER:
    'Invite codes are for new customers, and this account has ordered before.',
  REFERRER_BLOCKED: 'That invite code is not usable.',
};

// --- Paying the referrer -----------------------------------------------------

/** Why a referrer was not paid for a referral that was attributed. */
export type RewardRefusal =
  | 'PROGRAMME_OFF'
  | 'ORDER_TOO_SMALL'
  | 'MONTHLY_CAP_REACHED'
  | 'LIFETIME_CAP_REACHED'
  | 'REFERRER_BLOCKED'
  | 'NOTHING_TO_PAY';

export interface RewardFacts {
  programme: ProgrammeFacts;
  /** What the referee's qualifying order was worth, before credits. */
  orderCentavos: number;
  /** Referrals this referrer has already been PAID for, this month and ever. */
  rewardedThisMonth: number;
  rewardedEver: number;
  referrerIsBlocked: boolean;
}

export interface RewardDecision {
  payCentavos: number;
  refusal: RewardRefusal | null;
}

/**
 * What the referrer gets, or why nothing.
 *
 * The order value tested is the order's own worth, NOT what the customer paid
 * after credits. Otherwise a referee could spend their referral credits to
 * drop a ₱250 order under a ₱200 minimum and cost their referrer the reward —
 * a customer's discount is not evidence about the order's size.
 *
 * Caps count referrals PAID, not attributed. An enthusiast whose ten friends
 * all signed up and none ordered has been paid for none of them, and should not
 * be out of allowance because of other people's inaction.
 */
export function rewardForReferral(facts: RewardFacts): RewardDecision {
  const nothing = (refusal: RewardRefusal): RewardDecision => ({
    payCentavos: 0,
    refusal,
  });

  if (!programmeIsLive(facts.programme)) return nothing('PROGRAMME_OFF');
  if (facts.referrerIsBlocked) return nothing('REFERRER_BLOCKED');
  if (facts.programme.referrerCentavos <= 0) return nothing('NOTHING_TO_PAY');
  if (facts.orderCentavos < facts.programme.minimumOrderCentavos) {
    return nothing('ORDER_TOO_SMALL');
  }
  if (facts.rewardedThisMonth >= facts.programme.monthlyRewardCap) {
    return nothing('MONTHLY_CAP_REACHED');
  }
  if (facts.rewardedEver >= facts.programme.lifetimeRewardCap) {
    return nothing('LIFETIME_CAP_REACHED');
  }

  return {
    payCentavos: Math.min(facts.programme.referrerCentavos, MAX_REWARD_CENTAVOS),
    refusal: null,
  };
}

/** One sentence per reward refusal, for the referrer's own screen. */
export const REWARD_REFUSAL_TEXT: Readonly<Record<RewardRefusal, string>> = {
  PROGRAMME_OFF: 'Invites were not running when their order finished.',
  ORDER_TOO_SMALL: 'Their first order was below the minimum for a reward.',
  MONTHLY_CAP_REACHED: 'You had already earned the most for one month.',
  LIFETIME_CAP_REACHED: 'You have earned the most invites can pay.',
  REFERRER_BLOCKED: 'This account cannot earn invite rewards.',
  NOTHING_TO_PAY: 'Invites do not pay the inviter at the moment.',
};

// --- The arithmetic an operator needs ----------------------------------------

export interface FarmerMargin {
  /** Both sides of one referral, which one person can collect from themselves. */
  bothSidesCentavos: number;
  /**
   * What they must spend to collect it: the minimum qualifying order, less the
   * referee credits they can put towards it.
   */
  outlayCentavos: number;
  /** Positive means farming PAYS. This is the number that matters. */
  netCentavos: number;
  /** True when a person can profit by referring themselves. */
  farmingPays: boolean;
}

/**
 * What one person nets by referring themselves once.
 *
 * This exists because the amounts are the operator's decision and its
 * consequence is not obvious. Somebody choosing ₱50/₱50 against a ₱200 minimum
 * is fine: they collect ₱100 of credits but had to buy ₱200 of food, so they
 * are ₱100 down in cash and hold ₱100 they can only spend on more food.
 * Somebody choosing ₱150/₱150 against no minimum has built a machine.
 *
 * The outlay counts the referee credits as usable against the qualifying order,
 * because they are — that is what they are for. Which is exactly why a
 * generous referee reward and a low minimum are the dangerous combination
 * rather than a generous referrer reward alone.
 *
 * It is an estimate and says so on the screen: it ignores the cost of a SIM,
 * the delivery fee, and the fact that credits are worth less than cash. All
 * three make farming less attractive than this number suggests, so it errs
 * towards warning.
 */
export function farmerMargin(programme: ProgrammeFacts): FarmerMargin {
  const bothSidesCentavos = programme.refereeCentavos + programme.referrerCentavos;
  const outlayCentavos = Math.max(
    0,
    programme.minimumOrderCentavos - programme.refereeCentavos,
  );
  const netCentavos = bothSidesCentavos - programme.minimumOrderCentavos;
  return {
    bothSidesCentavos,
    outlayCentavos,
    netCentavos,
    farmingPays: netCentavos > 0,
  };
}

/**
 * The most the programme can cost, per referrer, for life.
 *
 * The referee side is not in here on purpose: it is bounded by how many new
 * accounts exist, not by any cap, and pretending otherwise would understate the
 * exposure. This is the referrer-side liability, which is the part the caps
 * actually bound.
 */
export function lifetimeLiabilityPerReferrer(programme: ProgrammeFacts): number {
  return programme.referrerCentavos * programme.lifetimeRewardCap;
}
