'use client';

import { useActionState, useEffect, useState } from 'react';
import { loginFormAction } from '@/lib/actions/auth-actions';
import { INITIAL_LOGIN_STATE, type LoginFormState } from '@/lib/auth/login-state';
import { formatPhilippineMobile, maskPhilippineMobile } from '@/lib/auth/phone';
import { CaptchaField } from '@/components/auth/CaptchaField';

/**
 * Phone entry, then code entry.
 *
 * One screen, two steps, driven by a SERVER action through `useActionState` —
 * which means the form posts and works before hydration attaches. That is not
 * theoretical here: this app targets low-end Android phones on patchy mobile
 * data, and a `useState`-driven version loses whatever was typed before the
 * JavaScript arrived while leaving the submit button disabled.
 *
 * The SECOND step is the exception, and it is not a choice. A pre-hydration
 * submission is delivered as a plain form post, which Next runs without a
 * request scope — so `cookies()` throws and no session can be set. Sending a
 * code degrades fine; finishing a login cannot, because a login IS a cookie. So
 * the code step's submit waits for hydration, and the server still refuses
 * gracefully if one gets through (see `SessionCookieUnavailableError`).
 *
 * The countdown needs JavaScript too, and its absence just means the server
 * enforces the cooldown instead of the button.
 *
 * A login and a signup are the same request, and the screen never says which
 * one happened, so there is nothing here that reveals whether a number already
 * has an account.
 *
 * The CAPTCHA, where one is configured, appears on BOTH steps — because both
 * steps can send a text. "Resend code" is the same server call as "send the
 * code" with the number already filled in, so exempting it would leave the
 * bypass wide open and cost exactly as much per request.
 */
export function LoginFlow({
  redirectTo,
  captchaSiteKey,
}: {
  redirectTo: string;
  /** Absent when this deployment has no CAPTCHA configured. */
  captchaSiteKey?: string | undefined;
}) {
  const [state, formAction, isPending] = useActionState<LoginFormState, FormData>(
    loginFormAction,
    INITIAL_LOGIN_STATE,
  );

  const [cooldown, setCooldown] = useState(0);

  // False until the client has hydrated. Gates only the code step's submit.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // Start the countdown whenever the server reports one.
  useEffect(() => {
    if (state.retryAfterSeconds) {
      setCooldown(Math.min(state.retryAfterSeconds, 300));
    } else if (state.step === 'code') {
      setCooldown(45);
    }
  }, [state]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const error = state.error ? (
    <p role="alert" className="text-xs leading-relaxed text-rose-700">
      {state.error}
    </p>
  ) : null;

  if (state.step === 'phone') {
    return (
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="next" value={redirectTo} />
        <div>
          <label htmlFor="phone" className="block text-[13px] font-semibold">
            Mobile number
          </label>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            We will text you a six-digit code.
          </p>
          <input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            required
            defaultValue={state.phone ?? ''}
            placeholder="0917 123 4567"
            className="mt-2 w-full rounded-xl bg-surface-sunken px-3 py-3 text-base tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {captchaSiteKey ? <CaptchaField siteKey={captchaSiteKey} /> : null}

        {error}

        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-xl bg-brand-700 px-4 py-3.5 text-sm font-bold text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-ink-faint"
        >
          {isPending ? 'Sending…' : 'Send the code'}
        </button>
      </form>
    );
  }

  const phone = state.phone ?? '';

  return (
    <form action={formAction} className="space-y-4">
      {/* The phone travels with the form, so the server needs no session state
          between the two steps. */}
      <input type="hidden" name="phone" value={phone} />
      <input type="hidden" name="next" value={redirectTo} />

      <div>
        <label htmlFor="code" className="block text-[13px] font-semibold">
          Code
        </label>
        {/* Honest about which of the two happened. A test number gets a row
            and no message, and telling somebody a text was "sent to" a handset
            that will never buzz is the same defect this project has spent a
            dozen phases removing from its own screens. `sentBySms` is absent
            on the first render of the code step after a throttle refusal, in
            which case a code really was sent earlier — so the default reads
            the normal way. */}
        {state.sentBySms === false ? (
          <p className="mt-0.5 text-[11px] font-semibold text-amber-700">
            Test number — no text was sent. Enter the code configured for{' '}
            {maskPhilippineMobile(phone)}.
          </p>
        ) : (
          <p className="mt-0.5 text-[11px] text-ink-muted">
            Sent to {maskPhilippineMobile(phone)}.
          </p>
        )}
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          minLength={6}
          required
          autoFocus
          defaultValue=""
          placeholder="123456"
          className="mt-2 w-full rounded-xl bg-surface-sunken px-3 py-3 text-center text-2xl font-semibold tracking-[0.35em] tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {/* Here for the resend below, which is the same server call as "send
          the code" and costs the same peso. */}
      {captchaSiteKey ? <CaptchaField siteKey={captchaSiteKey} /> : null}

      {error}

      {/* Without JavaScript the submit above never enables, because the post
          it would make cannot set a cookie. Say that plainly instead of
          leaving a dead button. */}
      <noscript>
        <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          Finishing sign-in needs JavaScript. Turn it on, or use another browser.
        </p>
      </noscript>

      <button
        type="submit"
        disabled={isPending || !hydrated}
        className="w-full rounded-xl bg-brand-700 px-4 py-3.5 text-sm font-bold text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-ink-faint"
      >
        {isPending ? 'Checking…' : 'Continue'}
      </button>

      <div className="flex items-center justify-between text-xs">
        <button
          type="submit"
          name="intent"
          value="change-number"
          className="font-semibold text-brand-700"
        >
          ← Different number
        </button>
        <button
          type="submit"
          name="intent"
          value="resend"
          disabled={cooldown > 0 || isPending}
          className="font-semibold text-brand-700 disabled:text-ink-faint"
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
        </button>
      </div>

      <p className="pt-1 text-[11px] leading-relaxed text-ink-faint">
        We will never ask for your code by call, chat or email. Only you should
        know it.
      </p>
      <p className="text-[11px] text-ink-faint tabular-nums">
        {formatPhilippineMobile(phone)}
      </p>
    </form>
  );
}
