import { TurnstileVerifier } from '@/lib/auth/captcha/turnstile';
import type { CaptchaVerdict, CaptchaVerifier } from '@/lib/auth/captcha/types';

export type {
  CaptchaChallenge,
  CaptchaVerdict,
  CaptchaVerifier,
} from '@/lib/auth/captcha/types';
export { TurnstileVerifier } from '@/lib/auth/captcha/turnstile';

/**
 * Whether a login has to prove it came from a person, and what happens when
 * that proof cannot be obtained.
 *
 * The rate limits already in `otp-policy.ts` are the first defence and they
 * hold against a careless script: three codes per number per fifteen minutes,
 * twelve per address per hour. What they do not hold against is somebody with a
 * list of numbers and a few hundred addresses, and every request that gets
 * through costs a peso of ours. That is what this is for.
 *
 * It is NOT for account security. The boundary on an account is the code sent
 * to a phone somebody physically holds; a CAPTCHA adds nothing to it. Reading
 * this as a security control rather than a cost control is what leads to
 * failing closed on a Cloudflare outage, which trades a small unbounded risk
 * for a large certain one.
 */

/** Just the variables verifier selection reads. */
export interface CaptchaEnv {
  TURNSTILE_SECRET_KEY?: string | undefined;
  /**
   * The widget's public half. Read here as well as on the page, because a
   * secret with no site key is a deployment where the widget never renders,
   * nobody can produce a token, and — if this module treated that as
   * "configured" — nobody could sign in at all.
   */
  NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string | undefined;
  /**
   * Redirects verification to another host. Ignored in production on purpose,
   * exactly as `SEMAPHORE_ENDPOINT` is: a variable that can point the check
   * somewhere else is a way to make every check pass, and no legitimate
   * production deployment needs it.
   */
  TURNSTILE_ENDPOINT?: string | undefined;
  NODE_ENV?: string | undefined;
  /** Present so `process.env` satisfies this type structurally. */
  [key: string]: string | undefined;
}

/**
 * Whether both halves of a key pair are present.
 *
 * Both, deliberately. Half a pair is a misconfiguration, and the safe reading
 * of a misconfiguration here is "not switched on" rather than "refuse
 * everybody": the rate limits are still in force either way, so treating it as
 * off leaves the deployment exactly as protected as it was yesterday, while
 * treating it as on would lock every customer out.
 */
export function isCaptchaConfigured(env: CaptchaEnv = process.env): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY && env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
}

/** Set on one side only — worth saying out loud on the health page. */
export function captchaIsHalfConfigured(env: CaptchaEnv = process.env): boolean {
  const secret = Boolean(env.TURNSTILE_SECRET_KEY);
  const site = Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  return secret !== site;
}

/** The verifier, or null when this deployment has no CAPTCHA. */
export function resolveCaptchaVerifier(
  env: CaptchaEnv = process.env,
): CaptchaVerifier | null {
  if (!isCaptchaConfigured(env)) return null;

  const override = env.NODE_ENV === 'production' ? undefined : env.TURNSTILE_ENDPOINT;
  return override
    ? new TurnstileVerifier(env.TURNSTILE_SECRET_KEY!, override)
    : new TurnstileVerifier(env.TURNSTILE_SECRET_KEY!);
}

export type ChallengeDecision =
  | { allowed: true; reason: 'NOT_CONFIGURED' | 'PASSED' | 'VERIFIER_UNAVAILABLE' }
  | { allowed: false; message: string };

/**
 * What the person sees when the check refuses them.
 *
 * Says what to do, and does not accuse: the overwhelming majority of refusals
 * are an expired token from a page left open, not an attack. Somebody actually
 * running a script does not read this at all.
 */
export const CAPTCHA_REJECTED_MESSAGE =
  'That security check expired. Reload the page and try again.';

/**
 * With a CAPTCHA configured, a request with no token at all.
 *
 * Reachable without anybody doing anything wrong: the widget needs JavaScript,
 * and this app deliberately lets the first login step post before the page has
 * hydrated. So the message names the cause rather than blaming the person.
 */
export const CAPTCHA_MISSING_MESSAGE =
  'The security check has not finished loading. Wait a moment and try again.';

/**
 * The gate in front of sending a login code.
 *
 * Four outcomes, and the last one is the interesting decision:
 *
 *  - no CAPTCHA configured — allowed, and the rate limits carry the load, which
 *    is exactly the position this deployment was in before this existed;
 *  - a token that checks out — allowed;
 *  - a token that is missing, or that Cloudflare rejects — REFUSED. A rejected
 *    token is real evidence, and this is the case the feature exists for;
 *  - the verifier could not be reached — ALLOWED, and logged.
 *
 * That last one is a deliberate choice to fail OPEN, and it is worth being
 * explicit about because the instinct in this codebase is the opposite. Failing
 * closed would mean an outage at Cloudflare stops every customer in the country
 * from ordering dinner, stops every rider earning, and stops every store
 * selling — to prevent an attacker from spending SMS credit that three
 * independent rate limits still cap. That is trading a bounded cost for an
 * unbounded one. It is the right call precisely BECAUSE this is not an
 * authentication control: nobody gets into an account without the code.
 */
export async function verifyLoginChallenge(input: {
  token: string | undefined;
  clientIp?: string | undefined;
  /** Injected by tests; resolved from the environment otherwise. */
  verifier?: CaptchaVerifier | null;
  env?: CaptchaEnv;
}): Promise<ChallengeDecision> {
  const verifier =
    input.verifier === undefined
      ? resolveCaptchaVerifier(input.env ?? process.env)
      : input.verifier;

  if (verifier === null) {
    return { allowed: true, reason: 'NOT_CONFIGURED' };
  }

  const token = input.token?.trim();
  if (!token) {
    return { allowed: false, message: CAPTCHA_MISSING_MESSAGE };
  }

  const verdict: CaptchaVerdict = await verifier.verify({
    token,
    clientIp: input.clientIp,
  });

  if (verdict.outcome === 'PASSED') {
    return { allowed: true, reason: 'PASSED' };
  }

  if (verdict.outcome === 'UNAVAILABLE') {
    // Loud, because a deployment running with its CAPTCHA effectively off
    // should not discover that from an SMS bill.
    console.error(
      `captcha: ${verdict.provider} unavailable (${verdict.reason}) — ` +
        'allowing the request; rate limits still apply',
    );
    return { allowed: true, reason: 'VERIFIER_UNAVAILABLE' };
  }

  console.warn(
    `captcha: ${verdict.provider} rejected a token` +
      (verdict.codes.length > 0 ? ` (${verdict.codes.join(', ')})` : ''),
  );
  return { allowed: false, message: CAPTCHA_REJECTED_MESSAGE };
}
