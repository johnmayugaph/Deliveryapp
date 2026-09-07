import { EmailCodePurpose } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  generateLoginCode,
  hashClientIp,
  hashLoginCode,
  loginCodeMatches,
} from '@/lib/auth/crypto';
import {
  CODE_TTL_SECONDS,
  MAX_CODES_PER_IP,
  THROTTLE_MESSAGES,
  VERIFY_FAILURE_MESSAGES,
  checkCodeUsable,
  evaluateThrottle,
  type VerifyFailure,
} from '@/lib/auth/otp-policy';
import { normaliseEmail } from '@/lib/auth/email/address';
import { resolveEmailSender } from '@/lib/auth/email';
import { EmailDeliveryError } from '@/lib/auth/email/types';

/**
 * Codes sent to an email address.
 *
 * Shares the policy module with login codes rather than restating it: the same
 * five-minute expiry, the same five-guess ceiling, the same three throttles.
 * That is not laziness — a recovery code with weaker rules than a login code
 * would be the cheaper way in, and two sets of constants drift.
 *
 * What is different is `purpose`. A code minted to confirm an address must not
 * be usable to move a phone number, and the other way round, so the purpose is
 * part of the lookup and not just a label. Without it, a person who verifies
 * their address has, for five minutes, a code that could recover their account
 * — which is exactly the window an attacker who reads one email wants.
 */

/** Same shape as the login-code outcome, so the callers read the same. */
export type EmailCodeOutcome =
  | { ok: true; expiresAt: Date }
  | { ok: false; message: string; retryAfterSeconds?: number };

export interface SendEmailCodeInput {
  email: string;
  purpose: EmailCodePurpose;
  /** For the per-source throttle. Hashed, never stored raw. */
  requestIp?: string | undefined;
  now?: Date;
}

/** What each purpose says in the subject line and the body. */
const COPY: Readonly<Record<EmailCodePurpose, { subject: string; line: string }>> = {
  [EmailCodePurpose.VERIFY_ADDRESS]: {
    subject: 'Confirm this address for TARA',
    line: 'Use this code to confirm this email address on your TARA account.',
  },
  [EmailCodePurpose.ACCOUNT_RECOVERY]: {
    subject: 'Recover your TARA account',
    line:
      'Use this code to start moving your TARA account to a new phone number. ' +
      'If you did not ask for this, ignore it — nothing changes until the code ' +
      'is used, and whoever has it still needs a phone number you would then ' +
      'be told about.',
  },
};

/**
 * Mints a code and sends it.
 *
 * Never says whether the address belongs to an account. That check is the
 * caller's, and the caller is expected to report the same thing either way —
 * an endpoint that answers differently for a known address is an endpoint that
 * enumerates customers.
 */
export async function sendEmailCode(
  input: SendEmailCodeInput,
): Promise<EmailCodeOutcome> {
  const now = input.now ?? new Date();
  const email = normaliseEmail(input.email);
  const ipHash = input.requestIp ? hashClientIp(input.requestIp) : undefined;

  const [recent, recentForIpCount] = await Promise.all([
    prisma.emailVerification.findMany({
      where: { email, purpose: input.purpose },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { createdAt: true },
    }),
    ipHash
      ? prisma.emailVerification.count({
          where: {
            requestIpHash: ipHash,
            createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
          },
        })
      : Promise.resolve(0),
  ]);

  const throttle = evaluateThrottle({
    now,
    recentForPhone: recent.map((row) => row.createdAt),
    recentForIpCount,
  });
  if (!throttle.allowed) {
    return {
      ok: false,
      message: THROTTLE_MESSAGES[throttle.reason!],
      ...(throttle.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: throttle.retryAfterSeconds }),
    };
  }

  const code = generateLoginCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000);

  // The row is written BEFORE the send, so a provider that accepts the message
  // and a process that dies immediately after still leaves a usable code. The
  // reverse order loses a code that was actually delivered.
  await prisma.emailVerification.create({
    data: {
      email,
      purpose: input.purpose,
      codeHash: hashLoginCode(code),
      expiresAt,
      requestIpHash: ipHash ?? null,
      createdAt: now,
    },
  });

  const copy = COPY[input.purpose];
  try {
    await resolveEmailSender().send({
      to: email,
      subject: copy.subject,
      body: [
        copy.line,
        '',
        `    ${code}`,
        '',
        `It expires in ${Math.round(CODE_TTL_SECONDS / 60)} minutes.`,
        '',
        'TARA will never ask you for this code. Nobody from TARA will call you',
        'about it.',
      ].join('\n'),
    });
  } catch (error) {
    if (error instanceof EmailDeliveryError) {
      // The code exists and cannot be delivered. Consuming it here stops it
      // sitting valid for five minutes with nobody able to use it — and stops
      // a later successful send colliding with a stale unusable one.
      await prisma.emailVerification.updateMany({
        where: { email, purpose: input.purpose, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      return {
        ok: false,
        message: 'We could not send that email. Try again in a moment.',
      };
    }
    throw error;
  }

  return { ok: true, expiresAt };
}

export type VerifyEmailCodeOutcome =
  | { ok: true; email: string }
  | { ok: false; failure: VerifyFailure; message: string };

export interface VerifyEmailCodeInput {
  email: string;
  purpose: EmailCodePurpose;
  code: string;
  now?: Date;
}

/**
 * Checks a code and consumes it.
 *
 * Only the newest code for that address AND purpose is considered, so asking
 * for a second code invalidates the first — otherwise every request widens the
 * window instead of replacing it.
 */
export async function verifyEmailCode(
  input: VerifyEmailCodeInput,
): Promise<VerifyEmailCodeOutcome> {
  const now = input.now ?? new Date();
  const email = normaliseEmail(input.email);

  const newest = await prisma.emailVerification.findFirst({
    where: { email, purpose: input.purpose },
    orderBy: { createdAt: 'desc' },
  });

  const usable = checkCodeUsable(newest, now);
  if (!usable.usable) {
    return {
      ok: false,
      failure: usable.failure,
      message: VERIFY_FAILURE_MESSAGES[usable.failure],
    };
  }

  // Expiry and the attempt ceiling are decided above, before the digits are
  // compared, so a dead code cannot be used as a free guess.
  if (!loginCodeMatches(input.code, newest!.codeHash)) {
    await prisma.emailVerification.update({
      where: { id: newest!.id },
      data: { attempts: { increment: 1 } },
    });
    return {
      ok: false,
      failure: 'WRONG_CODE',
      message: VERIFY_FAILURE_MESSAGES.WRONG_CODE,
    };
  }

  // Single use, and conditional on still being unconsumed: two tabs submitting
  // the same correct code must not both succeed.
  const { count } = await prisma.emailVerification.updateMany({
    where: { id: newest!.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (count === 0) {
    return {
      ok: false,
      failure: 'ALREADY_USED',
      message: VERIFY_FAILURE_MESSAGES.ALREADY_USED,
    };
  }

  return { ok: true, email };
}

/** Housekeeping: spent and stale codes, swept with the rest. */
export async function pruneEmailCodes(now = new Date()): Promise<number> {
  const { count } = await prisma.emailVerification.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
        { consumedAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      ],
    },
  });
  return count;
}

export { MAX_CODES_PER_IP };
