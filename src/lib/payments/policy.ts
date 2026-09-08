import {
  PaymentEventType,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';

/**
 * The rules that decide what a payment means. Pure — this module imports
 * nothing but types, so it is testable without a database and safe to import
 * from a client component. (Four separate features have now had a page 500 by
 * reaching `next/headers` through a chain that started in a module like this
 * one; hence the rule, and hence the guard test.)
 *
 * Everything here is a rule rather than a case. The two that matter most:
 *
 *   1. **Cash never becomes credits.** `REFUND_DESTINATION` sends money back
 *      to the instrument it arrived on. Refunding a transfer into a credits
 *      balance would be a top-up path — pay us ₱500, cancel, keep ₱500 of
 *      spendable balance — and the whole credits design exists to not have
 *      one.
 *   2. **A prepaid order is not an order until it is paid.** `isPrepaid` is
 *      what stops a kitchen cooking food nobody has paid for, and it is read
 *      from a map over every method rather than an `if` on one of them.
 */

/**
 * Whether the money is expected BEFORE the order goes to the shop.
 *
 * Keyed by every method so adding one is a compile error here rather than a
 * silent `false` somewhere. That is deliberate: the failure mode of a new
 * method defaulting to "not prepaid" is food cooked for free.
 */
export const PREPAID_METHODS: Readonly<Record<PaymentMethod, boolean>> = {
  // Paid at the door, in cash, by definition.
  [PaymentMethod.CASH_ON_DELIVERY]: false,
  // Credits are spent inside the placement transaction itself, so by the time
  // an order exists the money has already moved. Nothing to wait for.
  [PaymentMethod.WALLET_CREDIT]: false,
  // The one that waits: the customer transfers in their own app and we hold
  // the order until somebody has checked the reference.
  [PaymentMethod.MANUAL_TRANSFER]: true,
};

export function isPrepaid(method: PaymentMethod): boolean {
  return PREPAID_METHODS[method];
}

/** Where a refund on this instrument has to go. */
export type RefundDestination = 'CREDITS_LEDGER' | 'SOURCE_OF_FUNDS';

/**
 * The no-top-up rule, expressed per instrument.
 *
 * Credits spent on an order go back to credits: that money was ours to begin
 * with, and returning it changes nothing about what a balance is. Real money
 * goes back the way it came — to the card, the wallet, or the hand that held
 * the cash.
 *
 * The temptation this exists to refuse is real and it is convenient: a
 * cancelled transfer is much easier to settle as credits than as a transfer
 * back, and the customer might even prefer it. It is still a way to convert
 * cash into spendable balance, which is the one thing the credits design
 * promises is impossible.
 */
export const REFUND_DESTINATION: Readonly<Record<PaymentMethod, RefundDestination>> =
  {
    [PaymentMethod.CASH_ON_DELIVERY]: 'SOURCE_OF_FUNDS',
    [PaymentMethod.WALLET_CREDIT]: 'CREDITS_LEDGER',
    [PaymentMethod.MANUAL_TRANSFER]: 'SOURCE_OF_FUNDS',
  };

export function refundDestinationFor(method: PaymentMethod): RefundDestination {
  return REFUND_DESTINATION[method];
}

/** Methods whose refund may touch the credits ledger. Exactly one. */
export const CREDIT_REFUNDABLE_METHODS: readonly PaymentMethod[] = (
  Object.keys(REFUND_DESTINATION) as PaymentMethod[]
).filter((method) => REFUND_DESTINATION[method] === 'CREDITS_LEDGER');

export class CashCannotBecomeCreditsError extends Error {
  constructor(readonly method: PaymentMethod) {
    super(
      `A ${method} payment refunds to its source, not to credits. Returning ` +
        'real money as a spendable balance would be a top-up path, which this ' +
        'product does not have.',
    );
    this.name = 'CashCannotBecomeCreditsError';
  }
}

/**
 * Which direction each event moves money.
 *
 * Callers pass a magnitude and a type; the sign comes from here. Same reason
 * as `signedAmountFor` in the credits ledger — a caller who can choose the
 * sign can book a refund as a charge, and that mistake is invisible until
 * somebody adds up a day's takings.
 */
export const EVENT_DIRECTION: Readonly<Record<PaymentEventType, -1 | 0 | 1>> = {
  // Intent and claims move nothing. A customer saying they have paid is not
  // the same as money arriving, and the gap between those two is exactly
  // where a payments bug lives.
  [PaymentEventType.CHARGE_REQUESTED]: 0,
  [PaymentEventType.CHARGE_SUBMITTED]: 0,
  [PaymentEventType.CHARGE_REFUSED]: 0,
  [PaymentEventType.CHARGE_EXPIRED]: 0,
  // Money in.
  [PaymentEventType.CHARGE_CONFIRMED]: 1,
  [PaymentEventType.CASH_COLLECTED]: 1,
  // Money out.
  [PaymentEventType.REFUND_ISSUED]: -1,
};

export class InvalidPaymentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPaymentEventError';
  }
}

export function signedPaymentAmount(
  type: PaymentEventType,
  amountCentavos: number,
): number {
  if (!Number.isInteger(amountCentavos)) {
    throw new InvalidPaymentEventError(
      `Payment amounts must be whole centavos, got ${amountCentavos}`,
    );
  }
  if (amountCentavos < 0) {
    throw new InvalidPaymentEventError(
      'Pass a magnitude, not a signed amount: the direction comes from the event type',
    );
  }

  const direction = EVENT_DIRECTION[type];
  if (direction === 0) {
    if (amountCentavos !== 0) {
      throw new InvalidPaymentEventError(
        `${type} records intent rather than movement, so it cannot carry ${amountCentavos} centavos`,
      );
    }
    return 0;
  }

  if (amountCentavos === 0) {
    throw new InvalidPaymentEventError(`${type} must move a non-zero amount`);
  }

  return direction * amountCentavos;
}

/** Events that cannot be written without a reason somebody can read. */
export const REASON_REQUIRED_EVENTS: readonly PaymentEventType[] = [
  PaymentEventType.CHARGE_REFUSED,
  PaymentEventType.REFUND_ISSUED,
];

export function reasonIsRequired(type: PaymentEventType): boolean {
  return REASON_REQUIRED_EVENTS.includes(type);
}

/** The shape `derivePaymentStatus` needs. Anything wider is the caller's. */
export interface PaymentEventFacts {
  type: PaymentEventType;
  amountCentavos: number;
}

/**
 * The order's payment status, computed from its events.
 *
 * Read the money first and the intent second, because money is the fact and
 * intent is a claim. So: add up what came in and what went back out, and only
 * if nothing has moved at all does the newest non-financial event get to
 * describe the situation.
 *
 * `expectedCentavos` is what the order says is owed. It decides PAID from
 * PARTIALLY_REFUNDED — a refund that returns everything is REFUNDED, one that
 * returns part of it is not, and neither is a guess about a total.
 */
export function derivePaymentStatus(
  events: readonly PaymentEventFacts[],
  expectedCentavos: number,
): PaymentStatus {
  let received = 0;
  let refunded = 0;
  for (const event of events) {
    if (event.amountCentavos > 0) received += event.amountCentavos;
    if (event.amountCentavos < 0) refunded += -event.amountCentavos;
  }

  if (refunded > 0) {
    // Everything that arrived has gone back.
    return refunded >= received ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
  }

  if (received > 0) {
    // Short of the total is not paid. A transfer for the wrong amount is the
    // most common way a manual rail goes wrong, and calling it PAID is how a
    // shop ends up out of pocket.
    return received >= expectedCentavos ? PaymentStatus.PAID : PaymentStatus.AUTHORIZED;
  }

  // Nothing has moved. The newest event that says why wins — newest, so a
  // customer who is refused and then sends a corrected reference is CLAIMED
  // again rather than stuck at FAILED.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]!.type;
    if (type === PaymentEventType.CHARGE_REFUSED) return PaymentStatus.FAILED;
    if (type === PaymentEventType.CHARGE_EXPIRED) return PaymentStatus.FAILED;
    if (type === PaymentEventType.CHARGE_SUBMITTED) return PaymentStatus.CLAIMED;
  }

  // An order that owes nothing — credits covered all of it — is paid, and has
  // no events at all.
  if (expectedCentavos === 0) return PaymentStatus.PAID;

  return PaymentStatus.PENDING;
}

/**
 * How long an unpaid order waits before we let it go.
 *
 * Twenty minutes. Long enough to open another app, find the account number and
 * fumble a transfer; short enough that a shop is not holding a slot for
 * somebody who wandered off. It is deliberately longer than the eight minutes
 * a shop gets to accept, because the customer's leg of this involves leaving
 * the app.
 */
export const PAYMENT_WINDOW_SECONDS = 20 * 60;

/**
 * Whether the rider should be asking for money at the door.
 *
 * This is the question a payments feature most has to get right on the rider's
 * screen, and it is not "is the method cash": a transfer that was never
 * confirmed must still be collected in cash or the rider hands over food for
 * nothing, and a prepaid order that IS confirmed must show nothing to collect
 * or a rider asks a customer to pay twice.
 *
 * CLAIMED counts as unpaid, which is the uncomfortable but correct answer. A
 * customer's word that they sent it is not money in the account, and a rider
 * cannot be the one who finds out.
 */
export function cashToCollectCentavos(
  method: PaymentMethod,
  status: PaymentStatus,
  totalCentavos: number,
): number {
  if (totalCentavos <= 0) return 0;
  if (status === PaymentStatus.PAID) return 0;
  if (method === PaymentMethod.WALLET_CREDIT) return 0;
  return totalCentavos;
}

/**
 * A transfer reference, as typed by somebody on a phone.
 *
 * GCash gives a 13-digit number; Maya and the banks give something else, so
 * the shape is not pinned to one of them. Spaces, dashes and case are noise
 * from a copy-paste and are removed rather than rejected — refusing a
 * reference for having a space in it teaches people the app is broken.
 *
 * Returns null for anything that cannot be a reference, which the caller turns
 * into a message. Never throws: this runs on customer input.
 */
export function normaliseReference(raw: string): string | null {
  const stripped = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (stripped.length < MIN_REFERENCE_LENGTH) return null;
  if (stripped.length > MAX_REFERENCE_LENGTH) return null;
  if (!/^[A-Z0-9]+$/.test(stripped)) return null;
  return stripped;
}

export const MIN_REFERENCE_LENGTH = 6;
export const MAX_REFERENCE_LENGTH = 32;

/** What a customer is told while we wait, in their own terms. */
export function describePaymentWait(status: PaymentStatus): string {
  switch (status) {
    case PaymentStatus.PENDING:
      return 'Send the payment and enter the reference number below.';
    case PaymentStatus.CLAIMED:
      return 'We have your reference and are checking it. This is usually quick.';
    case PaymentStatus.AUTHORIZED:
      return 'Part of the payment arrived. Check the amount and send the rest.';
    case PaymentStatus.PAID:
      return 'Paid. Nothing to hand over at the door.';
    case PaymentStatus.FAILED:
      return 'We could not match that payment. Check the reference and try again.';
    case PaymentStatus.PARTIALLY_REFUNDED:
      return 'Part of this order has been refunded.';
    case PaymentStatus.REFUNDED:
      return 'This order has been refunded.';
  }
}

/** Whether a claimed reference is still waiting for a human to look at it. */
export function awaitsConfirmation(
  events: readonly PaymentEventFacts[],
  expectedCentavos: number,
): boolean {
  return derivePaymentStatus(events, expectedCentavos) === PaymentStatus.CLAIMED;
}
