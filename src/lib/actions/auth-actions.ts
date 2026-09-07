'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import {
  checkLoginCode,
  safeNextPath,
  sendLoginCode,
} from '@/lib/auth/login';
import { normalisePhilippineMobile } from '@/lib/auth/phone';
import type { LoginFormState } from '@/lib/auth/login-state';
import {
  createSession,
  SessionCookieUnavailableError,
  getClientIp,
  requireCurrentUser,
  revokeOtherSessions,
  signOutCurrentSession,
} from '@/lib/auth/session';

/**
 * Authentication actions.
 *
 * Two properties hold throughout:
 *
 *  - **No enumeration.** Requesting a code answers the same way whether the
 *    number has an account or not, because signup and login are the same
 *    request. Nothing here reveals whether a phone is registered.
 *  - **The server decides who you are.** Every other action in the app resolves
 *    the customer from the session cookie, never from its arguments.
 *
 * The orchestration lives in `@/lib/auth/login`, as plain functions. Actions
 * read the request-scoped values (`headers`, `cookies`) and pass them in —
 * calling one server action from another loses that scope, which is a mistake
 * worth not repeating.
 */

/**
 * Drives both steps of the login screen.
 *
 * Which step is being submitted is read from the form's own fields rather than
 * from client state, so a submission that arrives before hydration still
 * carries everything the server needs.
 */
export async function loginFormAction(
  _previous: LoginFormState | null,
  formData: FormData,
): Promise<LoginFormState> {
  const rawPhone = String(formData.get('phone') ?? '').trim();
  const rawCode = String(formData.get('code') ?? '').trim();
  const next = safeNextPath(String(formData.get('next') ?? '/'));
  const intent = String(formData.get('intent') ?? '');

  if (intent === 'change-number') {
    return { step: 'phone' };
  }
  if (rawPhone.length === 0) {
    return { step: 'phone', error: 'Ilagay ang mobile number mo, hal. 0917 123 4567.' };
  }

  const wantsNewCode = intent === 'resend' || rawCode.length === 0;

  if (wantsNewCode) {
    const sent = await sendLoginCode({ rawPhone, clientIp: await getClientIp() });
    if (sent.ok) {
      return { step: 'code', phone: sent.phone, notice: 'Pinadala na ang code.' };
    }
    // A throttle refusal keeps them on the code step — the previous code is
    // probably still valid, so sending them back would be unhelpful.
    if (sent.retryAfterSeconds !== undefined) {
      return {
        step: 'code',
        phone: normaliseQuietly(rawPhone),
        error: sent.message,
        retryAfterSeconds: sent.retryAfterSeconds,
      };
    }
    return { step: 'phone', error: sent.message };
  }

  const checked = await checkLoginCode({ rawPhone, code: rawCode });
  if (!checked.ok) {
    return { step: 'code', phone: normaliseQuietly(rawPhone), error: checked.message };
  }

  try {
    await createSession(checked.userId);
  } catch (error) {
    // A form submitted before the page hydrated arrives without a request
    // scope, so the cookie cannot be set. The code has already been consumed by
    // `checkLoginCode`, so send them back for a new one rather than leaving them
    // staring at a code that will now be refused.
    if (error instanceof SessionCookieUnavailableError) {
      return {
        step: 'phone',
        phone: normaliseQuietly(rawPhone),
        error: 'Hindi pa tapos mag-load ang page. Subukan muli.',
      };
    }
    throw error;
  }

  revalidatePath('/', 'layout');
  redirect(checked.needsOnboarding ? '/welcome' : next);
}

/** Normalises without throwing, for echoing a number back into the form. */
function normaliseQuietly(rawPhone: string): string {
  try {
    return normalisePhilippineMobile(rawPhone);
  } catch {
    return rawPhone;
  }
}

export type OnboardingState = { status: 'error'; message: string };

/** Captures the name for a new account and marks onboarding complete. */
export async function completeOnboardingAction(
  fullName: string,
): Promise<OnboardingState | never> {
  const user = await requireCurrentUser();
  const trimmed = fullName.trim().replace(/\s+/g, ' ');

  if (trimmed.length < 2) {
    return { status: 'error', message: 'Ilagay ang pangalan mo.' };
  }
  if (trimmed.length > 80) {
    return { status: 'error', message: 'Masyadong mahaba ang pangalan.' };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      fullName: trimmed,
      // First word: what the app greets them with.
      displayName: trimmed.split(' ')[0] ?? trimmed,
      onboardedAt: new Date(),
    },
  });

  revalidatePath('/', 'layout');
  redirect('/');
}

/**
 * Form-action form of the above, so `/welcome` submits without JavaScript.
 *
 * Worth the extra entry point: this app targets low-end Android phones on
 * patchy mobile data, where a controlled React input can be typed into before
 * hydration attaches and silently lose what was typed.
 */
export async function completeOnboardingFormAction(
  _previous: OnboardingState | null,
  formData: FormData,
): Promise<OnboardingState | null> {
  const fullName = formData.get('fullName');
  if (typeof fullName !== 'string') {
    return { status: 'error', message: 'Ilagay ang pangalan mo.' };
  }
  return (await completeOnboardingAction(fullName)) ?? null;
}

export async function signOutAction(): Promise<never> {
  await signOutCurrentSession();
  revalidatePath('/', 'layout');
  redirect('/login');
}

export async function signOutEverywhereAction(): Promise<{ revoked: number }> {
  const user = await requireCurrentUser();
  const revoked = await revokeOtherSessions(user.id);
  revalidatePath('/profile');
  return { revoked };
}
