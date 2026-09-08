import { PaymentMethod } from '@prisma/client';
import {
  PaymentRailNotReadyError,
  type PaymentRail,
  type TransferInstructions,
} from '@/lib/payments/rails/types';

/**
 * The rail that needs nothing but a phone number.
 *
 * The customer opens GCash (or Maya, or their bank), sends the total to an
 * account we name, puts the order reference in the note, and types the
 * reference number back into the app. Somebody with access to that account
 * checks it and confirms.
 *
 * This is how a great many small Philippine businesses already take money, and
 * it is the only rail that can run before the paperwork is done — a provider
 * account needs DTI or SEC registration and BIR registration, which are the
 * two items still open on the launch checklist. It also has no per-transaction
 * fee, which for a business whose margin is a delivery fee is not a small
 * thing.
 *
 * What it costs is a person's attention, once per order, and that is the honest
 * trade: it does not scale past the volume one person can check, and it should
 * be replaced by a provider rail when it starts hurting. Until then it takes
 * money out of a rider's hands, which is the risk worth removing first.
 *
 * Brand-free on purpose. "GCash" is a label in the environment, not a branch in
 * the code, so the same rail serves Maya or a bank transfer without a change
 * here.
 */
export class ManualTransferRail implements PaymentRail {
  readonly key = 'manual';
  readonly method = PaymentMethod.MANUAL_TRANSFER;
  readonly confirmation = 'HUMAN' as const;

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

  async begin(input: {
    orderNumber: string;
    amountCentavos: number;
  }): Promise<TransferInstructions> {
    if (input.amountCentavos <= 0) {
      // Nothing to collect means this rail should never have been offered, and
      // showing instructions to send ₱0.00 is how a customer decides the app
      // is broken.
      throw new PaymentRailNotReadyError(
        this.key,
        'There is nothing to pay on this order.',
      );
    }

    return {
      kind: 'INSTRUCTIONS',
      label: this.account.label,
      accountName: this.account.accountName,
      accountNumber: this.account.accountNumber,
      amountCentavos: input.amountCentavos,
      ourReference: input.orderNumber,
    };
  }
}
