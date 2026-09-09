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
 * This is the one list. There is exactly one gateway on it today. That is not
 * an oversight and this file is not scaffolding for a second: it is where the
 * variable names, the setup copy and the development redirect live, so that a
 * screen can say what is missing without naming a vendor, and so that a swap
 * is one entry rather than a hunt through six files.
 */

/** Every gateway with an adapter. A second forces the decisions below. */
export type SmsProviderName = 'semaphore';

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
};

/** Declaration order. What a screen listing gateways iterates. */
export const SMS_PROVIDER_NAMES: readonly SmsProviderName[] = ['semaphore'];

export function isSmsProviderName(value: string): value is SmsProviderName {
  return Object.prototype.hasOwnProperty.call(SMS_PROVIDERS, value);
}

/**
 * The gateway this deployment can actually use, or undefined.
 *
 * Singular, deliberately. With one adapter there is nothing to order and
 * nothing to fall back to, and a function returning an array would let a
 * second gateway be added later and then silently ignored — the first entry
 * used, the rest dead. Adding one has to change this signature, which makes
 * "what happens when two are configured" a decision somebody takes rather
 * than one that gets taken for them.
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
