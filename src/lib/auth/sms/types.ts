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
