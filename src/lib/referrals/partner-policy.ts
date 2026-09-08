/**
 * Partner referrals: the rules, with no database and no clock.
 *
 * A rider brings a rider. The customer programme next door pays credits; this
 * one pays MONEY, accrued to what TARA owes each side and paid out in the
 * payout somebody records on a Friday. That single difference changes almost
 * every rule, so this is a second policy module rather than a flag on the
 * first one.
 *
 * ### Why credits could not serve here
 *
 * A rider does not order lunch from us. Paying a supply referral in credits
 * would be paying somebody in a currency they cannot use — which is worse than
 * not paying them, because it looks like a reward and is not one. Money is the
 * only honest answer, and the settlement ledger already moves money to
 * partners and records who moved it. So a partner referral is a
 * `REFERRAL_BONUS` accrual on that ledger and nothing new at all.
 *
 * ### What stops this being farmed, and why it is not the caps
 *
 * The customer programme's defence is arithmetic: credits cannot be cashed
 * out, a qualifying order costs real money, and the caps bound the liability.
 * Here the defence is **the work**.
 *
 * To collect a partner bonus from yourself you would have to register a second
 * rider account, pass verification a second time — a person looks at
 * documents, per service — and then complete `qualifyingDeliveries` real
 * deliveries on it: real orders, to real customers, each of which already paid
 * that account its own fee. At the end of it you have delivered food and been
 * paid for delivering food. That is not a farm; it is a second job with a
 * hiring bonus, and the bonus is what it was for.
 *
 * Which means the number an operator needs here is NOT `farmerMargin` — there
 * is no margin to compute, because the "attack" is indistinguishable from
 * working. It is **what a rider costs to acquire**, and whether that is worth
 * paying against what a rider earns us. `acquisitionCost` below puts that on
 * their screen instead.
 *
 * Pure: imports nothing but types.
 */

/**
 * The most one side of a partner referral may be worth, in centavos.
 *
 * Mirrors `partner_referral_programme_sane` in
 * `prisma/sql/partner_referrals.sql`, and a test asserts they agree.
 *
 * ₱2,000, against the customer programme's ₱500. A rider is worth far more to
 * a delivery business than a customer — supply is the constraint, not demand —
 * so the ceiling has to sit above anything an operator might legitimately
 * choose or it becomes a policy rather than a typo guard. It is still a typo
 * guard: a bonus above this is a decimal point in the wrong place, and here
 * that decimal point is in a real payout.
 */
export const MAX_PARTNER_REWARD_CENTAVOS = 200_000;

/** The programme's shape, structurally, so a Prisma row passes straight in. */
export interface PartnerProgrammeFacts {
  isActive: boolean;
  referrerCentavos: number;
  refereeCentavos: number;
  qualifyingDeliveries: number;
  monthlyRewardCap: number;
  lifetimeRewardCap: number;
}

/** Nothing configured. Partner referrals are off, and every read gets this. */
export const PARTNER_PROGRAMME_OFF: PartnerProgrammeFacts = {
  isActive: false,
  referrerCentavos: 0,
  refereeCentavos: 0,
  qualifyingDeliveries: 0,
  monthlyRewardCap: 0,
  lifetimeRewardCap: 0,
};

/**
 * True when the programme can actually pay somebody.
 *
 * Active is not enough, and neither is an amount. A programme with amounts and
 * `qualifyingDeliveries` at zero would pay for registering an account, which
 * is paying for owning a SIM card — the exact thing the customer programme
 * refuses to do by never paying the referrer at signup. So a live programme
 * must require at least one delivery.
 */
export function partnerProgrammeIsLive(
  programme: PartnerProgrammeFacts,
): boolean {
  return (
    programme.isActive &&
    programme.qualifyingDeliveries >= 1 &&
    (programme.referrerCentavos > 0 || programme.refereeCentavos > 0)
  );
}

// --- Attribution -------------------------------------------------------------

/** Why an attribution was refused. Every branch named, none silent. */
export type PartnerAttributionRefusal =
  /** The programme is off, or pays nothing, or asks for no deliveries. */
  | 'PROGRAMME_OFF'
  /** The code does not match any account. */
  | 'UNKNOWN_CODE'
  /** They typed their own code. */
  | 'OWN_CODE'
  /**
   * The code belongs to somebody who is not a rider. A customer who brings a
   * rider is a real thing and this is not it: there is no settlement account to
   * accrue a bonus to, and paying them in credits instead would be a third
   * rail with a different fraud shape. Their own code still earns credits when
   * somebody ORDERS with it, which is what it is for.
   */
  | 'NOT_A_RIDER_CODE'
  /** This applicant already used a code. */
  | 'ALREADY_REFERRED'
  /**
   * Not a new rider: they have delivered before. A referral pays for bringing
   * somebody who was not here, and an existing rider adding a second service
   * cannot be introduced by anybody.
   */
  | 'NOT_A_NEW_RIDER'
  /** The referrer's account is blocked. */
  | 'REFERRER_BLOCKED'
  /** The referrer is suspended from all work. */
  | 'REFERRER_SUSPENDED';

export interface PartnerAttributionFacts {
  programme: PartnerProgrammeFacts;
  /**
   * The rider who owns the code, or null when no code matched or the code's
   * owner is not a fleet partner — the two are distinguished by
   * `codeOwnerExists`, so the refusal can say which.
   */
  referrer: {
    fleetPartnerId: string;
    userId: string;
    isBlocked: boolean;
    isSuspended: boolean;
  } | null;
  /** True when the code resolved to an account that simply is not a rider. */
  codeOwnerExists: boolean;
  referee: {
    userId: string;
    alreadyReferred: boolean;
    /** Completed deliveries this applicant already has. Normally zero. */
    completedDeliveryCount: number;
  };
}

export function refusalForPartnerAttribution(
  facts: PartnerAttributionFacts,
): PartnerAttributionRefusal | null {
  if (!partnerProgrammeIsLive(facts.programme)) return 'PROGRAMME_OFF';
  if (facts.referrer === null) {
    return facts.codeOwnerExists ? 'NOT_A_RIDER_CODE' : 'UNKNOWN_CODE';
  }
  if (facts.referrer.userId === facts.referee.userId) return 'OWN_CODE';
  if (facts.referrer.isBlocked) return 'REFERRER_BLOCKED';
  if (facts.referrer.isSuspended) return 'REFERRER_SUSPENDED';
  if (facts.referee.alreadyReferred) return 'ALREADY_REFERRED';
  if (facts.referee.completedDeliveryCount > 0) return 'NOT_A_NEW_RIDER';
  return null;
}

/**
 * One sentence per refusal, compile-enforced over every branch.
 *
 * The two referrer-state refusals read almost identically on purpose: an
 * applicant typing a stranger's code should not learn from the wording that
 * the account is blocked rather than suspended. They stay separate branches so
 * an operator can count them, which is where knowing the difference is useful.
 */
export const PARTNER_REFUSAL_TEXT: Readonly<
  Record<PartnerAttributionRefusal, string>
> = {
  PROGRAMME_OFF: 'Rider invites are not running at the moment.',
  UNKNOWN_CODE: 'That invite code does not match anybody.',
  OWN_CODE: 'That is your own invite code.',
  NOT_A_RIDER_CODE:
    'That code belongs to a customer rather than a rider, so it earns no rider bonus.',
  ALREADY_REFERRED: 'This application already used an invite code.',
  NOT_A_NEW_RIDER:
    'Rider invites are for new riders, and this account has delivered before.',
  REFERRER_BLOCKED: 'That invite code is not usable.',
  REFERRER_SUSPENDED: 'That invite code is not usable at the moment.',
};

// --- Qualifying --------------------------------------------------------------

/** Whether an invited rider has done enough to earn the bonus. */
export function hasQualified(
  completedDeliveries: number,
  programme: PartnerProgrammeFacts,
): boolean {
  return (
    partnerProgrammeIsLive(programme) &&
    completedDeliveries >= programme.qualifyingDeliveries
  );
}

/**
 * How many more deliveries before it pays. Zero once it has qualified.
 *
 * For the rider's own screen, which is the only place this matters: "3 more
 * and Ana gets her bonus" is something somebody can act on, and "not yet" is
 * not.
 */
export function deliveriesRemaining(
  completedDeliveries: number,
  programme: PartnerProgrammeFacts,
): number {
  return Math.max(0, programme.qualifyingDeliveries - completedDeliveries);
}

// --- Paying ------------------------------------------------------------------

/** Why a side of a qualified referral was not paid. */
export type PartnerRewardRefusal =
  | 'PROGRAMME_OFF'
  | 'NOT_ENOUGH_DELIVERIES'
  | 'MONTHLY_CAP_REACHED'
  | 'LIFETIME_CAP_REACHED'
  | 'REFERRER_BLOCKED'
  | 'REFERRER_SUSPENDED'
  | 'NOTHING_TO_PAY';

export interface PartnerRewardFacts {
  programme: PartnerProgrammeFacts;
  /** Completed deliveries the invited rider has now. */
  completedDeliveries: number;
  /** Referrals this referrer has been PAID for, this month and ever. */
  rewardedThisMonth: number;
  rewardedEver: number;
  referrerIsBlocked: boolean;
  referrerIsSuspended: boolean;
}

export interface PartnerRewardDecision {
  referrerCentavos: number;
  refereeCentavos: number;
  /** Why the referrer was not paid, when they were not. */
  referrerRefusal: PartnerRewardRefusal | null;
  /** Why the invited rider was not paid. */
  refereeRefusal: PartnerRewardRefusal | null;
}

/**
 * What each side gets, or why nothing.
 *
 * ### The two sides are decided SEPARATELY, and that is the whole design
 *
 * A cap belongs to the referrer. If hitting it refused the whole referral, an
 * invited rider who was told "₱500 after twenty deliveries", and who then
 * delivered twenty times, would be paid nothing because of something a
 * different person did — invisible to them, unexplainable by them, and not
 * their fault. So the caps refuse the REFERRER side only, and the invited
 * rider is paid for the work they were promised payment for.
 *
 * The programme being off refuses both, because then there is no promise.
 *
 * Blocked and suspended likewise refuse only the referrer. A rider suspended
 * for a bad reason should not also cost their invitee a bonus.
 *
 * Caps count referrals PAID, not attributed: a rider whose ten friends applied
 * and never delivered has been paid for none of them and should not be out of
 * allowance because of other people's inaction.
 */
export function rewardForPartnerReferral(
  facts: PartnerRewardFacts,
): PartnerRewardDecision {
  const both = (refusal: PartnerRewardRefusal): PartnerRewardDecision => ({
    referrerCentavos: 0,
    refereeCentavos: 0,
    referrerRefusal: refusal,
    refereeRefusal: refusal,
  });

  if (!partnerProgrammeIsLive(facts.programme)) return both('PROGRAMME_OFF');
  if (facts.completedDeliveries < facts.programme.qualifyingDeliveries) {
    return both('NOT_ENOUGH_DELIVERIES');
  }

  const capped = (amount: number): number =>
    Math.min(amount, MAX_PARTNER_REWARD_CENTAVOS);

  // The referee side: the programme either pays it or it does not.
  const refereeCentavos = capped(facts.programme.refereeCentavos);
  const refereeRefusal: PartnerRewardRefusal | null =
    refereeCentavos > 0 ? null : 'NOTHING_TO_PAY';

  // The referrer side, which is the one anything else can refuse.
  const referrerSide = (): { pay: number; refusal: PartnerRewardRefusal | null } => {
    if (facts.referrerIsBlocked) return { pay: 0, refusal: 'REFERRER_BLOCKED' };
    if (facts.referrerIsSuspended) {
      return { pay: 0, refusal: 'REFERRER_SUSPENDED' };
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
export function paysNothing(decision: PartnerRewardDecision): boolean {
  return decision.referrerCentavos === 0 && decision.refereeCentavos === 0;
}

/** One sentence per reward refusal, for the rider's own screen. */
export const PARTNER_REWARD_REFUSAL_TEXT: Readonly<
  Record<PartnerRewardRefusal, string>
> = {
  PROGRAMME_OFF: 'Rider invites were not running when they qualified.',
  NOT_ENOUGH_DELIVERIES: 'They have not completed enough deliveries yet.',
  MONTHLY_CAP_REACHED: 'You had already earned the most for one month.',
  LIFETIME_CAP_REACHED: 'You have earned the most rider invites can pay.',
  REFERRER_BLOCKED: 'This account cannot earn invite bonuses.',
  REFERRER_SUSPENDED: 'Invite bonuses are paused while an account is suspended.',
  NOTHING_TO_PAY: 'Rider invites do not pay that side at the moment.',
};

// --- The arithmetic an operator needs ----------------------------------------

export interface AcquisitionCost {
  /** Both sides of one referral: what a rider acquired this way costs. */
  bothSidesCentavos: number;
  /** How many deliveries that rider must make before it is owed. */
  qualifyingDeliveries: number;
  /**
   * The cost spread over the deliveries that earn it. Compare it to what a
   * delivery earns the business: above that, the programme loses money on
   * every rider who quits the day they qualify.
   */
  perQualifyingDeliveryCentavos: number;
  /** The most the programme can owe one referrer, ever. */
  lifetimeLiabilityPerReferrerCentavos: number;
}

/**
 * What a rider acquired through an invite costs, and over how much work.
 *
 * This replaces `farmerMargin`, and the replacement is the point. On the
 * customer programme the danger is a person profiting from themselves, so the
 * number to show is their margin. Here there is no margin to compute: the only
 * way to collect is to deliver, and somebody who registers a second account
 * and completes twenty deliveries has done twenty deliveries. The exposure is
 * not fraud, it is **spending more to hire a rider than the rider earns us**,
 * and the per-delivery figure is what makes that comparable to a number an
 * operator already knows.
 *
 * `perQualifyingDeliveryCentavos` rounds UP, so the figure never understates
 * what is being spent.
 */
export function acquisitionCost(
  programme: PartnerProgrammeFacts,
): AcquisitionCost {
  const bothSidesCentavos =
    programme.referrerCentavos + programme.refereeCentavos;
  const deliveries = Math.max(0, programme.qualifyingDeliveries);

  return {
    bothSidesCentavos,
    qualifyingDeliveries: deliveries,
    perQualifyingDeliveryCentavos:
      deliveries > 0 ? Math.ceil(bothSidesCentavos / deliveries) : 0,
    // The referee side is bounded by how many new riders exist rather than by
    // any cap, so it is deliberately not in here — the same choice
    // `lifetimeLiabilityPerReferrer` makes, and for the same reason: including
    // it would look like a bound and would not be one.
    lifetimeLiabilityPerReferrerCentavos:
      programme.referrerCentavos * programme.lifetimeRewardCap,
  };
}
