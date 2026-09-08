/**
 * The rules governing login codes. Pure, so every limit below is testable
 * without a database or a clock.
 */

/** How long a code stays usable. Short enough that a leaked code is stale. */
export const CODE_TTL_SECONDS = 5 * 60;

/** Wrong guesses allowed before a code is dead. */
export const MAX_VERIFY_ATTEMPTS = 5;

/** Codes one phone number may request per window. */
export const MAX_CODES_PER_PHONE = 3;
export const PHONE_WINDOW_SECONDS = 15 * 60;

/** Codes one source address may request per window, across all numbers. */
export const MAX_CODES_PER_IP = 12;
export const IP_WINDOW_SECONDS = 60 * 60;

/** Minimum gap between two codes for the same number. Stops accidental double-taps. */
export const RESEND_COOLDOWN_SECONDS = 45;

export type ThrottleReason =
  | 'PHONE_LIMIT'
  | 'IP_LIMIT'
  | 'COOLDOWN';

export interface ThrottleDecision {
  allowed: boolean;
  reason?: ThrottleReason;
  /** Seconds until the caller may try again. */
  retryAfterSeconds?: number;
}

export interface ThrottleInput {
  now: Date;
  /** Creation times of recent codes for this phone, newest first. */
  recentForPhone: readonly Date[];
  /** How many codes this source address has requested inside its window. */
  recentForIpCount: number;
}

/**
 * Whether a new code may be sent.
 *
 * Three limits, each answering a different abuse: the cooldown stops a
 * double-tapped button costing two SMS; the per-phone cap stops someone being
 * bombarded with codes they did not ask for; the per-IP cap stops one script
 * burning the SMS budget across many numbers.
 *
 * Every refusal reports when to come back, because a bare "try later" is a
 * dead end for someone who genuinely did not receive the first code.
 */
export function evaluateThrottle(input: ThrottleInput): ThrottleDecision {
  const { now, recentForPhone, recentForIpCount } = input;

  const newest = recentForPhone[0];
  if (newest) {
    const elapsed = (now.getTime() - newest.getTime()) / 1000;
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      return {
        allowed: false,
        reason: 'COOLDOWN',
        retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed),
      };
    }
  }

  const phoneWindowStart = now.getTime() - PHONE_WINDOW_SECONDS * 1000;
  const inPhoneWindow = recentForPhone.filter(
    (createdAt) => createdAt.getTime() >= phoneWindowStart,
  );
  if (inPhoneWindow.length >= MAX_CODES_PER_PHONE) {
    // Wait until the oldest request in the window falls out of it.
    const oldest = inPhoneWindow[inPhoneWindow.length - 1]!;
    const freesUpAt = oldest.getTime() + PHONE_WINDOW_SECONDS * 1000;
    return {
      allowed: false,
      reason: 'PHONE_LIMIT',
      retryAfterSeconds: Math.max(1, Math.ceil((freesUpAt - now.getTime()) / 1000)),
    };
  }

  if (recentForIpCount >= MAX_CODES_PER_IP) {
    return {
      allowed: false,
      reason: 'IP_LIMIT',
      retryAfterSeconds: IP_WINDOW_SECONDS,
    };
  }

  return { allowed: true };
}

export type VerifyFailure =
  | 'NO_CODE'
  | 'EXPIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'ALREADY_USED'
  | 'WRONG_CODE';

export interface VerifiableCode {
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
}

/**
 * Whether a stored code is still in a state that can be checked at all —
 * separate from whether the digits match.
 *
 * Order matters: expiry and the attempt ceiling are decided before the digits
 * are compared, so a dead code cannot be used as a free guess.
 */
export function checkCodeUsable(
  code: VerifiableCode | null,
  now: Date,
): { usable: true } | { usable: false; failure: VerifyFailure } {
  if (!code) {
    return { usable: false, failure: 'NO_CODE' };
  }
  if (code.consumedAt !== null) {
    return { usable: false, failure: 'ALREADY_USED' };
  }
  if (code.attempts >= MAX_VERIFY_ATTEMPTS) {
    return { usable: false, failure: 'TOO_MANY_ATTEMPTS' };
  }
  if (code.expiresAt.getTime() <= now.getTime()) {
    return { usable: false, failure: 'EXPIRED' };
  }
  return { usable: true };
}

/**
 * What to tell the person.
 *
 * Deliberately vague about WHICH thing went wrong in the two cases an attacker
 * would find useful — a missing code and a wrong code read the same, so the
 * form cannot be used to discover whether a number has a code outstanding. The
 * cases that are the user's own problem say so plainly, because a person who
 * has genuinely run out of attempts needs to know to ask for a new code.
 */
export const VERIFY_FAILURE_MESSAGES: Readonly<Record<VerifyFailure, string>> = {
  NO_CODE: 'That code is wrong. Try again, or ask for a new one.',
  WRONG_CODE: 'That code is wrong. Try again, or ask for a new one.',
  EXPIRED: 'That code has expired. Ask for a new one.',
  TOO_MANY_ATTEMPTS: 'Too many wrong tries. Ask for a new code.',
  ALREADY_USED: 'That code has already been used. Ask for a new one.',
};

/**
 * What the login screen says when this deployment has no SMS gateway.
 *
 * It has to be honest that waiting will not help — "try again in a moment" is
 * a lie when the answer will be identical in an hour — without naming a
 * variable at a stranger, and without implying the person did something
 * wrong. Whoever reads it on a real deployment is almost certainly the
 * operator, because in this state nobody else can have got in.
 */
export const SMS_NOT_CONFIGURED_MESSAGE =
  'Sign-in by text message is not switched on for this deployment yet. ' +
  'Nothing you can do from here will fix it — whoever runs this site has to ' +
  'connect an SMS gateway.';

export const THROTTLE_MESSAGES: Readonly<Record<ThrottleReason, string>> = {
  COOLDOWN: 'Wait for the code we already sent.',
  PHONE_LIMIT: 'Too many codes requested. Try again later.',
  IP_LIMIT: 'Too many requests from your connection. Try again later.',
};
