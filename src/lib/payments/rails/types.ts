import type { PaymentMethod } from '@prisma/client';

/**
 * What the application asks of a way to take money.
 *
 * The seam exists because the rail this app can run today needs no provider
 * account and the rail it will want later needs onboarding, a business
 * registration and a bank arrangement. Both are "take ₱324 for order
 * DA-20260908-ABCDE"; almost nothing else about them is the same, which is why
 * `begin()` returns a union rather than a URL.
 *
 * Modelled on `SmsSender` in src/lib/auth/sms/types.ts, which has now survived
 * one real provider being added behind it.
 */

/** Tell the customer how to send the money themselves. */
export interface TransferInstructions {
  kind: 'INSTRUCTIONS';
  /** The wallet or bank as the customer knows it: "GCash", "Maya", "BPI". */
  label: string;
  /** The name on the receiving account, so they can check before sending. */
  accountName: string;
  /** The number or account they send to. Displayed, never parsed. */
  accountNumber: string;
  /** What to send, in centavos. Shown formatted; compared exactly. */
  amountCentavos: number;
  /**
   * The order's own reference, which the customer is asked to put in the
   * transfer note. It is what makes an unmatched payment findable later.
   */
  ourReference: string;
}

/**
 * Send the customer to the provider and wait to be told what happened.
 *
 * No rail returns this yet. It is here because designing the union around one
 * arm makes the second arm a rewrite, and because it documents what a provider
 * rail has to supply: somewhere to send them, and something to recognise them
 * by when they come back.
 */
export interface HostedRedirect {
  kind: 'REDIRECT';
  url: string;
  /** The provider's id for this attempt, stored so a webhook can be matched. */
  providerReference: string;
}

export type PaymentStart = TransferInstructions | HostedRedirect;

/** Who decides that the money arrived. */
export type ConfirmationSource =
  /** Somebody looks at a statement and says yes. */
  | 'HUMAN'
  /** The provider tells us, over a signed webhook. */
  | 'PROVIDER';

export interface PaymentRail {
  /**
   * Stored on every event this rail writes, so a row can always be traced to
   * the thing that produced it. `manual` today.
   */
  readonly key: string;

  /** The instrument this rail settles. */
  readonly method: PaymentMethod;

  readonly confirmation: ConfirmationSource;

  /** How the rail is named to a customer choosing one. */
  readonly customerLabel: string;

  /**
   * Begin taking the money.
   *
   * Returns what the customer has to do next. Throws `PaymentRailNotReadyError`
   * rather than returning something half-configured: a checkout that offers a
   * payment method and then cannot say where to send the money is worse than
   * one that does not offer it.
   */
  begin(input: {
    orderNumber: string;
    amountCentavos: number;
  }): Promise<PaymentStart>;
}

export class PaymentRailNotReadyError extends Error {
  constructor(
    readonly key: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentRailNotReadyError';
  }
}
