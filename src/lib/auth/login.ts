import { prisma } from '@/lib/prisma';
import { InvalidPhoneNumberError, normalisePhilippineMobile } from '@/lib/auth/phone';
import { requestLoginCode, verifyLoginCode } from '@/lib/auth/otp';
import { THROTTLE_MESSAGES, VERIFY_FAILURE_MESSAGES } from '@/lib/auth/otp-policy';
import { ensureWallet } from '@/lib/wallet/ledger';

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
}): Promise<SendCodeResult> {
  let phone: string;
  try {
    phone = normalisePhilippineMobile(input.rawPhone);
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      return { ok: false, message: 'Ilagay ang mobile number mo, hal. 0917 123 4567.' };
    }
    throw error;
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

  if (!outcome.ok) {
    return { ok: false, message: 'Hindi napadala ang code. Subukan muli maya-maya.' };
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
    return { ok: false, message: 'Ilagay muli ang number mo.' };
  }

  const digits = input.code.replace(/\D/g, '');
  if (digits.length !== 6) {
    return { ok: false, message: 'Anim na numero ang code.' };
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

  if (user.isBlocked) {
    // Say nothing about why. Support handles it.
    return { ok: false, message: 'Hindi ma-access ang account na ito. Kontakin ang support.' };
  }

  // Every account has a credits ledger from the start, so nothing later has to
  // check whether one exists before granting a promo.
  await ensureWallet(user.id);

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
