/**
 * Store referrals: the rules, with no database and no clock.
 *
 * A shop brings a shop. Like the rider programme it pays MONEY through the
 * settlement ledger — a shop's balance is what TARA owes it for food sold, and
 * a bonus is one more line in it — and unlike either of the other two, the
 * attribution is **a person's claim**.
 *
 * ### Why there is no code
 *
 * A customer follows a link. A rider fills in an application and can type six
 * characters into it. A shop does neither: `/admin/stores` creates it, and the
 * owner is invited by phone number afterwards. There is no form a shop's owner
 * fills in at the moment their shop comes into existence, and asking them to
 * enter a code weeks later — on a screen they reach only after somebody else
 * has already created the shop — would attribute a minority of real
 * introductions and none of the ones where the introduction was a conversation
 * between two shop owners and an ops person.
 *
 * So the console records it: somebody picks the referring shop from a list,
 * with their name and a reason against it. That is the same posture as a
 * comped subscription, a recorded payout and a settlement adjustment — a claim
 * about the world rather than a state change the system observed — and it
 * carries the same obligations: an actor, a note, and an audit row.
 *
 * ### Why the threshold is earnings rather than orders
 *
 * A rider's deliveries are interchangeable units of work, so counting them is
 * fair. A shop's orders are not: twenty ₱120 orders is not a trading shop, and
 * a count-based threshold invites exactly that — a friend's shop taking twenty
 * tiny orders to unlock a bonus.
 *
 * Earnings are the honest measure, and they have two other virtues. They come
 * from the settlement ledger, which is indexed by store and is what actually
 * moved. And they are the number the shop already reads on its own payouts
 * screen — *"Earned ₱18,400 in total since you joined"* — so the threshold is
 * something a shop owner can check rather than take on trust.
 *
 * Pure: imports nothing but types.
 */

/**
 * The most one side of a store referral may be worth, in centavos.
 *
 * Mirrors `store_referral_programme_sane` in
 * `prisma/sql/store_referrals.sql`, and a test asserts they agree. ₱2,000, the
 * same number as a rider's, for the same reason: it sits above anything an
 * operator might legitimately choose, so it guards a decimal point rather than
 * setting policy.
 */
export const MAX_STORE_REWARD_CENTAVOS = 200_000;

/** The programme's shape, structurally, so a Prisma row passes straight in. */
export interface StoreProgrammeFacts {
  isActive: boolean;
  referrerCentavos: number;
  refereeCentavos: number;
  qualifyingEarningsCentavos: number;
  monthlyRewardCap: number;
  lifetimeRewardCap: number;
}

/** Nothing configured. Store referrals are off, and every read gets this. */
export const STORE_PROGRAMME_OFF: StoreProgrammeFacts = {
  isActive: false,
  referrerCentavos: 0,
  refereeCentavos: 0,
  qualifyingEarningsCentavos: 0,
  monthlyRewardCap: 0,
  lifetimeRewardCap: 0,
};

/**
 * True when the programme can actually pay somebody.
 *
 * A positive earnings threshold is required, and it is the equivalent of the
 * rider programme's "at least one delivery": zero would pay for a shop being
 * ADDED, which is something somebody does in the console for a shop that may
 * never sell anything.
 */
export function storeProgrammeIsLive(programme: StoreProgrammeFacts): boolean {
  return (
    programme.isActive &&
    programme.qualifyingEarningsCentavos >= 1 &&
    (programme.referrerCentavos > 0 || programme.refereeCentavos > 0)
  );
}

// --- Attribution -------------------------------------------------------------

/** Why an attribution was refused. Every branch named, none silent. */
export type StoreAttributionRefusal =
  /** The programme is off, or pays nothing, or asks for no earnings. */
  | 'PROGRAMME_OFF'
  /** The two shops are the same shop. */
  | 'SAME_STORE'
  /** This shop has already been attributed to somebody. */
  | 'ALREADY_ATTRIBUTED'
  /**
   * The new shop has already earned through TARA, so it was not introduced —
   * it was already trading. The analogue of `NOT_A_NEW_RIDER`, and the one
   * refusal that matters most here: without it, an administrator could
   * attribute a shop that has been on the platform for a year and pay a bonus
   * for an introduction that never happened.
   */
  | 'ALREADY_TRADING'
  /**
   * The referring shop is not visible — withdrawn, or never launched. It has
   * a settlement account and could be paid, but a shop that is not on the
   * platform did not introduce anybody to it this month, and paying one is
   * more likely to be a mistyped pick from the list than a real
   * introduction.
   */
  | 'REFERRER_WITHDRAWN';

export interface StoreAttributionFacts {
  programme: StoreProgrammeFacts;
  referrer: { storeId: string; isVisible: boolean } | null;
  referee: {
    storeId: string;
    alreadyAttributed: boolean;
    /** What this shop has already earned through TARA. Normally zero. */
    earnedCentavos: number;
  };
}

export function refusalForStoreAttribution(
  facts: StoreAttributionFacts,
): StoreAttributionRefusal | null {
  if (!storeProgrammeIsLive(facts.programme)) return 'PROGRAMME_OFF';
  if (facts.referrer === null) return 'SAME_STORE';
  if (facts.referrer.storeId === facts.referee.storeId) return 'SAME_STORE';
  if (!facts.referrer.isVisible) return 'REFERRER_WITHDRAWN';
  if (facts.referee.alreadyAttributed) return 'ALREADY_ATTRIBUTED';
  if (facts.referee.earnedCentavos > 0) return 'ALREADY_TRADING';
  return null;
}

/** One sentence per refusal, compile-enforced over every branch. */
export const STORE_REFUSAL_TEXT: Readonly<
  Record<StoreAttributionRefusal, string>
> = {
  PROGRAMME_OFF: 'Shop referrals are not running at the moment.',
  SAME_STORE: 'A shop cannot have introduced itself.',
  ALREADY_ATTRIBUTED: 'Another shop is already recorded as having brought this one.',
  ALREADY_TRADING:
    'This shop has already earned through TARA, so it was trading before ' +
    'anybody introduced it. Referrals are for shops that are new.',
  REFERRER_WITHDRAWN:
    'That shop is not visible on TARA, so it cannot be credited with an ' +
    'introduction. Make it visible first if this is right.',
};

// --- Qualifying --------------------------------------------------------------

/** Whether the introduced shop has traded enough to earn the bonus. */
export function hasStoreQualified(
  earnedCentavos: number,
  programme: StoreProgrammeFacts,
): boolean {
  return (
    storeProgrammeIsLive(programme) &&
    earnedCentavos >= programme.qualifyingEarningsCentavos
  );
}

/**
 * How much more the new shop has to earn. Zero once it has qualified.
 *
 * For the shop's own screen, where it sits next to the total they have already
 * earned — so "₱6,400 to go" is one subtraction from a number they can see
 * rather than a promise about a figure they cannot.
 */
export function earningsRemaining(
  earnedCentavos: number,
  programme: StoreProgrammeFacts,
): number {
  return Math.max(0, programme.qualifyingEarningsCentavos - earnedCentavos);
}

// --- Paying ------------------------------------------------------------------

/** Why a side of a qualified referral was not paid. */
export type StoreRewardRefusal =
  | 'PROGRAMME_OFF'
  | 'NOT_ENOUGH_EARNINGS'
  | 'MONTHLY_CAP_REACHED'
  | 'LIFETIME_CAP_REACHED'
  | 'REFERRER_WITHDRAWN'
  | 'NOTHING_TO_PAY';

export interface StoreRewardFacts {
  programme: StoreProgrammeFacts;
  /** What the introduced shop has earned now. */
  earnedCentavos: number;
  /** Referrals this shop has been PAID for, this month and ever. */
  rewardedThisMonth: number;
  rewardedEver: number;
  referrerIsVisible: boolean;
}

export interface StoreRewardDecision {
  referrerCentavos: number;
  refereeCentavos: number;
  referrerRefusal: StoreRewardRefusal | null;
  refereeRefusal: StoreRewardRefusal | null;
}

/**
 * What each shop gets, or why nothing.
 *
 * The two sides are decided SEPARATELY, exactly as in the rider programme and
 * for the same reason: a cap belongs to the shop that did the introducing, and
 * refusing a new shop the bonus it was promised — after it has sold the food
 * that earned it — because of something another shop's owner did is a promise
 * broken by somebody they have never met.
 *
 * The programme being off refuses both, because then there was no promise.
 *
 * `REFERRER_WITHDRAWN` refuses only the referrer, and it is the one refusal
 * here with no rider equivalent: a shop can leave the platform between the
 * introduction and the qualification. We still owe it the bonus in principle —
 * the introduction happened — but a payout to a shop that has withdrawn is a
 * transfer to somebody who has stopped trading, and that is a decision for a
 * person rather than a cron. The reason is recorded, so somebody can make it.
 */
export function rewardForStoreReferral(
  facts: StoreRewardFacts,
): StoreRewardDecision {
  const both = (refusal: StoreRewardRefusal): StoreRewardDecision => ({
    referrerCentavos: 0,
    refereeCentavos: 0,
    referrerRefusal: refusal,
    refereeRefusal: refusal,
  });

  if (!storeProgrammeIsLive(facts.programme)) return both('PROGRAMME_OFF');
  if (facts.earnedCentavos < facts.programme.qualifyingEarningsCentavos) {
    return both('NOT_ENOUGH_EARNINGS');
  }

  const capped = (amount: number): number =>
    Math.min(amount, MAX_STORE_REWARD_CENTAVOS);

  const refereeCentavos = capped(facts.programme.refereeCentavos);
  const refereeRefusal: StoreRewardRefusal | null =
    refereeCentavos > 0 ? null : 'NOTHING_TO_PAY';

  const referrerSide = (): { pay: number; refusal: StoreRewardRefusal | null } => {
    if (!facts.referrerIsVisible) {
      return { pay: 0, refusal: 'REFERRER_WITHDRAWN' };
    }
    if (facts.programme.referrerCentavos <= 0) {
      return { pay: 0, refusal: 'NOTHING_TO_PAY' };
    }
    if (facts.rewardedThisMonth >= facts.programme.monthlyRewardCap) {
      return { pay: 0, refusal: 'MONTHLY_CAP_REACHED' };
    }
    if (facts.rewardedEver >= facts.programme.lifetimeRewardCap) {
      return { pay: 0, refusal: 'LIFETIME_CAP_REACHED' };
    }
    return { pay: capped(facts.programme.referrerCentavos), refusal: null };
  };

  const referrer = referrerSide();

  return {
    referrerCentavos: referrer.pay,
    refereeCentavos,
    referrerRefusal: referrer.refusal,
    refereeRefusal,
  };
}

/** True when a decision moves no money at all, and the row is terminal. */
export function storePaysNothing(decision: StoreRewardDecision): boolean {
  return decision.referrerCentavos === 0 && decision.refereeCentavos === 0;
}

/** One sentence per reward refusal, for the shop's own screen. */
export const STORE_REWARD_REFUSAL_TEXT: Readonly<
  Record<StoreRewardRefusal, string>
> = {
  PROGRAMME_OFF: 'Shop referrals were not running when they qualified.',
  NOT_ENOUGH_EARNINGS: 'They have not earned enough through TARA yet.',
  MONTHLY_CAP_REACHED: 'You had already earned the most for one month.',
  LIFETIME_CAP_REACHED: 'You have earned the most shop referrals can pay.',
  REFERRER_WITHDRAWN:
    'This shop was not visible on TARA when the introduction qualified.',
  NOTHING_TO_PAY: 'Shop referrals do not pay that side at the moment.',
};

// --- The arithmetic an operator needs ----------------------------------------

export interface StoreAcquisitionCost {
  /** Both sides of one referral: what a shop acquired this way costs. */
  bothSidesCentavos: number;
  /** What the introduced shop must have earned before it is owed. */
  qualifyingEarningsCentavos: number;
  /**
   * The bonus as basis points of those earnings — the number to read against
   * the shop's own commission rate. 250 basis points is 2.5%.
   */
  costBasisPointsOfEarnings: number;
  /** The most the programme can owe one shop, ever. */
  lifetimeLiabilityPerReferrerCentavos: number;
}

/**
 * What a shop acquired through a referral costs, in the same units as
 * commission.
 *
 * The rider programme's figure is cost per delivery, because a delivery is
 * what a rider produces. A shop produces FOOD SOLD, and what TARA takes from
 * it is a commission in basis points — so expressing the bonus the same way
 * makes the comparison an operator needs a subtraction rather than a
 * calculation:
 *
 *     a ₱750 bonus against a ₱20,000 earnings threshold is 375 basis points
 *
 * If that number is above the shop's commission rate, the programme spends
 * more acquiring the shop than the threshold earns back, and the shop has to
 * keep trading past the threshold before it is worth anything. That is a
 * legitimate thing to choose — most acquisition is bought forward — but it
 * should be chosen rather than discovered.
 *
 * Rounds UP, so it never understates what is being spent.
 */
export function storeAcquisitionCost(
  programme: StoreProgrammeFacts,
): StoreAcquisitionCost {
  const bothSidesCentavos =
    programme.referrerCentavos + programme.refereeCentavos;
  const threshold = Math.max(0, programme.qualifyingEarningsCentavos);

  return {
    bothSidesCentavos,
    qualifyingEarningsCentavos: threshold,
    costBasisPointsOfEarnings:
      threshold > 0 ? Math.ceil((bothSidesCentavos * 10_000) / threshold) : 0,
    // The referee side is bounded by how many new shops exist rather than by
    // any cap, so it is deliberately not in here — the same choice the other
    // two programmes make.
    lifetimeLiabilityPerReferrerCentavos:
      programme.referrerCentavos * programme.lifetimeRewardCap,
  };
}
