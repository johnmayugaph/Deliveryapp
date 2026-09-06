/**
 * Shape of the login screen's state.
 *
 * In its own module because a `'use server'` file may only export async
 * functions — a runtime constant exported from one does not arrive on the
 * client as the value you wrote, which silently rendered the login screen on
 * its second step.
 */
export interface LoginFormState {
  step: 'phone' | 'code';
  /** Normalised, once a code has been sent. */
  phone?: string;
  error?: string;
  notice?: string;
  /** Seconds before a resend is allowed, for the countdown. */
  retryAfterSeconds?: number;
}

export const INITIAL_LOGIN_STATE: LoginFormState = { step: 'phone' };
