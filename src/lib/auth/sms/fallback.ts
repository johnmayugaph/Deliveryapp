import {
  SmsDeliveryError,
  type SmsMessage,
  type SmsSender,
  type SmsSendResult,
} from '@/lib/auth/sms/types';

/**
 * Tries each gateway in turn and stops at the first that accepts.
 *
 * The argument for this existing at all: **an SMS outage is a total outage.**
 * Every session in the application starts with a code sent over one gateway,
 * so a lapsed card on that account, a suspended sender name or an hour of
 * provider downtime locks out customers, shops, riders and support at the
 * same time — and the only symptom is sends that throw. Everything else in
 * this system degrades; this stops.
 *
 * ### The cost, which is real and is not hidden
 *
 * A gateway that **accepts the message and then fails to answer** gets
 * retried, because a timeout is indistinguishable from a refusal from this
 * side. So a customer can receive the same code twice and TARA pays for two
 * messages.
 *
 * That is the right trade in this direction, and it is worth being precise
 * about why it is not a security problem: the OTP is generated and stored
 * BEFORE any send, so both messages carry the same code, against the same
 * single-use record, with the same expiry and the same attempt counter. Two
 * identical texts are an annoyance and a few centavos. The alternative —
 * giving up on the first timeout — is somebody who cannot sign in.
 *
 * ### What it does not do
 *
 * No round-robin, no load balancing, no health tracking between calls. The
 * order is the configured order every time. A cleverer policy would need
 * state, and state that decides whether logins work is a thing to add when
 * there is evidence for it rather than on the first day.
 */
export class FallbackSmsSender implements SmsSender {
  readonly name: string;

  constructor(private readonly senders: readonly SmsSender[]) {
    if (senders.length === 0) {
      throw new Error('FallbackSmsSender needs at least one sender');
    }
    // Names itself after the chain, so a log line says what was actually
    // arranged rather than the word "fallback".
    this.name = senders.map((sender) => sender.name).join('→');
  }

  /** The chain, in order. For `/admin/health` and for tests. */
  get providers(): readonly string[] {
    return this.senders.map((sender) => sender.name);
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    const failures: string[] = [];

    for (const sender of this.senders) {
      try {
        // Returns the inner result untouched, so `provider` names the gateway
        // that actually delivered rather than the chain that was tried. That
        // is the field support reads off a log line.
        return await sender.send(message);
      } catch (error) {
        failures.push(
          `${sender.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Every gateway refused. Carry all the reasons: with one provider the
    // message was the answer, and with two "SMS failed" without saying which
    // and why is an hour of somebody's evening.
    throw new SmsDeliveryError(
      this.name,
      `every configured gateway refused — ${failures.join(' | ')}`,
    );
  }
}
