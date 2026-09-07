import { ConsoleEmailSender } from '@/lib/auth/email/console';
import { ResendEmailSender } from '@/lib/auth/email/resend';
import type { EmailSender } from '@/lib/auth/email/types';

export type { EmailMessage, EmailSender, EmailSendResult } from '@/lib/auth/email/types';
export { EmailDeliveryError } from '@/lib/auth/email/types';
export { ConsoleEmailSender } from '@/lib/auth/email/console';
export { ResendEmailSender } from '@/lib/auth/email/resend';
export {
  InvalidEmailAddressError,
  MAX_EMAIL_LENGTH,
  maskEmail,
  normaliseEmail,
  tryNormaliseEmail,
} from '@/lib/auth/email/address';

export class NoEmailSenderError extends Error {
  constructor() {
    super(
      'No email provider is configured, so account recovery by email is off. ' +
        'Set RESEND_API_KEY and EMAIL_FROM to turn it on. The console sender ' +
        'is available in development only — in production it would make every ' +
        'recovery appear to work while nobody receives a code, and unlike a ' +
        'failed login a failed recovery has no second route.',
    );
    this.name = 'NoEmailSenderError';
  }
}

/** Just the variables sender selection reads. */
export interface EmailEnv {
  RESEND_API_KEY?: string | undefined;
  EMAIL_FROM?: string | undefined;
  /**
   * Redirects mail to another host. For pointing at a local stub in
   * development; IGNORED when NODE_ENV=production, because a variable that can
   * redirect message delivery is a way to capture recovery codes.
   */
  RESEND_ENDPOINT?: string | undefined;
  NODE_ENV?: string | undefined;
  [key: string]: string | undefined;
}

/**
 * Picks a sender from the environment.
 *
 * A configured provider always wins. Falling back to the console is a
 * development convenience and is refused in production.
 *
 * Both variables are required together: a key with no From address cannot
 * send, and a From address with no key is a setting that does nothing. Half a
 * configuration is the state that looks configured and is not.
 */
export function resolveEmailSender(env: EmailEnv = process.env): EmailSender {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;

  if (apiKey && from) {
    const override = env.NODE_ENV === 'production' ? undefined : env.RESEND_ENDPOINT;
    return override
      ? new ResendEmailSender(apiKey, from, override)
      : new ResendEmailSender(apiKey, from);
  }

  if (env.NODE_ENV === 'production') {
    throw new NoEmailSenderError();
  }

  return new ConsoleEmailSender();
}

/** Whether recovery by email can be offered at all. */
export function isEmailConfigured(env: EmailEnv = process.env): boolean {
  try {
    resolveEmailSender(env);
    return true;
  } catch {
    return false;
  }
}
