import type { SmsMessage, SmsSender, SmsSendResult } from '@/lib/auth/sms/types';
import { maskPhilippineMobile } from '@/lib/auth/phone';

/**
 * Development sender: prints the message to the server console.
 *
 * This is how the login flow works on a laptop with no gateway account. It
 * refuses to be selected in production — see `resolveSmsSender` — because a
 * "sender" that delivers to a terminal nobody reads would let every login
 * silently fail while appearing to work.
 */
export class ConsoleSmsSender implements SmsSender {
  readonly name = 'console';

  async send(message: SmsMessage): Promise<SmsSendResult> {
    console.info(
      [
        '',
        '  ┌─ SMS (development) ─────────────────────────────',
        `  │ to:   ${message.to}  (${maskPhilippineMobile(message.to)})`,
        `  │ body: ${message.body}`,
        '  └─────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
    return { providerMessageId: null, provider: this.name };
  }
}
