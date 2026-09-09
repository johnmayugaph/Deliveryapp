import type { PhoneVerification } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { normalisePhilippineMobile } from '@/lib/auth/phone';
import {
  generateLoginCode,
  hashClientIp,
  hashLoginCode,
  loginCodeMatches,
} from '@/lib/auth/crypto';
import {
  CODE_TTL_SECONDS,
  checkCodeUsable,
  evaluateThrottle,
  IP_WINDOW_SECONDS,
  MAX_CODES_PER_IP,
  PHONE_WINDOW_SECONDS,
  type ThrottleDecision,
  type VerifyFailure,
} from '@/lib/auth/otp-policy';
import { NoSmsSenderError, resolveSmsSender, type SmsSender } from '@/lib/auth/sms';

/**
 * Login codes: requesting, and verifying.
 *
 * The policy in `./otp-policy.ts` decides; this module carries out the decision
 * against the database and the SMS gateway. Splitting them is what lets every
 * limit be tested exhaustively without Postgres.
 *
 * Note what this module deliberately does NOT do: it never reports whether a
 * phone number already has an account. A login and a signup are the same
 * request, and the response is identical either way, so the form cannot be used
 * to enumerate customers.
 */

export type RequestCodeOutcome =
  | { ok: true; phone: string; expiresAt: Date }
  | { ok: false; throttled: ThrottleDecision }
  /**
   * This deployment has no SMS gateway at all, so no code can be sent to
   * anybody. Kept apart from `deliveryFailed` because the two need opposite
   * words: a delivery failure is worth retrying in a moment, and this is not
   * worth retrying until somebody changes the configuration.
   */
  | { ok: false; notConfigured: true }
  | { ok: false; deliveryFailed: true };

export interface RequestCodeInput {
  /** Whatever the person typed; normalised here. */
  rawPhone: string;
  /** Client address, for the per-source throttle. Hashed before storage. */
  clientIp?: string;
  now?: Date;
  sender?: SmsSender;
}

function messageBody(code: string): string {
  // Short, names the app, and says the two things that matter: the code, and
  // that we will never ask for it.
  return `${code} is your TARA code. Do not share it with anyone. It expires in 5 minutes.`;
}

/**
 * Issues a code and sends it.
 *
 * Any previous unconsumed code for the number is invalidated first, so "most
 * recent code wins" — otherwise a person who requested twice would find the
 * newer code rejected while the older one still worked, which is both confusing
 * and a larger window for an attacker.
 */
export async function requestLoginCode(
  input: RequestCodeInput,
): Promise<RequestCodeOutcome> {
  const phone = normalisePhilippineMobile(input.rawPhone);
  const now = input.now ?? new Date();
  const ipHash = input.clientIp ? hashClientIp(input.clientIp) : null;

  /**
   * The gateway is resolved FIRST — before the throttle is read, before
   * anything is written, and inside a `try` — because on a deployment with no
   * gateway configured `resolveSmsSender` throws rather than returning.
   *
   * It used to be resolved on the line above the send, after the
   * `PhoneVerification` row had been created and outside the `catch` below.
   * A production deployment whose operator had not yet configured a gateway
   * therefore answered the very first thing anybody does on it — ask for a
   * login code — with a 500 and "something on our side broke, not anything
   * you did", and left an unconsumed row behind that could start a cooldown
   * against the honest retry. The message on `NoSmsSenderError` says exactly
   * what to set, and reached nobody.
   *
   * Refusing here consults nothing about the number, so it costs no row, no
   * query and no peso, and it still tells a bot nothing about the number it
   * tried.
   */
  let sender: SmsSender;
  try {
    sender = input.sender ?? resolveSmsSender();
  } catch (error) {
    if (error instanceof NoSmsSenderError) {
      // The operator-facing sentence, in the one place an operator can read
      // it: this deployment's log. The customer gets different words.
      console.error(`requestLoginCode: no code was issued. ${error.message}`);
      return { ok: false, notConfigured: true };
    }
    throw error;
  }

  const [recentForPhone, recentForIpCount] = await Promise.all([
    prisma.phoneVerification.findMany({
      where: { phone, createdAt: { gte: new Date(now.getTime() - PHONE_WINDOW_SECONDS * 1000) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    ipHash
      ? prisma.phoneVerification.count({
          where: {
            requestIpHash: ipHash,
            createdAt: { gte: new Date(now.getTime() - IP_WINDOW_SECONDS * 1000) },
          },
        })
      : Promise.resolve(0),
  ]);

  const decision = evaluateThrottle({
    now,
    recentForPhone: recentForPhone.map((row) => row.createdAt),
    recentForIpCount,
  });
  if (!decision.allowed) {
    return { ok: false, throttled: decision };
  }

  const code = generateLoginCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000);

  // Invalidate outstanding codes, then issue, in one transaction: two codes
  // alive at once means two chances to guess.
  const verification = await prisma.$transaction(async (tx) => {
    await tx.phoneVerification.updateMany({
      where: { phone, consumedAt: null },
      data: { consumedAt: now },
    });
    return tx.phoneVerification.create({
      data: {
        phone,
        codeHash: hashLoginCode(code),
        expiresAt,
        requestIpHash: ipHash,
      },
    });
  });

  try {
    await sender.send({ to: phone, body: messageBody(code) });
  } catch (error) {
    // Consume the code we could not deliver, so it does not sit there usable,
    // and so the cooldown does not block an immediate honest retry.
    await prisma.phoneVerification.update({
      where: { id: verification.id },
      data: { consumedAt: now },
    });
    console.error('requestLoginCode: delivery failed', error);
    return { ok: false, deliveryFailed: true };
  }

  return { ok: true, phone, expiresAt };
}

export type VerifyCodeOutcome =
  | { ok: true; phone: string; verificationId: string }
  | { ok: false; failure: VerifyFailure };

export interface VerifyCodeInput {
  rawPhone: string;
  code: string;
  now?: Date;
}

/**
 * Checks a submitted code.
 *
 * A wrong guess increments the attempt counter even when the code has already
 * expired or been used — the counter is what stops a script grinding through
 * a number's codes, and exempting dead codes would give it free tries.
 *
 * On success the code is consumed in the same update that matched it, guarded
 * on `consumedAt: null`, so two simultaneous submissions cannot both win.
 */
export async function verifyLoginCode(input: VerifyCodeInput): Promise<VerifyCodeOutcome> {
  const phone = normalisePhilippineMobile(input.rawPhone);
  const now = input.now ?? new Date();
  const submitted = input.code.replace(/\s/g, '');

  const latest: PhoneVerification | null = await prisma.phoneVerification.findFirst({
    where: { phone },
    orderBy: { createdAt: 'desc' },
  });

  const usable = checkCodeUsable(latest, now);
  if (!usable.usable) {
    // Still charge an attempt against a live-but-unusable record, so repeatedly
    // poking an expired code is not free.
    if (latest && latest.consumedAt === null) {
      await prisma.phoneVerification.update({
        where: { id: latest.id },
        data: { attempts: { increment: 1 } },
      });
    }
    return { ok: false, failure: usable.failure };
  }

  const record = latest!;

  if (!loginCodeMatches(submitted, record.codeHash)) {
    await prisma.phoneVerification.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, failure: 'WRONG_CODE' };
  }

  // Single use, enforced by the guard rather than by reading first.
  const consumed = await prisma.phoneVerification.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count === 0) {
    return { ok: false, failure: 'ALREADY_USED' };
  }

  return { ok: true, phone, verificationId: record.id };
}

/** Exposed for the per-IP throttle ceiling in UI copy. */
export { MAX_CODES_PER_IP };

export { pruneVerifications } from '@/lib/auth/prune';
