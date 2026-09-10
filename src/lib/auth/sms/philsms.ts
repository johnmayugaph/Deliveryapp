import { SmsDeliveryError, type SmsMessage, type SmsSender, type SmsSendResult } from '@/lib/auth/sms/types';

/**
 * PhilSMS (philsms.com) — a Philippine bulk-SMS gateway.
 *
 * The second adapter, added for one reason: price. At the time of writing
 * PhilSMS bills around ₱0.35 per message with no minimum top-up, against
 * roughly ₱0.50–0.56 for Semaphore, and for a deployment whose entire
 * SMS traffic is login codes that difference is most of the bill. Nothing else
 * about this file is a judgement on either vendor.
 *
 * Three things differ from `SemaphoreSmsSender` and each one is a way to get a
 * silent failure:
 *
 * **JSON, not a form.** `POST /api/v3/sms/send` with a bearer token, an
 * `application/json` body, and `type: "plain"`. Sending form fields to it
 * returns a 4xx that says nothing useful.
 *
 * **The recipient carries no `+`.** `SmsMessage.to` is normalised E.164, so it
 * arrives here as `+639171234567`; PhilSMS documents `639171234567`. The `+`
 * is stripped once, here, rather than changing what the rest of the
 * application means by a phone number.
 *
 * **A sender ID is required, and a wrong one is accepted then rejected.** There
 * is no account default to fall back on, which is why `PHILSMS_SENDER_ID` sits
 * in the registry's `requires` beside the token: a deployment missing it should
 * read as unconfigured on `/admin/health` rather than as a gateway that 422s
 * the first time a customer asks for a code.
 *
 * And one that is not a difference so much as a trap: **this gateway can answer
 * HTTP 200 with `{"status":"error"}`**. A send is only accepted if the body
 * says so. Treating 200 as success is how you get a login screen reporting a
 * code on its way to a handset that will never ring.
 *
 * Verified as far as this environment allows: `src/tests/sms-wire.test.ts`
 * runs this adapter against a real HTTP server on a loopback socket and
 * asserts the bytes a gateway receives — method, bearer header, content type,
 * JSON field names, and the stripped `+`. What no test here can establish is
 * PhilSMS's own behaviour: whether a token is live, whether a sender ID is
 * approved, what a message costs, whether a handset rings. Run
 * `npm run sms:send-one` once against a number you hold before trusting this
 * in production.
 */
export class PhilSmsSender implements SmsSender {
  readonly name = 'philsms';

  constructor(
    private readonly apiToken: string,
    /** Approved sender ID. Max 11 characters alphanumeric; required. */
    private readonly senderId: string,
    /** Public so callers and tests can report where sends actually go. */
    readonly endpoint = 'https://app.philsms.com/api/v3/sms/send',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const body = JSON.stringify({
      // Documented as `639171234567`. `SmsMessage.to` is E.164, so drop the
      // leading `+` and nothing else — no other reshaping, so a number that
      // was wrong upstream stays visibly wrong rather than becoming a
      // different valid number.
      recipient: message.to.replace(/^\+/, ''),
      sender_id: this.senderId,
      type: 'plain',
      message: message.body,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
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

    // A 200 is not an acceptance here. The envelope decides.
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // Unlike Semaphore, an unreadable body cannot be treated as accepted:
      // this gateway reports refusals inside a 200, so an unparseable one is
      // an unknown outcome and a login that claims success would be a lie.
      throw new SmsDeliveryError(this.name, 'HTTP 200 with an unreadable body', error);
    }

    const envelope = (payload ?? {}) as {
      status?: unknown;
      message?: unknown;
      data?: unknown;
    };

    if (typeof envelope.status === 'string' && envelope.status.toLowerCase() !== 'success') {
      const reason = typeof envelope.message === 'string' ? envelope.message : envelope.status;
      throw new SmsDeliveryError(this.name, `refused: ${String(reason).slice(0, 200)}`);
    }

    return { providerMessageId: readMessageId(envelope.data), provider: this.name };
  }
}

/**
 * The provider's message id, when it gives one.
 *
 * `data` is documented only as "sms reports with all details", so its shape is
 * not something to depend on: it has been seen as an object, and a batch send
 * would reasonably make it an array. This looks in the two obvious places and
 * gives up quietly — a missing id is a cosmetic loss in a log line, and is not
 * worth failing a login over.
 */
function readMessageId(data: unknown): string | null {
  const first = Array.isArray(data) ? data[0] : data;
  if (first === null || typeof first !== 'object') return null;
  const candidate = (first as { uid?: unknown; id?: unknown; message_id?: unknown });
  const id = candidate.uid ?? candidate.id ?? candidate.message_id;
  return id === undefined || id === null ? null : String(id);
}
