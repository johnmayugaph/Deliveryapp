import { SmsDeliveryError, type SmsMessage, type SmsSender, type SmsSendResult } from '@/lib/auth/sms/types';

/**
 * Semaphore (semaphore.co) — a Philippine bulk-SMS gateway.
 *
 * Chosen as the first adapter because it is the common local choice: peso
 * billing, local sender-name registration, and no per-country setup. The
 * interface is what matters; swapping in Movider, Twilio or an aggregator means
 * another file like this one and no change to the login flow.
 *
 * Verified how far it can be. `src/tests/sms-wire.test.ts` runs this adapter
 * against a real HTTP server on a loopback socket and asserts the exact bytes a
 * gateway receives — method, content type, field names, and the percent-encoded
 * `+` on the E.164 number. What that cannot establish is Semaphore's own
 * behaviour: whether a key is live, whether a sender name is registered, what a
 * message costs, whether a handset rings. Run `npm run sms:send-one` once
 * against a number you hold before trusting this in production.
 */
export class SemaphoreSmsSender implements SmsSender {
  readonly name = 'semaphore';

  constructor(
    private readonly apiKey: string,
    /** Registered sender name. Semaphore rejects unregistered ones. */
    private readonly senderName: string | undefined,
    /** Public so callers and tests can report where sends actually go. */
    readonly endpoint = 'https://api.semaphore.co/api/v4/messages',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const body = new URLSearchParams({
      apikey: this.apiKey,
      number: message.to,
      message: message.body,
    });
    if (this.senderName) {
      body.set('sendername', this.senderName);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        // A login screen must not hang on a slow gateway.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new SmsDeliveryError(this.name, 'request failed or timed out', error);
    }

    if (!response.ok) {
      // Read the body for the reason, but never let it mask the status.
      const detail = await response.text().catch(() => '');
      throw new SmsDeliveryError(
        this.name,
        `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      );
    }

    // Semaphore answers with an array of queued messages.
    try {
      const payload = (await response.json()) as unknown;
      const first = Array.isArray(payload) ? payload[0] : payload;
      const id = (first as { message_id?: unknown } | null)?.message_id;
      return {
        providerMessageId: id === undefined || id === null ? null : String(id),
        provider: this.name,
      };
    } catch {
      // Accepted but unparseable is still accepted; do not fail a login over it.
      return { providerMessageId: null, provider: this.name };
    }
  }
}
