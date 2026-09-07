'use server';

import { revalidatePath } from 'next/cache';
import { EmailCodePurpose } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireOnboardedUser, getClientIp } from '@/lib/auth/session';
import {
  InvalidEmailAddressError,
  maskEmail,
  normaliseEmail,
} from '@/lib/auth/email/address';
import { isEmailConfigured } from '@/lib/auth/email';
import { sendEmailCode, verifyEmailCode } from '@/lib/auth/email-codes';
import {
  InvalidPhoneNumberError,
  maskPhilippineMobile,
  normalisePhilippineMobile,
} from '@/lib/auth/phone';
import { requestLoginCode, verifyLoginCode } from '@/lib/auth/otp';
import { THROTTLE_MESSAGES, VERIFY_FAILURE_MESSAGES } from '@/lib/auth/otp-policy';
import {
  completeRecovery,
  PhoneAlreadyInUseError,
  RecoveryUnavailableError,
  SamePhoneError,
  recoveryFreezeEnd,
  requestRecoveryCode,
  verifyRecoveryEmail,
  RECOVERY_CREDIT_FREEZE_DAYS,
} from '@/lib/auth/recovery';

/**
 * Adding a recovery address, and using one.
 *
 * The two halves are deliberately different in what they will tell you.
 *
 * The signed-in half — adding an email — can be specific, because the caller
 * has already proved who they are.
 *
 * The recovery half cannot. Every response there is written to be identical
 * whether or not the address belongs to an account, because a form that
 * answers differently is a form for testing a list of email addresses against
 * the customer base. The person who genuinely mistyped their own address is
 * served by a working resend, not by being told they are a stranger.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
}

// -----------------------------------------------------------------------------
// Signed in: adding and confirming a recovery address
// -----------------------------------------------------------------------------

export async function requestEmailVerificationAction(
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireOnboardedUser();

  if (!isEmailConfigured()) {
    return {
      ok: false,
      message:
        'Email is not set up on this deployment yet, so there is nothing to send. ' +
        'Recovery through support still works.',
    };
  }

  let email: string;
  try {
    email = normaliseEmail(String(formData.get('email') ?? ''));
  } catch (error) {
    if (error instanceof InvalidEmailAddressError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  // A verified address on another account cannot be claimed here. The unique
  // index would reject it anyway; this turns that into a sentence, and it
  // deliberately does not say whose it is.
  const conflict = await prisma.user.findFirst({
    where: { email, NOT: { id: user.id } },
    select: { id: true },
  });
  if (conflict) {
    return {
      ok: false,
      message: 'That address is already on another account.',
    };
  }

  // Stored unverified, so the code has something to confirm. `emailVerifiedAt`
  // stays null until a code lands — which is the column every recovery path
  // checks, so an address parked here grants nothing.
  await prisma.user.update({
    where: { id: user.id },
    data: { email, emailVerifiedAt: null },
  });

  const ip = await getClientIp();
  const outcome = await sendEmailCode({
    email,
    purpose: EmailCodePurpose.VERIFY_ADDRESS,
    ...(ip === undefined ? {} : { requestIp: ip }),
  });

  revalidatePath('/profile');
  if (!outcome.ok) return { ok: false, message: outcome.message };

  return {
    ok: true,
    message: `Code sent to ${maskEmail(email)}. It expires in 5 minutes.`,
  };
}

export async function confirmEmailAction(formData: FormData): Promise<ActionResult> {
  const user = await requireOnboardedUser();
  const code = String(formData.get('code') ?? '').trim();

  const fresh = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { email: true },
  });
  if (!fresh.email) {
    return { ok: false, message: 'Add an address first.' };
  }

  const result = await verifyEmailCode({
    email: fresh.email,
    purpose: EmailCodePurpose.VERIFY_ADDRESS,
    code,
  });
  if (!result.ok) return { ok: false, message: result.message };

  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerifiedAt: new Date() },
  });

  revalidatePath('/profile');
  return {
    ok: true,
    message:
      'Confirmed. If you ever lose your number, this address can move your ' +
      'account to a new one.',
  };
}

export async function removeRecoveryEmailAction(): Promise<ActionResult> {
  const user = await requireOnboardedUser();
  await prisma.user.update({
    where: { id: user.id },
    // Both columns together: an address with the verified flag left set would
    // fail the table's own CHECK, and an unverified leftover address would
    // look like recovery is still set up when it is not.
    data: { email: null, emailVerifiedAt: null },
  });
  revalidatePath('/profile');
  return {
    ok: true,
    message:
      'Removed. Losing your number now means asking support to move the account.',
  };
}

// -----------------------------------------------------------------------------
// Not signed in: recovery
// -----------------------------------------------------------------------------

/**
 * Step 1: a code to the address.
 *
 * Answers the same thing whether or not the address is known. See the note at
 * the top of this file.
 */
export async function startRecoveryAction(formData: FormData): Promise<ActionResult> {
  const raw = String(formData.get('email') ?? '');

  let email: string;
  try {
    email = normaliseEmail(raw);
  } catch (error) {
    if (error instanceof InvalidEmailAddressError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const ip = await getClientIp();
  try {
    await requestRecoveryCode({
      email,
      ...(ip === undefined ? {} : { requestIp: ip }),
    });
  } catch (error) {
    if (error instanceof RecoveryUnavailableError) {
      return {
        ok: false,
        message:
          'Recovery by email is not available on this deployment. Ask support ' +
          'to move your account.',
      };
    }
    throw error;
  }

  return {
    ok: true,
    message:
      `If ${maskEmail(email)} is set up for recovery, a code is on its way. ` +
      'It expires in 5 minutes.',
  };
}

/**
 * Step 2: the emailed code, plus the number to move to.
 *
 * Sends an OTP to the NEW number. Nothing has changed yet — this is the point
 * where the person starts proving they hold the number they are asking for,
 * which is the second of the two channels.
 */
export async function proveNewPhoneAction(formData: FormData): Promise<
  ActionResult & { stage?: 'awaiting-phone-code'; email?: string; phone?: string }
> {
  const email = String(formData.get('email') ?? '');
  const code = String(formData.get('code') ?? '').trim();
  const rawPhone = String(formData.get('newPhone') ?? '');

  let newPhone: string;
  try {
    newPhone = normalisePhilippineMobile(rawPhone);
  } catch (error) {
    if (error instanceof InvalidPhoneNumberError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const emailStep = await verifyRecoveryEmail({ email, code });
  if (!emailStep.ok) return { ok: false, message: emailStep.message };

  if (emailStep.currentPhone === newPhone) {
    return {
      ok: false,
      message: 'That is already the number on this account — just sign in.',
    };
  }

  const taken = await prisma.user.findUnique({
    where: { phone: newPhone },
    select: { id: true },
  });
  if (taken) {
    return {
      ok: false,
      message: 'That number already belongs to an account. Sign in with it instead.',
    };
  }

  const ip = await getClientIp();
  const sent = await requestLoginCode({
    rawPhone: newPhone,
    ...(ip === undefined ? {} : { clientIp: ip }),
  });
  if (!sent.ok) {
    // The login flow's own outcome shape, mapped to a sentence here rather
    // than restated: 'throttled' carries which limit and when to retry.
    return {
      ok: false,
      message:
        'throttled' in sent
          ? THROTTLE_MESSAGES[sent.throttled.reason!]
          : 'We could not send that code. Try again in a moment.',
    };
  }

  return {
    ok: true,
    stage: 'awaiting-phone-code',
    email: normaliseEmail(email),
    phone: newPhone,
    message: `Code sent to ${maskPhilippineMobile(newPhone)}.`,
  };
}

/**
 * Step 3: the code from the new number. The move happens here.
 *
 * The emailed code was already consumed in step 2, so this step re-checks
 * nothing about the email — which means the `userId` has to be resolved from
 * the address again, and the address must still be the verified one on that
 * account. An owner who removed it in the meantime cancels the recovery,
 * which is the correct outcome.
 */
export async function completeRecoveryAction(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '');
  const phone = String(formData.get('phone') ?? '');
  const code = String(formData.get('code') ?? '').trim();

  let newPhone: string;
  try {
    newPhone = normalisePhilippineMobile(phone);
  } catch {
    return { ok: false, message: 'Start again.' };
  }

  const normalisedEmail = (() => {
    try {
      return normaliseEmail(email);
    } catch {
      return null;
    }
  })();
  if (!normalisedEmail) return { ok: false, message: 'Start again.' };

  const owner = await prisma.user.findFirst({
    where: { email: normalisedEmail, emailVerifiedAt: { not: null } },
    select: { id: true },
  });
  if (!owner) {
    return { ok: false, message: 'That address is no longer set up for recovery.' };
  }

  // Proves control of the new number. `verifyLoginCode` consumes the code, so
  // it cannot be replayed to move a second account.
  const proof = await verifyLoginCode({ rawPhone: newPhone, code });
  if (!proof.ok) {
    return { ok: false, message: VERIFY_FAILURE_MESSAGES[proof.failure] };
  }

  try {
    await completeRecovery({
      userId: owner.id,
      newPhone,
      viaEmail: normalisedEmail,
    });
  } catch (error) {
    if (error instanceof PhoneAlreadyInUseError || error instanceof SamePhoneError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const freezeEnds = recoveryFreezeEnd(new Date()).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'long',
  });

  return {
    ok: true,
    message:
      `Done. Sign in with ${maskPhilippineMobile(newPhone)}. ` +
      `Your credits are on hold until ${freezeEnds} — ${RECOVERY_CREDIT_FREEZE_DAYS} days, ` +
      'so that if this was not you there is time to stop it. Everything else works now.',
  };
}

/** For the profile screen: has this account ever been moved, and how. */
export async function recoveryHistoryForCurrentUser() {
  const user = await requireOnboardedUser();
  return prisma.accountRecovery.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      method: true,
      createdAt: true,
      creditsFrozenUntil: true,
      newPhone: true,
      previousPhone: true,
    },
  });
}
