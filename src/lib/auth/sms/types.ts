/**
 * SMS delivery.
 *
 * An interface rather than a direct provider call, because the provider is the
 * part of this system most likely to be swapped: Philippine bulk-SMS gateways
 * differ in price, sender-name registration, and reliability, and switching one
 * should not touch the login flow.
 */
export interface SmsMessage {
  /** E.164 destination, already normalised. */
  to: string;
  body: string;
}

export interface SmsSendResult {
  /** Provider identifier for the message, when it gives one. */
  providerMessageId: string | null;
  /** Which sender handled it, for logs and support. */
  provider: string;
}

export interface SmsSender {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

export class SmsDeliveryError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    /** `override` because Error already declares `cause`. */
    override readonly cause?: unknown,
  ) {
    super(`SMS delivery via ${provider} failed: ${message}`);
    this.name = 'SmsDeliveryError';
  }
}

/**
 * Just the variables sender selection reads.
 *
 * Lives here rather than beside `resolveSmsSender` so the provider registry
 * can name its own variables without importing the selector that imports it.
 * The index signature is what lets a spec declare `requires: ['TWILIO_...']`
 * as strings and have them looked up — the alternative was a union of every
 * variable name, which every new provider would have had to extend in two
 * places.
 */
export interface SmsEnv {
  /**
   * The order to try gateways in, comma separated — e.g. `twilio,semaphore`.
   * Unrecognised names are ignored and configured providers it omits are
   * appended, so a typo cannot silently disable a working gateway.
   */
  SMS_PROVIDER_ORDER?: string | undefined;
  NODE_ENV?: string | undefined;
  /** Every provider's own variables, reached by the names in its spec. */
  [key: string]: string | undefined;
}
