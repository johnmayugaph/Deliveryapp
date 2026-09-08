/**
 * What the application asks of a way to collect a monthly fee.
 *
 * ### Why this is not the order payment seam
 *
 * `PaymentRail` in lib/payments/rails answers "take ₱324 for order
 * DA-20260908-ABCDE" — one amount, once, with a customer present who chose to
 * pay it. A subscription asks something different in one crucial way: it
 * happens again next month, and the customer is not there.
 *
 * That difference is the whole content of this file. It is why there is a
 * MANDATE below and not just a charge, and why the automatic arm takes an
 * invoice rather than an amount.
 *
 * ### The two kinds of rail, and the honest difference between them
 *
 * **A REQUESTED rail asks the customer to pay, every period.** A bank or
 * e-wallet transfer they make by hand. It works today with no provider
 * account, and it is emphatically *not* recurring billing: somebody has to
 * decide to pay each month, and somebody on our side has to confirm each
 * transfer. That is a real operational cost per subscriber per month, and it
 * is the reason `/admin/subscriptions` shows the confirmation count — so it is
 * visible when the volume stops being viable.
 *
 * **An AUTHORISED rail charges a stored instrument.** A tokenised card, or an
 * e-wallet recurring mandate. The customer authorises once and the money
 * arrives on its own. That is what "recurring" means, and it needs a provider,
 * which needs the business registration still open on the launch checklist.
 *
 * Both settle the same `SubscriptionInvoice`, which is the point of having
 * built invoices first: the rest of the system does not know or care which
 * arm collected the money.
 */

/** How a rail gets paid. See the note above — the difference is not cosmetic. */
export type CollectionMode =
  /** The customer is asked to send it, each period. */
  | 'REQUESTED'
  /** We charge an instrument they authorised once. */
  | 'AUTHORISED';

/** Who decides that the money arrived. */
export type SettlementSource =
  /** Somebody looks at a statement and says yes. */
  | 'HUMAN'
  /** The provider tells us, over a signed webhook. */
  | 'PROVIDER';

/**
 * What to show a customer who owes money on a REQUESTED rail.
 *
 * Deliberately the same shape as `TransferInstructions` for an order, because
 * it is the same screen furniture and the same account — a customer should not
 * have to learn two ways to pay us.
 */
export interface PaymentRequest {
  kind: 'REQUEST';
  /** The wallet or bank as the customer knows it: "GCash", "Maya", "BPI". */
  label: string;
  accountName: string;
  accountNumber: string;
  amountCentavos: number;
  /** The invoice's own reference, to put in the transfer note. */
  ourReference: string;
  /** When the money has to be with us. */
  dueAt: Date;
}

/**
 * A stored authorisation to charge, on an AUTHORISED rail.
 *
 * This is the object that makes billing *recurring*, and it is worth naming
 * even with no implementation, because its absence is what makes the existing
 * seam unable to describe the thing it claims to be for. Three properties
 * matter and all three are about the customer keeping control:
 *
 *  - it is REVOCABLE, and revoking it is a thing the customer can do from
 *    their own screen rather than a support request;
 *  - it EXPIRES, because cards do, and a mandate that outlives its instrument
 *    produces a failed charge that looks like a decline;
 *  - it holds only a provider token and a label. No card number reaches this
 *    application, ever, which is the only version of card handling a business
 *    at this stage should attempt.
 */
export interface PaymentMandate {
  /** The provider's token. Opaque here, and never logged. */
  token: string;
  /** What to show the customer: "Visa ending 4242", "GCash 0917•••4567". */
  displayLabel: string;
  /** Null when the instrument does not expire. */
  expiresAt: Date | null;
}

/** The invoice a rail is being asked to collect. Just what a rail needs. */
export interface CollectableInvoice {
  id: string;
  reference: string;
  amountCentavos: number;
  dueAt: Date;
}

export interface SettlementResult {
  /** The provider's own reference, for reconciliation. */
  reference: string;
  amountCentavos: number;
  settledAt: Date;
}

export interface SubscriptionRail {
  /**
   * Stored on the invoice it settles, so a row can always be traced to the
   * thing that collected it. `manual` today.
   */
  readonly key: string;

  readonly mode: CollectionMode;
  readonly settlement: SettlementSource;

  /** How the rail is named to a customer. */
  readonly customerLabel: string;

  /**
   * What the customer has to do, on a REQUESTED rail.
   *
   * Throws `SubscriptionRailNotReadyError` rather than returning something
   * half-configured: a screen that says "pay us" without saying where is worse
   * than one that says the plan is not for sale yet.
   */
  request(invoice: CollectableInvoice): Promise<PaymentRequest>;

  /**
   * Charge a stored instrument, on an AUTHORISED rail.
   *
   * Takes the INVOICE and an idempotency key, not a user and an amount. The
   * previous version of this seam took `{userId, amountCentavos, description}`,
   * and that shape has two holes a provider would have fallen straight into: a
   * retried webhook or a re-run cron would charge the same month twice, and
   * nothing tied a charge to the period it paid for, so a reconciliation could
   * not tell one month's ₱99 from another's.
   *
   * Absent on a REQUESTED rail, where there is nothing to charge.
   */
  collect?(input: {
    invoice: CollectableInvoice;
    mandate: PaymentMandate;
    /** Derived from the invoice, so a retry cannot double-charge. */
    idempotencyKey: string;
  }): Promise<SettlementResult>;
}

export class SubscriptionRailNotReadyError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = 'SubscriptionRailNotReadyError';
  }
}
