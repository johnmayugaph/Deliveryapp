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
 * The delivery fee plus the whole tip. Note that the delivery fee is the
 * order's full quoted fee even when a subscription benefit waived it for the
 * customer — that waiver is our marketing cost, not a pay cut for the person
 * doing the ride. Platform commission is not modelled yet; when it is, it comes
 * off our side, not out of the tip.
 */
export function partnerEarningsCentavos(order: {
  deliveryFeeCentavos: number;
  tipCentavos: number;
}): number {
  return order.deliveryFeeCentavos + order.tipCentavos;
}
