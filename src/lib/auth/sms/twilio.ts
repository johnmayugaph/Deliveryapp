import {
  SmsDeliveryError,
  type SmsMessage,
  type SmsSender,
  type SmsSendResult,
} from '@/lib/auth/sms/types';

/**
 * Twilio — the Programmable Messaging API.
 *
 * Here for a specific reason rather than as a second option for its own sake:
 * **it can be signed up for in minutes.** A Philippine branded sender name
 * takes days of carrier approval, and until one exists nobody can sign in at
 * all, which makes "does an OTP actually reach a handset" the one question
 * this project has never been able to answer. Twilio answers it today, from a
 * shared sender, while the branded application runs in parallel with whichever
 * local gateway is cheapest.
 *
 * It also earns its place afterwards, as the second gateway in the chain — see
 * `fallback.ts`.
 *
 * ### The two things worth knowing about their wire format
 *
 * **Auth is HTTP Basic, not a field.** `AccountSid:AuthToken`, base64. The
 * token never goes in the URL or the body, for the same reason Semaphore's key
 * does not: a query string lands in access logs and in error reports.
 *
 * **One of `From` or `MessagingServiceSid`, never neither.** Twilio rejects a
 * message with no origin, and the failure arrives as a 400 with a code — so
 * this constructor refuses to build rather than letting a login discover it.
 * A Messaging Service is the better production answer (it holds the sender
 * pool and the sticky-sender rules); a bare `From` number is what a trial
 * account has.
 *
 * Verified how far it can be: `src/tests/sms-wire.test.ts` runs this adapter
 * against a real HTTP server on a loopback socket and asserts the exact bytes
 * — the method, the Basic credentials, the content type, the field names, and
 * the percent-encoded leading `+`, which on the Semaphore side was the one
 * silent and billable bug. What no test here can establish is Twilio's own
 * side: whether the credentials are live, whether the number is provisioned,
 * whether a Philippine handset rings. `npm run sms:send-one` is that step.
 */

export interface TwilioSmsOptions {
  accountSid: string;
  authToken: string;
  /** An E.164 number on the account. Either this or `messagingServiceSid`. */
  from?: string | undefined;
  /** A Messaging Service SID. Preferred in production. */
  messagingServiceSid?: string | undefined;
  /** Overridden only in development — see `devEndpointFor`. */
  endpoint?: string | undefined;
}

export class TwilioSmsSender implements SmsSender {
  readonly name = 'twilio';

  /** Public so callers and tests can report where sends actually go. */
  readonly endpoint: string;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly from: string | undefined;
  private readonly messagingServiceSid: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TwilioSmsOptions, fetchImpl: typeof fetch = fetch) {
    if (!options.from && !options.messagingServiceSid) {
      // Refused at construction, not at send: a login is the wrong place to
      // find out that a deployment was never told who the message is from.
      throw new SmsDeliveryError(
        'twilio',
        'needs one of TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID — ' +
          'Twilio rejects a message with no origin',
      );
    }
    this.accountSid = options.accountSid;
    this.authToken = options.authToken;
    this.from = options.from;
    this.messagingServiceSid = options.messagingServiceSid;
    this.fetchImpl = fetchImpl;
    this.endpoint =
      options.endpoint ??
      `https://api.twilio.com/2010-04-01/Accounts/${options.accountSid}/Messages.json`;
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const body = new URLSearchParams({ To: message.to, Body: message.body });
    // A Messaging Service wins when both are set: it is the one that carries
    // the sender pool, and a deployment with both configured meant to use it.
    if (this.messagingServiceSid) {
      body.set('MessagingServiceSid', this.messagingServiceSid);
    } else if (this.from) {
      body.set('From', this.from);
    }

    const credentials = Buffer.from(
      `${this.accountSid}:${this.authToken}`,
      'utf8',
    ).toString('base64');

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        // A login screen must not hang on a slow gateway. Same budget as
        // Semaphore's, for the same reason.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new SmsDeliveryError(this.name, 'request failed or timed out', error);
    }

    if (!response.ok) {
      /* Twilio answers a rejection with JSON carrying `code` and `message`,
         and the code is the useful half — 21608 is "unverified number on a
         trial account", 21211 is "not a valid phone number". Read it when it
         is there and fall back to the raw body when it is not, but never let
         either mask the status. */
      const detail = await response.text().catch(() => '');
      let reason = detail.slice(0, 200);
      try {
        const parsed = JSON.parse(detail) as { code?: unknown; message?: unknown };
        if (parsed.message !== undefined) {
          reason = `${String(parsed.message)}${
            parsed.code === undefined ? '' : ` (code ${String(parsed.code)})`
          }`;
        }
      } catch {
        // Not JSON. The raw prefix above is what there is.
      }
      throw new SmsDeliveryError(
        this.name,
        `HTTP ${response.status}${reason ? `: ${reason}` : ''}`,
      );
    }

    try {
      const payload = (await response.json()) as { sid?: unknown } | null;
      const sid = payload?.sid;
      return {
        providerMessageId: sid === undefined || sid === null ? null : String(sid),
        provider: this.name,
      };
    } catch {
      // Accepted but unparseable is still accepted; do not fail a login over
      // a response body.
      return { providerMessageId: null, provider: this.name };
    }
  }
}
