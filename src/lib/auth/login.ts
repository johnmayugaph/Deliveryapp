import { prisma } from '@/lib/prisma';
import { InvalidPhoneNumberError, normalisePhilippineMobile } from '@/lib/auth/phone';
import { requestLoginCode, verifyLoginCode } from '@/lib/auth/otp';
import {
  SMS_NOT_CONFIGURED_MESSAGE,
  THROTTLE_MESSAGES,
  VERIFY_FAILURE_MESSAGES,
} from '@/lib/auth/otp-policy';
import { ensureWallet } from '@/lib/wallet/ledger';
import { SIGN_IN_REFUSED_MESSAGE, signInIsPermitted } from '@/lib/demo/policy';
import { verifyLoginChallenge, type CaptchaVerifier } from '@/lib/auth/captcha';
import { redeemStoreInvites } from '@/lib/merchant/staff';

/**
 * The login flow's orchestration, as plain functions.
 *
 * Deliberately NOT server actions. A `'use server'` export is a server
 * *reference*, and calling one from another action loses the request scope that
 * `headers()` and `cookies()` need — which showed up as "`headers` was called
 * outside a request scope" the first time the form action reused the
 * single-purpose actions. Request-scoped values are read in the action and
 * passed in here as arguments, so this module has no hidden dependency on
 * being inside a request at all.
 */

export type SendCodeResult =
  | { ok: true; phone: string; expiresAt: Date }
  | { ok: false; message: string; retryAfterSeconds?: number };

export async function sendLoginCode(input: {
  rawPhone: string;
  clientIp?: string | undefined;
  /** The CAPTCHA token from the form, when this deployment asks for one. */
  captchaToken?: string | undefined;
  /** Injected by tests. */
  captchaVerifier?: CaptchaVerifier | null;
}): Promise<SendCodeResult> {
  let phone: string;
  try {
    phone = normalisePhilippineMobile(input.rawPhone);
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      return { ok: false, message: 'Enter your mobile number, e.g. 0917 123 4567.' };
    }
    throw error;
  }

  /**
   * The CAPTCHA is checked BEFORE the number is looked at any further, and
   * before anything is written or sent.
   *
   * Order matters for two reasons. It is the only ordering in which a refused
   * request costs nothing — no row, no gateway call, no peso — and it is the
   * only one that keeps the no-enumeration property: a bot that fails the
   * check learns nothing about the number it tried, because nothing about the
   * number was consulted.
   */
  const challenge = await verifyLoginChallenge({
    token: input.captchaToken,
    clientIp: input.clientIp,
    ...(input.captchaVerifier === undefined
      ? {}
      : { verifier: input.captchaVerifier }),
  });
  if (!challenge.allowed) {
    return { ok: false, message: challenge.message };
  }

  const outcome = await requestLoginCode({ rawPhone: phone, clientIp: input.clientIp });

  if ('throttled' in outcome && outcome.throttled.reason) {
    return {
      ok: false,
      message: THROTTLE_MESSAGES[outcome.throttled.reason],
      ...(outcome.throttled.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: outcome.throttled.retryAfterSeconds }
        : {}),
    };
  }

  // A misconfigured deployment and a gateway that dropped one message are both
  // "the code did not go out", and telling them apart is the difference
  // between a person waiting a minute and a person waiting forever.
  if ('notConfigured' in outcome) {
    return { ok: false, message: SMS_NOT_CONFIGURED_MESSAGE };
  }

  if (!outcome.ok) {
    return { ok: false, message: 'The code could not be sent. Try again in a moment.' };
  }

  return { ok: true, phone: outcome.phone, expiresAt: outcome.expiresAt };
}

export type CheckCodeResult =
  | { ok: true; userId: string; needsOnboarding: boolean }
  | { ok: false; message: string };

/**
 * Verifies a code and returns the account it belongs to, creating that account
 * if this is the first time we have seen the number.
 *
 * The `User` is created here, at the moment the number is proven, with no name
 * — `fullName` is nullable precisely so this record can be honest about what it
 * knows. Creating the session is the caller's job, because that needs cookies.
 */
export async function checkLoginCode(input: {
  rawPhone: string;
  code: string;
}): Promise<CheckCodeResult> {
  let phone: string;
  try {
    phone = normalisePhilippineMobile(input.rawPhone);
  } catch {
    return { ok: false, message: 'Enter your number again.' };
  }

  const digits = input.code.replace(/\D/g, '');
  if (digits.length !== 6) {
    return { ok: false, message: 'The code is six digits.' };
  }

  const result = await verifyLoginCode({ rawPhone: phone, code: digits });
  if (!result.ok) {
    return { ok: false, message: VERIFY_FAILURE_MESSAGES[result.failure] };
  }

  const now = new Date();
  const user = await prisma.user.upsert({
    where: { phone },
    create: { phone, phoneVerifiedAt: now },
    // Signing in only records that the number is (still) verified; nothing else
    // about an existing account is touched.
    update: { phoneVerifiedAt: now },
  });

  if (!signInIsPermitted(user)) {
    // Blocked, or a demo account on a production deployment. Say nothing about
    // which: somebody who happens to own a seeded number learns nothing from
    // this screen, and support has the console for the real answer.
    return { ok: false, message: SIGN_IN_REFUSED_MESSAGE };
  }

  // Every account has a credits ledger from the start, so nothing later has to
  // check whether one exists before granting a promo.
  await ensureWallet(user.id);

  // Any store access offered to this NUMBER becomes real here, and here is the
  // only honest place for it: the OTP has just proved who holds the SIM, which
  // is exactly what a `StoreInvite` is a grant to. It never throws — a login
  // that failed because of a shop invitation would be baffling to the person it
  // happened to, and the invite simply stays live for their next attempt.
  await redeemStoreInvites({ userId: user.id, phone });

  return { ok: true, userId: user.id, needsOnboarding: user.onboardedAt === null };
}

/**
 * Same-site paths only. An open redirect on a login page turns it into a
 * phishing tool: a link to our own domain that lands on someone else's.
 */
export function safeNextPath(next: string | undefined): string {
  if (!next) return '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return '/';
  }
  return next;
}
