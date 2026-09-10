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
 * This is the one list. It is where the variable names, the setup copy and the
 * development redirect live, so that a screen can say what is missing without
 * naming a vendor, and so that a swap is one entry rather than a hunt through
 * six files.
 *
 * There are two gateways on it, which makes the question the single-provider
 * version left open a real one: WHAT HAPPENS WHEN BOTH ARE CONFIGURED. The
 * answer is declaration order in `SMS_PROVIDER_NAMES`, first one wins, and it
 * is a precedence rather than a fallback — a send that fails is not retried
 * against the other gateway, because a login code delivered twice is worse
 * than one delivered late, and because a gateway that is down and a key that
 * is wrong are indistinguishable from here. Semaphore stays first so that a
 * deployment which had it configured before PhilSMS existed keeps the gateway
 * it was already using after an upgrade. To move to PhilSMS on such a
 * deployment, unset `SEMAPHORE_API_KEY`; leaving both set is not an error and
 * `/admin/health` shows which one is in use.
 */

/** Every gateway with an adapter. Declaration order below is precedence. */
export type SmsProviderName = 'semaphore' | 'philsms';

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
 * in the application — and a spec carrying a `build()` would drag the HTTP
 * adapter into that module graph to produce a string. This project has been
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
  philsms: {
    label: 'PhilSMS',
    /*
     * BOTH, and the sender ID is the reason this is a two-variable provider.
     * PhilSMS has no account-default sender: a send without `sender_id` is
     * refused, so a deployment holding only a token is not a gateway that
     * half-works, it is a gateway that fails on the first login. Naming both
     * here is what makes `/admin/health` say which one is missing.
     */
    requires: ['PHILSMS_API_TOKEN', 'PHILSMS_SENDER_ID'],
    optional: [],
    endpointVar: 'PHILSMS_ENDPOINT',
    fix: 'PHILSMS_API_TOKEN=… and PHILSMS_SENDER_ID=… (from app.philsms.com → Developers → API Tokens, and your approved Sender ID)',
    isConfigured: (env) => hasAll(env, ['PHILSMS_API_TOKEN', 'PHILSMS_SENDER_ID']),
  },
};

/**
 * Declaration order. What a screen listing gateways iterates, and — since
 * there is more than one — the precedence `configuredSmsProvider` applies.
 * Semaphore first, so an existing deployment's gateway does not change under
 * it on an upgrade. See the note at the top of this file.
 */
export const SMS_PROVIDER_NAMES: readonly SmsProviderName[] = ['semaphore', 'philsms'];

export function isSmsProviderName(value: string): value is SmsProviderName {
  return Object.prototype.hasOwnProperty.call(SMS_PROVIDERS, value);
}

/**
 * The gateway this deployment can actually use, or undefined.
 *
 * Singular, deliberately, and it stayed singular when the second adapter
 * arrived. A function returning an array would read as a fallback chain and is
 * not one: nothing here retries a failed send against another gateway. What
 * this answers is "which gateway does this deployment use", and the answer is
 * the first configured entry in declaration order — the decision recorded at
 * the top of this file rather than one that got taken by accident.
 */
export function configuredSmsProvider(env: SmsEnv): SmsProviderName | undefined {
  return SMS_PROVIDER_NAMES.find((name) => SMS_PROVIDERS[name].isConfigured(env));
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
  return SMS_PROVIDER_NAMES.map((name) => SMS_PROVIDERS[name].fix).join(' — or — ');
}

/** Just the variable names, for a screen that lists what is unset. */
export function smsRequiredVars(): readonly string[] {
  return SMS_PROVIDER_NAMES.flatMap((name) => SMS_PROVIDERS[name].requires);
}
