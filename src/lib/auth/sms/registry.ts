import type { SmsEnv } from '@/lib/auth/sms/types';

/**
 * Which SMS gateways this deployment knows how to use.
 *
 * `SmsSender` was written so the provider could be swapped — its own comment
 * says the gateway is "the part of this system most likely to be swapped".
 * The SEND was behind an interface; the SELECTION was not. `resolveSmsSender`,
 * `smsSendingIsRefused`, `NoSmsSenderError`'s message, the `/admin/health`
 * panel and the sentence a stranded operator reads on the login screen all
 * spelled `SEMAPHORE_API_KEY` by hand, in six files. So "swap the provider"
 * meant editing copy in places nobody would think to grep.
 *
 * This is the one list. Adding a gateway is a file like `twilio.ts` plus an
 * entry here, and the compile-enforced `Record` means it cannot be added
 * without deciding what it needs, what to tell an operator, and where a
 * development stub can redirect it.
 *
 * Why a second provider is worth the trouble at all: **OTP is the single
 * point of failure for the whole product.** No SMS means nobody signs in —
 * not a customer, not a shop, not support, not you. An expired card on the
 * gateway account locks everybody out of the application, and the only
 * evidence is sends that throw. That is the same argument as keeping a proven
 * restore rather than a dump.
 */

/** Every gateway with an adapter. A seventh forces a decision below. */
export type SmsProviderName = 'semaphore' | 'twilio';

export interface SmsProviderSpec {
  /** What a screen calls it. */
  readonly label: string;
  /**
   * Variables that must ALL be set before this provider is usable.
   *
   * Named rather than checked by a predicate so `/admin/health` can say what
   * is missing instead of only that something is.
   */
  readonly requires: readonly string[];
  /** Set-if-you-have-it variables, worth naming so nobody hunts for them. */
  readonly optional: readonly string[];
  /**
   * The development-only redirect variable.
   *
   * Every provider needs one and every one is ignored in production, for the
   * reason `SEMAPHORE_ENDPOINT` gives: a variable that can point message
   * delivery elsewhere is a way to capture login codes. Declaring it here
   * rather than reading it in each adapter is what stops the next provider
   * from quietly honouring its override in production.
   */
  readonly endpointVar: string;
  /** The line an operator is shown when nothing is configured. */
  readonly fix: string;
  /** Whether this deployment has what the provider needs. */
  isConfigured(env: SmsEnv): boolean;
}

/*
 * The BUILDERS live in `build.ts`, not here, and the split is not tidiness.
 * `describeSmsSetup()` is rendered by the login screen — the most-visited page
 * in the application — and a spec carrying a `build()` would drag both HTTP
 * adapters into that module graph to produce a string. This project has been
 * bitten by exactly that once already: the customer's tracking map failed
 * because a client component imported a list from a module that reached for
 * `next/headers`. Data here, construction there.
 */

/** All of `requires` present and non-empty. Empty string is not configured. */
function hasAll(env: SmsEnv, keys: readonly string[]): boolean {
  return keys.every((key) => {
    const value = env[key];
    return typeof value === 'string' && value.length > 0;
  });
}

export const SMS_PROVIDERS: Readonly<Record<SmsProviderName, SmsProviderSpec>> = {
  semaphore: {
    label: 'Semaphore',
    requires: ['SEMAPHORE_API_KEY'],
    optional: ['SEMAPHORE_SENDER_NAME'],
    endpointVar: 'SEMAPHORE_ENDPOINT',
    fix: 'SEMAPHORE_API_KEY=… (from semaphore.co → Account → API Keys)',
    isConfigured: (env) => hasAll(env, ['SEMAPHORE_API_KEY']),
  },
  twilio: {
    label: 'Twilio',
    /**
     * The account pair, and then one of two ways to say who it is from —
     * checked in `isConfigured` rather than listed, because "either of these"
     * is not something a flat list of required variables can express.
     */
    requires: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
    optional: ['TWILIO_FROM_NUMBER', 'TWILIO_MESSAGING_SERVICE_SID'],
    endpointVar: 'TWILIO_ENDPOINT',
    fix:
      'TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… and one of ' +
      'TWILIO_FROM_NUMBER / TWILIO_MESSAGING_SERVICE_SID',
    isConfigured: (env) =>
      hasAll(env, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']) &&
      (hasAll(env, ['TWILIO_FROM_NUMBER']) ||
        hasAll(env, ['TWILIO_MESSAGING_SERVICE_SID'])),
  },
};

/** Declaration order, used when nothing says otherwise. */
export const DEFAULT_SMS_PROVIDER_ORDER: readonly SmsProviderName[] = [
  'semaphore',
  'twilio',
];

export function isSmsProviderName(value: string): value is SmsProviderName {
  return Object.prototype.hasOwnProperty.call(SMS_PROVIDERS, value);
}

/**
 * The order to try gateways in, from `SMS_PROVIDER_ORDER`.
 *
 * Two deliberate properties, both about not losing a working gateway to a
 * typo:
 *
 *  - An unrecognised name is **ignored**, not fatal. A stray comma must not
 *    stop a login screen from working.
 *  - A configured provider the variable does not mention is **appended**
 *    rather than dropped. Otherwise `SMS_PROVIDER_ORDER=twilio` would
 *    silently disable a working Semaphore account, which is the opposite of
 *    what somebody reordering their providers means.
 */
export function smsProviderOrder(env: SmsEnv): readonly SmsProviderName[] {
  const named = (env.SMS_PROVIDER_ORDER ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(isSmsProviderName);

  const seen = new Set<SmsProviderName>(named);
  return [...named, ...DEFAULT_SMS_PROVIDER_ORDER.filter((name) => !seen.has(name))];
}

/** The providers this deployment can actually use, in order. */
export function configuredSmsProviders(env: SmsEnv): readonly SmsProviderName[] {
  return smsProviderOrder(env).filter((name) => SMS_PROVIDERS[name].isConfigured(env));
}

/**
 * The development redirect for one provider, or undefined.
 *
 * One place, so a new adapter cannot forget the production rule.
 */
export function devEndpointFor(
  name: SmsProviderName,
  env: SmsEnv,
): string | undefined {
  if (env.NODE_ENV === 'production') return undefined;
  return env[SMS_PROVIDERS[name].endpointVar] || undefined;
}

/**
 * What to tell somebody who has configured nothing.
 *
 * Derived from the registry, so a provider added above appears here without
 * anybody remembering to mention it.
 */
export function describeSmsSetup(): string {
  return DEFAULT_SMS_PROVIDER_ORDER.map((name) => SMS_PROVIDERS[name].fix).join(
    ' — or — ',
  );
}

/** Just the variable names, for a screen that lists what is unset. */
export function smsRequiredVars(): readonly string[] {
  return DEFAULT_SMS_PROVIDER_ORDER.flatMap((name) => SMS_PROVIDERS[name].requires);
}
