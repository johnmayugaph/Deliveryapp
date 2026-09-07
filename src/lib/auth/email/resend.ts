import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailSender,
  type EmailSendResult,
} from '@/lib/auth/email/types';

/**
 * Resend (resend.com) — the first adapter.
 *
 * Chosen because its send API is a single JSON POST with a bearer token, which
 * means the adapter is short enough to read in one screen and the failure modes
 * are the HTTP ones. SES and Postmark are the obvious alternatives and each is
 * another file like this one, with no change to the recovery flow.
 *
 * NOT VERIFIED against the live API. This codebase has no email account, and
 * the development environment's network policy blocks outbound mail providers
 * the same way it blocks the SMS gateways — so the request shape below is
 * written from Resend's documented form and exercised only against a local
 * server that asserts the bytes (`src/tests/email-wire.test.ts`). Send one real
 * message with `npm run email:send-one` before trusting it.
 */
export class ResendEmailSender implements EmailSender {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    /**
     * The From address. Must be on a domain verified with the provider —
     * an unverified sender is the single most common cause of mail that is
     * accepted by the API and never delivered.
     */
    private readonly fromAddress: string,
    /** Public so callers and tests can report where mail actually goes. */
    readonly endpoint = 'https://api.resend.com/emails',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          // Bearer, not a query parameter: a key in a URL lands in every
          // access log between here and there.
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: [message.to],
          subject: message.subject,
          text: message.body,
        }),
        // A recovery screen must not hang on a slow provider.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new EmailDeliveryError(this.name, 'request failed or timed out', error);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new EmailDeliveryError(
        this.name,
        `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }

    try {
      const payload = (await response.json()) as { id?: unknown } | null;
      const id = payload?.id;
      return {
        providerMessageId: id === undefined || id === null ? null : String(id),
        provider: this.name,
      };
    } catch {
      // Accepted but unparseable is still accepted. Failing a recovery over a
      // response body we could not read, after the mail was already sent,
      // would strand somebody who has no other route in.
      return { providerMessageId: null, provider: this.name };
    }
  }
}
