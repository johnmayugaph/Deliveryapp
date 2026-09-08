import {
  SubscriptionRailNotReadyError,
  type CollectableInvoice,
  type PaymentRequest,
  type SubscriptionRail,
} from '@/lib/subscriptions/rails/types';

/**
 * Collecting a monthly fee by asking for a transfer.
 *
 * The customer opens GCash (or Maya, or their bank), sends the amount to an
 * account we name, puts the invoice reference in the note, and types the
 * reference number back into the app. Somebody with access to that account
 * checks it and confirms.
 *
 * ### What this is, honestly
 *
 * It makes Plus **sellable**, which it has not been since the plan was built.
 * It is **not recurring billing**. Those two sentences are both true and the
 * second one matters:
 *
 *  - The customer has to decide to pay, every month. Some will forget, and
 *    the lapse rate on a manually-paid subscription is far worse than on a
 *    card — that is not a bug in this rail, it is what this rail is.
 *  - Somebody on our side has to confirm every transfer. One person per
 *    subscriber per month. At twenty subscribers that is a coffee's worth of
 *    attention; at four hundred it is a job, and at that point the provider
 *    fee is cheaper than the person.
 *
 * `/admin/subscriptions` shows the confirmation count for exactly that reason.
 * The number is the signal for when to stop using this.
 *
 * ### Why it is worth having anyway
 *
 * A provider account needs DTI or SEC registration and BIR registration —
 * both still open on the launch checklist, both measured in weeks. This rail
 * needs a phone number. It also has no per-transaction fee, which on a ₱99
 * subscription is a meaningful slice of a thin margin.
 *
 * Brand-free on purpose: "GCash" is a label in the environment, not a branch
 * in the code, and it reuses the SAME account the order transfer rail uses so
 * a deployment configures one thing rather than two.
 */
export class ManualSubscriptionRail implements SubscriptionRail {
  readonly key = 'manual';
  readonly mode = 'REQUESTED' as const;
  readonly settlement = 'HUMAN' as const;

  constructor(
    private readonly account: {
      label: string;
      accountName: string;
      accountNumber: string;
    },
  ) {}

  get customerLabel(): string {
    return this.account.label;
  }

  async request(invoice: CollectableInvoice): Promise<PaymentRequest> {
    if (invoice.amountCentavos <= 0) {
      // Nothing to collect means this rail should never have been asked, and
      // instructions to send ₱0.00 are how a customer decides the app is
      // broken. The invoice guard refuses a zero amount at the database, so
      // reaching here means somebody constructed one by hand.
      throw new SubscriptionRailNotReadyError(
        this.key,
        'There is nothing to pay on this invoice.',
      );
    }

    return {
      kind: 'REQUEST',
      label: this.account.label,
      accountName: this.account.accountName,
      accountNumber: this.account.accountNumber,
      amountCentavos: invoice.amountCentavos,
      ourReference: invoice.reference,
      dueAt: invoice.dueAt,
    };
  }

  // No `collect`. This rail cannot charge anybody — that is the definition of
  // REQUESTED, and the optional method is absent rather than throwing so that
  // `rail.collect === undefined` is the check, not a try/catch.
}
