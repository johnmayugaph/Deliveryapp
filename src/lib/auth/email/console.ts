import type { EmailMessage, EmailSender, EmailSendResult } from '@/lib/auth/email/types';
import { maskEmail } from '@/lib/auth/email/address';

/**
 * Development sender: prints the message to the server console.
 *
 * Refused in production by `resolveEmailSender`, for the same reason the
 * console SMS sender is: a "sender" that delivers to a terminal nobody reads
 * would make every recovery appear to work while nobody ever gets a code —
 * and unlike a failed login, a failed recovery has no second route.
 */
export class ConsoleEmailSender implements EmailSender {
  readonly name = 'console';

  async send(message: EmailMessage): Promise<EmailSendResult> {
    console.info(
      [
        '',
        '  ┌─ EMAIL (development) ───────────────────────────',
        `  │ to:      ${message.to}  (${maskEmail(message.to)})`,
        `  │ subject: ${message.subject}`,
        '  │',
        ...message.body.split('\n').map((line) => `  │ ${line}`),
        '  └─────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
    return { providerMessageId: null, provider: this.name };
  }
}
