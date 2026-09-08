import { DispatchOfferStatus } from '@prisma/client';

/**
 * The rules governing dispatch offers. Pure, so the arithmetic below is
 * testable without a database or a clock.
 */

/** How long a partner has to answer before the offer lapses. */
export const OFFER_TTL_SECONDS = 60;

/**
 * How many partners are offered one order at once.
 *
 * Not one-at-a-time: a sequential cascade with a 60-second window means a
 * customer can wait five minutes while five partners ignore their phone. Not
 * everybody either, or the ranking stops meaning anything. Three at a time,
 * refreshed as they lapse.
 */
export const OFFER_FANOUT = 3;

/**
 * Offers are only re-fanned after this long, so the cron running every minute
 * does not stack a fresh batch on top of one that is still live.
 */
export const REFANOUT_AFTER_SECONDS = 20;

/** Statuses that no longer occupy a partner's attention. */
export const CLOSED_OFFER_STATUSES: readonly DispatchOfferStatus[] = [
  DispatchOfferStatus.ACCEPTED,
  DispatchOfferStatus.DECLINED,
  DispatchOfferStatus.EXPIRED,
  DispatchOfferStatus.SUPERSEDED,
];

export interface OfferTallies {
  accepted: number;
  declined: number;
  expired: number;
  /** Somebody else got there first. Deliberately not counted either way. */
  superseded: number;
}

/**
 * Acceptance rate from an offer tally.
 *
 * SUPERSEDED offers are excluded entirely: being beaten to a job by a closer
 * partner is not a decision the partner made, and counting it would punish
 * people for working in a busy area. An expired offer DOES count — ignoring
 * your phone while online is a choice.
 *
 * A partner with no decisions yet returns null rather than 0: a brand-new
 * partner is not a 0% partner, and dispatch ranking treats the two very
 * differently.
 */
export function computeAcceptanceRate(tallies: OfferTallies): number | null {
  const decided = tallies.accepted + tallies.declined + tallies.expired;
  if (decided === 0) {
    return null;
  }
  return tallies.accepted / decided;
}

/**
 * The rate to store on `FleetPartner.acceptanceRate`, which is a non-null
 * Float. A partner with no history is given the benefit of the doubt rather
 * than a zero that would bury them at the bottom of every candidate list.
 */
export const DEFAULT_ACCEPTANCE_RATE = 1;

export function acceptanceRateForRanking(tallies: OfferTallies): number {
  return computeAcceptanceRate(tallies) ?? DEFAULT_ACCEPTANCE_RATE;
}

/** Whether a pending offer is still answerable. */
export function isOfferLive(
  offer: { status: DispatchOfferStatus; expiresAt: Date },
  now: Date = new Date(),
): boolean {
  return offer.status === DispatchOfferStatus.PENDING && offer.expiresAt.getTime() > now.getTime();
}

/** Seconds left to answer, floored at zero. */
export function offerSecondsRemaining(
  offer: { expiresAt: Date },
  now: Date = new Date(),
): number {
  return Math.max(0, Math.ceil((offer.expiresAt.getTime() - now.getTime()) / 1000));
}

/**
 * What a partner earns from an order.
 *
 * THE one definition. The fleet screens show a partner this number, dispatch
 * quotes it on an offer, and settlement accrues it — so any change to what a
 * rider is paid happens here and nowhere else. Two functions computing this is
 * how an app promises one figure and settles another.
 *
 * **The delivery fee, the surge and the whole tip.**
 *
 * The delivery fee is the order's full quoted fee even when a subscription
 * benefit waived it for the customer — that waiver is our marketing cost, not
 * a pay cut for the person doing the ride.
 *
 * **Surge belongs to the rider**, and it took a deliberate decision to say so.
 * It used to fall to the platform, not by choice but because this function did
 * not mention it and the platform takes whatever is left over. That was the
 * wrong default: surge exists to get somebody to accept a job in bad weather or
 * at 2am, and surge that reaches the platform instead of the rider is a price
 * increase with no incentive attached — the customer pays more and nobody is
 * any more willing to ride. Paying it to the rider is the only version that
 * does what the fee is named for.
 *
 * Commission comes off the SHOP's side of an order, never out of any of this.
 */
export function partnerEarningsCentavos(order: {
  deliveryFeeCentavos: number;
  tipCentavos: number;
  /**
   * Optional because most callers pass a whole `Order` and older rows predate
   * the field being meaningful. Absent reads as zero, which is what every
   * order in the database has — see `docs/architecture.md`: nothing sets surge
   * yet, so this rule governs orders that do not exist until somebody decides
   * when surge applies.
   */
  surgeCentavos?: number;
}): number {
  return (
    order.deliveryFeeCentavos + (order.surgeCentavos ?? 0) + order.tipCentavos
  );
}

/** One component of a rider's pay, for a screen that shows the make-up. */
export interface EarningsPart {
  label: string;
  centavos: number;
}

/**
 * A rider's pay, broken into the parts they can recognise.
 *
 * Only the parts that are actually there, and only worth rendering when there
 * is more than one — "₱39.00 fee" under a heading that already says ₱39.00 is
 * noise, whereas "₱39 fee + ₱15 surge + ₱20 tip" answers the question a rider
 * asks when the number is bigger than usual.
 *
 * Derived from the same fields `partnerEarningsCentavos` adds up, so the parts
 * always sum to the total. A breakdown that does not add up to the figure above
 * it is worse than no breakdown.
 */
export function earningsParts(order: {
  deliveryFeeCentavos: number;
  tipCentavos: number;
  surgeCentavos?: number;
}): EarningsPart[] {
  const parts: EarningsPart[] = [];
  if (order.deliveryFeeCentavos > 0) {
    parts.push({ label: 'fee', centavos: order.deliveryFeeCentavos });
  }
  if ((order.surgeCentavos ?? 0) > 0) {
    // Named "surge" rather than "bonus": it is the customer paying more
    // because the job is harder to fill, and calling it a bonus implies we
    // chose to be generous.
    parts.push({ label: 'surge', centavos: order.surgeCentavos ?? 0 });
  }
  if (order.tipCentavos > 0) {
    parts.push({ label: 'tip', centavos: order.tipCentavos });
  }
  return parts;
}
