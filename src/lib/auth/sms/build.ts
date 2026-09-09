import { SemaphoreSmsSender } from '@/lib/auth/sms/semaphore';
import { TwilioSmsSender } from '@/lib/auth/sms/twilio';
import { type SmsProviderName } from '@/lib/auth/sms/registry';
import type { SmsEnv, SmsSender } from '@/lib/auth/sms/types';

/**
 * How to construct each gateway.
 *
 * Kept apart from `registry.ts` so a screen can read the provider LIST and the
 * setup copy without pulling two HTTP adapters into its bundle — see the note
 * there. Compile-enforced over `SmsProviderName` in the same way, so a
 * provider added to the registry cannot ship without a builder.
 *
 * `endpoint` arrives already resolved and already production-safe: the
 * development redirect is decided once, in `devEndpointFor`, rather than read
 * by each adapter. That is what stops the next gateway from quietly honouring
 * its own override in production and turning a variable into a way to capture
 * login codes.
 */
export const SMS_BUILDERS: Readonly<
  Record<SmsProviderName, (env: SmsEnv, endpoint: string | undefined) => SmsSender>
> = {
  semaphore: (env, endpoint) =>
    endpoint
      ? new SemaphoreSmsSender(
          env.SEMAPHORE_API_KEY!,
          env.SEMAPHORE_SENDER_NAME,
          endpoint,
        )
      : new SemaphoreSmsSender(env.SEMAPHORE_API_KEY!, env.SEMAPHORE_SENDER_NAME),

  twilio: (env, endpoint) =>
    new TwilioSmsSender({
      accountSid: env.TWILIO_ACCOUNT_SID!,
      authToken: env.TWILIO_AUTH_TOKEN!,
      from: env.TWILIO_FROM_NUMBER,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
      ...(endpoint ? { endpoint } : {}),
    }),
};
