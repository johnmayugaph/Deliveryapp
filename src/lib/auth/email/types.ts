/**
 * Email delivery.
 *
 * An interface rather than a direct provider call, for the same reason SMS is:
 * the provider is the part most likely to be swapped, and swapping it should
 * not touch the recovery flow.
 *
 * Email carries exactly one thing in this system — a code proving somebody
 * holds an address — and that shapes everything below. There is no template
 * engine, no HTML body and no unsubscribe link, because there is nothing to
 * unsubscribe from. An account that starts sending marketing through this
 * interface should be sending it through something else.
 */
export interface EmailMessage {
  /** A single address, lower-cased and trimmed. */
  to: string;
  subject: string;
  /** Plain text. Deliberately not HTML: a code does not need markup, and a
   *  text-only message is the one shape no client renders badly. */
  body: string;
}

export interface EmailSendResult {
  providerMessageId: string | null;
  provider: string;
}

export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export class EmailDeliveryError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    /** `override` because Error already declares `cause`. */
    override readonly cause?: unknown,
  ) {
    super(`Email delivery via ${provider} failed: ${message}`);
    this.name = 'EmailDeliveryError';
  }
}
