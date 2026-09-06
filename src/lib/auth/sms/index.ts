import { ConsoleSmsSender } from '@/lib/auth/sms/console';
import { SemaphoreSmsSender } from '@/lib/auth/sms/semaphore';
import type { SmsSender } from '@/lib/auth/sms/types';

export type { SmsMessage, SmsSender, SmsSendResult } from '@/lib/auth/sms/types';
export { SmsDeliveryError } from '@/lib/auth/sms/types';
export { ConsoleSmsSender } from '@/lib/auth/sms/console';
export { SemaphoreSmsSender } from '@/lib/auth/sms/semaphore';

export class NoSmsSenderError extends Error {
  constructor() {
    super(
      'No SMS provider is configured. Set SEMAPHORE_API_KEY (and optionally ' +
        'SEMAPHORE_SENDER_NAME) to send real messages. The console sender is ' +
        'available in development only — in production it would make every login ' +
        'appear to work while nobody receives a code.',
    );
    this.name = 'NoSmsSenderError';
  }
}

/**
 * Picks a sender from the environment.
 *
 * A configured gateway always wins. Falling back to the console is a
 * development convenience and is refused in production: the failure mode of a
 * console "sender" in production is the worst kind — the flow reports success
 * and no code ever arrives.
 */
/** Just the variables sender selection reads. */
export interface SmsEnv {
  SEMAPHORE_API_KEY?: string | undefined;
  SEMAPHORE_SENDER_NAME?: string | undefined;
  NODE_ENV?: string | undefined;
  /** Present so `process.env` satisfies this type structurally. */
  [key: string]: string | undefined;
}

export function resolveSmsSender(env: SmsEnv = process.env): SmsSender {
  const apiKey = env.SEMAPHORE_API_KEY;
  if (apiKey) {
    return new SemaphoreSmsSender(apiKey, env.SEMAPHORE_SENDER_NAME);
  }

  if (env.NODE_ENV === 'production') {
    throw new NoSmsSenderError();
  }

  return new ConsoleSmsSender();
}
