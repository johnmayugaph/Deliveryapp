import { ConsoleSmsSender } from '@/lib/auth/sms/console';
import { SMS_BUILDERS } from '@/lib/auth/sms/build';
import {
  configuredSmsProvider,
  describeSmsSetup,
  devEndpointFor,
} from '@/lib/auth/sms/registry';
import type { SmsEnv, SmsSender } from '@/lib/auth/sms/types';

export type { SmsEnv, SmsMessage, SmsSender, SmsSendResult } from '@/lib/auth/sms/types';
export { SmsDeliveryError } from '@/lib/auth/sms/types';
export { ConsoleSmsSender } from '@/lib/auth/sms/console';
export { SemaphoreSmsSender } from '@/lib/auth/sms/semaphore';
export { SMS_BUILDERS } from '@/lib/auth/sms/build';
export {
  SMS_PROVIDERS,
  SMS_PROVIDER_NAMES,
  configuredSmsProvider,
  describeSmsSetup,
  isSmsProviderName,
  smsRequiredVars,
  type SmsProviderName,
  type SmsProviderSpec,
} from '@/lib/auth/sms/registry';

export class NoSmsSenderError extends Error {
  constructor() {
    super(
      'No SMS provider is configured. Set one of: ' +
        `${describeSmsSetup()}. The console sender is available in ` +
        'development only — in production it would make every login appear to ' +
        'work while nobody receives a code.',
    );
    this.name = 'NoSmsSenderError';
  }
}

/**
 * Would `resolveSmsSender` refuse, for this environment?
 *
 * The same condition, asked without building anything and without throwing,
 * so a screen can say so before a customer discovers it by pressing a button.
 * `resolveSmsSender` is written in terms of this function rather than
 * repeating the test, because the two drifting apart is exactly how a screen
 * comes to promise something the sender then refuses.
 *
 * This is the whole of the condition: no provider configured, and a production
 * runtime. It cannot see a gateway that is configured but broken — a wrong
 * key, an empty prepaid balance, a sender name that was never registered — and
 * nothing here should pretend otherwise. That failure looks like a send that
 * throws, which is a different outcome with a different message.
 */
export function smsSendingIsRefused(env: SmsEnv = process.env): boolean {
  if (configuredSmsProvider(env) !== undefined) return false;
  return env.NODE_ENV === 'production';
}

/**
 * Picks a sender from the environment.
 *
 * Two properties, in the order they matter:
 *
 * **A configured gateway always wins over the console.** Falling back to the
 * console is a development convenience and is refused in production: the
 * failure mode of a console "sender" in production is the worst kind — the
 * flow reports success and no code ever arrives.
 *
 * **The provider is read from the registry**, never named here. That is the
 * whole point of the split: this function used to spell `SEMAPHORE_API_KEY`,
 * which made "swap the gateway" a hunt through six files.
 */
export function resolveSmsSender(env: SmsEnv = process.env): SmsSender {
  const configured = configuredSmsProvider(env);

  if (configured !== undefined) {
    return SMS_BUILDERS[configured](env, devEndpointFor(configured, env));
  }

  if (smsSendingIsRefused(env)) {
    throw new NoSmsSenderError();
  }

  return new ConsoleSmsSender();
}
