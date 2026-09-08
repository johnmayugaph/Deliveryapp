/**
 * Loyalty points: the rules, with no database and no clock.
 *
 * ### Why points exist when credits already do
 *
 * This app already grants credits, and a credit-back benefit already exists —
 * so a points programme could easily be a second currency that does the first
 * one's job with more steps. Two things stop that being what this is.
 *
 * **Credits measure what you can spend; points measure what you have ordered.**
 * A peso balance cannot express "you are two orders from Tapat", and a status
 * band cannot be paid out. That is the distinction the second ledger earns.
 *
 * **And credit-back is a Plus benefit.** Plus is priced but cannot be sold,
 * because a subscription needs a recurring charge and a transfer somebody makes
 * by hand is not one. So today a loyal customer who is not paying earns
 * nothing at all for ordering every week. Points fill exactly that gap, and
 * need no payment rail to do it.
 *
 * ### Points are not spendable
 *
 * The decision that keeps this from confusing everybody: points buy credits,
 * and credits buy food. There is exactly one balance a customer can spend, and
 * it is the one that was already there. Points are a thing you convert, not a
 * second wallet to reason about at the checkout.
 *
 * ### What a tier changes, and what it must not
 *
 * A tier changes the earn rate. Nothing else.
 *
 * The temptation is to make Tapat waive delivery, and it is worth naming why
 * not: this app already has three ways to reduce a bill — the fee rule's own
 * free-delivery threshold, Plus benefits, and promo discounts — and each of
 * them interacts with the others inside `applyBenefits`. A fourth would need
 * to interact with all three, and would put loyalty arithmetic in the checkout
 * path where a bug costs somebody the wrong price. A tier that earns faster
 * compounds the thing the programme is for and touches nothing near a bill.
 *
 * Pure: imports nothing but types.
 */

/** Basis points, so `10000` is 1.0 and the arithmetic stays in integers. */
const BASIS = 10_000;

/**
 * The most points one peso may earn, in basis points.
 *
 * Mirrors `loyalty_programme_sane` in `prisma/sql/loyalty.sql`; a test asserts
 * they agree. A hundred points per peso is a decimal point in the wrong place,
 * and one that multiplies across every order on the platform at once.
 */
export const MAX_POINTS_PER_PESO_BASIS_POINTS = 1_000_000;

export interface ProgrammeFacts {
  isActive: boolean;
  pointsPerPesoBasisPoints: number;
  pointsPerPesoRedeemed: number;
  redemptionBlockPoints: number;
  expiryMonths: number;
  tierWindowMonths: number;
}

/** Nothing configured. Every read gets this, and nothing earns. */
export const PROGRAMME_OFF: ProgrammeFacts = {
  isActive: false,
  pointsPerPesoBasisPoints: 0,
  pointsPerPesoRedeemed: 0,
  redemptionBlockPoints: 0,
  expiryMonths: 0,
  tierWindowMonths: 12,
};

/**
 * True when the programme can both earn and pay out.
 *
 * Active is not enough. A programme with a zero earn rate shows a balance that
 * can never grow; one with a zero redemption rate shows a balance that can
 * never be spent. Both are worse than telling somebody points are not running.
 */
export function programmeIsLive(programme: ProgrammeFacts): boolean {
  return (
    programme.isActive &&
    programme.pointsPerPesoBasisPoints > 0 &&
    programme.pointsPerPesoRedeemed > 0 &&
    programme.redemptionBlockPoints > 0
  );
}

// --- Tiers -------------------------------------------------------------------

export interface TierFacts {
  id: string;
  name: string;
  thresholdPoints: number;
  earnMultiplierBasisPoints: number;
  blurb: string;
}

/**
 * The tier a points total has reached, and the next one up.
 *
 * The total is points EARNED inside the rolling window, not the current
 * balance. Spending your points must not demote you: a customer who redeems is
 * doing the thing the programme wants, and a tier that punished it would teach
 * people to hoard.
 *
 * `null` for the current tier means no ladder is configured, which is not an
 * error — a programme can earn points without any status attached.
 */
export function tierFor(
  tiers: readonly TierFacts[],
  earnedInWindow: number,
): { current: TierFacts | null; next: TierFacts | null; pointsToNext: number } {
  const ladder = [...tiers].sort((a, b) => a.thresholdPoints - b.thresholdPoints);

  let current: TierFacts | null = null;
  let next: TierFacts | null = null;
  for (const tier of ladder) {
    if (earnedInWindow >= tier.thresholdPoints) {
      current = tier;
    } else {
      next = tier;
      break;
    }
  }

  return {
    current,
    next,
    pointsToNext: next === null ? 0 : Math.max(0, next.thresholdPoints - earnedInWindow),
  };
}

/** A tier's multiplier, or 1.0 when there is no tier. */
export function multiplierFor(tier: TierFacts | null): number {
  return (tier?.earnMultiplierBasisPoints ?? BASIS) / BASIS;
}

// --- Earning -----------------------------------------------------------------

/** The order fields earning looks at. Structural, so a Prisma row passes in. */
export interface EarningFacts {
  subtotalCentavos: number;
}

/**
 * Points earned by an order.
 *
 * **On the subtotal only.** Not the delivery fee, not surge, not the tip —
 * those are the rider's money, and rewarding a customer in proportion to what
 * we paid somebody else is both odd and gameable: a distant address would earn
 * more than a near one for the same food. The subtotal is also what a customer
 * means when they say what they spent.
 *
 * Rounded DOWN. A customer who is short of a point never notices; one who was
 * given a point they had not earned makes the balance disagree with the rule
 * that produced it, and rounding up across a million orders is a real cost
 * nobody chose.
 */
export function pointsForOrder(
  programme: ProgrammeFacts,
  order: EarningFacts,
  tier: TierFacts | null,
): number {
  if (!programmeIsLive(programme)) return 0;
  if (order.subtotalCentavos <= 0) return 0;

  const pesos = Math.floor(order.subtotalCentavos / 100);
  const base = (pesos * programme.pointsPerPesoBasisPoints) / BASIS;
  return Math.floor(base * multiplierFor(tier));
}

/** When points earned now would expire, or null when they never do. */
export function expiryFor(programme: ProgrammeFacts, earnedAt: Date): Date | null {
  if (programme.expiryMonths <= 0) return null;
  const expires = new Date(earnedAt.getTime());
  expires.setUTCMonth(expires.getUTCMonth() + programme.expiryMonths);
  return expires;
}

/** The start of the rolling window a tier is calculated over. */
export function tierWindowStart(programme: ProgrammeFacts, now: Date): Date {
  const start = new Date(now.getTime());
  start.setUTCMonth(start.getUTCMonth() - Math.max(1, programme.tierWindowMonths));
  return start;
}

// --- Redeeming ---------------------------------------------------------------

/** Why a redemption was refused. Every branch named. */
export type RedemptionRefusal =
  | 'PROGRAMME_OFF'
  | 'NOT_ENOUGH_POINTS'
  | 'NOT_A_WHOLE_BLOCK'
  | 'NOTHING_REQUESTED';

export interface RedemptionQuote {
  /** Points that would be taken. Always a whole number of blocks. */
  pointsSpent: number;
  /** Credits that would be granted, in centavos. */
  centavosGranted: number;
  refusal: RedemptionRefusal | null;
}

/**
 * What redeeming a number of points would do.
 *
 * **Whole blocks only.** Without them a customer with 1,437 points at 100
 * points to the peso redeems ₱14.37 and is left holding 37 points that will
 * never be worth a centavo — dust, which every loyalty programme accumulates
 * and nobody enjoys. Blocks make every redemption a round number of pesos and
 * leave a remainder that is still worth something once it grows.
 *
 * The refusal is explicit rather than a silent floor: somebody who asks to
 * redeem 700 of a 500-point block should be told it will be 500, not quietly
 * given 500 and left wondering where the rest went.
 */
export function quoteRedemption(
  programme: ProgrammeFacts,
  input: { pointsRequested: number; pointsAvailable: number },
): RedemptionQuote {
  const nothing = (refusal: RedemptionRefusal): RedemptionQuote => ({
    pointsSpent: 0,
    centavosGranted: 0,
    refusal,
  });

  if (!programmeIsLive(programme)) return nothing('PROGRAMME_OFF');
  if (input.pointsRequested <= 0) return nothing('NOTHING_REQUESTED');
  if (input.pointsRequested % programme.redemptionBlockPoints !== 0) {
    return nothing('NOT_A_WHOLE_BLOCK');
  }
  if (input.pointsRequested > input.pointsAvailable) {
    return nothing('NOT_ENOUGH_POINTS');
  }

  // Integer arithmetic throughout: pesos first, then centavos, so a rate that
  // does not divide evenly cannot produce a fraction of a centavo.
  const pesos = input.pointsRequested / programme.pointsPerPesoRedeemed;
  return {
    pointsSpent: input.pointsRequested,
    centavosGranted: Math.floor(pesos * 100),
    refusal: null,
  };
}

/**
 * The largest whole-block redemption a balance allows.
 *
 * What the screen offers, so the customer taps once rather than working out
 * the arithmetic of their own balance.
 */
export function largestRedemption(
  programme: ProgrammeFacts,
  pointsAvailable: number,
): RedemptionQuote {
  if (!programmeIsLive(programme)) {
    return { pointsSpent: 0, centavosGranted: 0, refusal: 'PROGRAMME_OFF' };
  }
  const blocks = Math.floor(pointsAvailable / programme.redemptionBlockPoints);
  if (blocks < 1) {
    return { pointsSpent: 0, centavosGranted: 0, refusal: 'NOT_ENOUGH_POINTS' };
  }
  return quoteRedemption(programme, {
    pointsRequested: blocks * programme.redemptionBlockPoints,
    pointsAvailable,
  });
}

/** One sentence per refusal, compile-enforced over every branch. */
export const REDEMPTION_REFUSAL_TEXT: Readonly<
  Record<RedemptionRefusal, string>
> = {
  PROGRAMME_OFF: 'Points are not running at the moment.',
  NOT_ENOUGH_POINTS: 'You do not have that many points.',
  NOT_A_WHOLE_BLOCK: 'Points are redeemed in whole blocks.',
  NOTHING_REQUESTED: 'Choose how many points to redeem.',
};

/** What a points balance is worth in centavos, for showing beside it. */
export function pointsValueCentavos(
  programme: ProgrammeFacts,
  points: number,
): number {
  if (!programmeIsLive(programme) || points <= 0) return 0;
  return Math.floor((points / programme.pointsPerPesoRedeemed) * 100);
}

// --- What the programme costs -------------------------------------------------

/**
 * The peso liability outstanding points represent.
 *
 * For the console. A points programme is an obligation denominated in
 * somebody else's money, and the number that matters is not how many points
 * exist but what they would cost if everybody redeemed tomorrow. Shown next to
 * the expiry setting, because those two facts belong together: with no expiry
 * this figure only ever goes up.
 */
export function outstandingLiabilityCentavos(
  programme: ProgrammeFacts,
  pointsOutstanding: number,
): number {
  return pointsValueCentavos(programme, pointsOutstanding);
}

/**
 * What one peso of spend earns back, as a percentage in basis points.
 *
 * The number an operator actually needs and would otherwise have to derive
 * from two rates pointing in opposite directions: earn is points per peso,
 * redemption is points per peso, and the effective giveback is their ratio.
 * Getting this wrong by a factor of ten is easy and expensive.
 */
export function effectiveGivebackBasisPoints(programme: ProgrammeFacts): number {
  if (!programmeIsLive(programme)) return 0;
  const pointsPerPeso = programme.pointsPerPesoBasisPoints / BASIS;
  return Math.round((pointsPerPeso / programme.pointsPerPesoRedeemed) * BASIS);
}
