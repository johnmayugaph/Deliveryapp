import type { User } from '@prisma/client';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import {
  CUSTOMER_SCREENS,
  loginPathFor,
  pathFor,
  type CustomerScreen,
} from '@/lib/auth/screens';

/**
 * The one gate every private customer screen goes through.
 *
 * The impure sibling of `./screens.ts`: that module holds the decision, this
 * one reads the session and acts on it. Split for the usual reason — a
 * `'use client'` component may import the rule, and importing this would turn
 * it into a 500 on first render.
 *
 * Why a redirect rather than a thrown error, given `requireCurrentUser()`
 * already exists: throwing is right for a server ACTION, where the caller is
 * JavaScript that can read the failure and say something. On a PAGE it renders
 * `app/error.tsx` — *"This screen did not load. Something on our side
 * broke."* — which is false, alarming, and unactionable. Nothing broke; the
 * customer's session ended and they need to sign in again. `/points` and
 * `/invite` did exactly this, and the monitoring module even classifies the
 * error as expected-and-not-a-fault, which is the tell: an expected refusal
 * that reaches the error page is a refusal in the wrong shape.
 */
export async function requireScreen(
  screen: CustomerScreen,
  id?: string,
): Promise<User> {
  const { needs } = CUSTOMER_SCREENS[screen];
  if (needs === 'PUBLIC') {
    throw new Error(
      `requireScreen: ${screen} is PUBLIC — it must render for a stranger`,
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    /* Carries where they were, so signing in returns them to it rather than
       to the home screen. That is the difference between a session that
       expired mid-order and a session that expired and lost their place. */
    redirect(loginPathFor(screen, id));
  }
  if (needs === 'ONBOARDED' && user.onboardedAt === null) {
    redirect(pathFor('welcome'));
  }
  return user;
}

/**
 * The signed-in user, or null, on a screen that renders either way.
 *
 * For the PUBLIC screens only, and it exists to make that reading deliberate:
 * a bare `getCurrentUser()` on a private screen is how all six of the
 * session-gone defects were written, and each one looked reasonable in
 * isolation. Asking for this by name means the author has said out loud that
 * the screen is honest with nobody signed in.
 */
export async function optionalUser(screen: CustomerScreen): Promise<User | null> {
  const { needs } = CUSTOMER_SCREENS[screen];
  if (needs !== 'PUBLIC') {
    throw new Error(
      `optionalUser: ${screen} needs ${needs} — use requireScreen instead`,
    );
  }
  return getCurrentUser();
}
