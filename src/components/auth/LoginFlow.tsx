'use client';

import { useActionState, useEffect, useState } from 'react';
import { loginFormAction } from '@/lib/actions/auth-actions';
import { INITIAL_LOGIN_STATE, type LoginFormState } from '@/lib/auth/login-state';
import { formatPhilippineMobile, maskPhilippineMobile } from '@/lib/auth/phone';

/**
 * Phone entry, then code entry.
 *
 * One screen, two steps, driven by a SERVER action through `useActionState` —
 * which means the form posts and works before hydration attaches. That is not
 * theoretical here: this app targets low-end Android phones on patchy mobile
 * data, and a `useState`-driven version loses whatever was typed before the
 * JavaScript arrived while leaving the submit button disabled. The countdown
 * below is the only part that needs JavaScript, and its absence just means the
 * server enforces the cooldown instead of the button.
 *
 * A login and a signup are the same request, and the screen never says which
 * one happened, so there is nothing here that reveals whether a number already
 * has an account.
 */
export function LoginFlow({ redirectTo }: { redirectTo: string }) {
  const [state, formAction, isPending] = useActionState<LoginFormState, FormData>(
    loginFormAction,
    INITIAL_LOGIN_STATE,
  );

  const [cooldown, setCooldown] = useState(0);

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
            Padadalhan ka namin ng anim na numerong code.
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

        {error}

        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-xl bg-brand-700 px-4 py-3.5 text-sm font-bold text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-ink-faint"
        >
          {isPending ? 'Sending…' : 'Ipadala ang code'}
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
        <p className="mt-0.5 text-[11px] text-ink-muted">
          Pinadala sa {maskPhilippineMobile(phone)}.
        </p>
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

      {error}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-xl bg-brand-700 px-4 py-3.5 text-sm font-bold text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-ink-faint"
      >
        {isPending ? 'Checking…' : 'Magpatuloy'}
      </button>

      <div className="flex items-center justify-between text-xs">
        <button
          type="submit"
          name="intent"
          value="change-number"
          className="font-semibold text-brand-700"
        >
          ← Ibang number
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
        Hindi namin tatanungin ang code mo sa call, chat, o email. Ikaw lang ang
        dapat makaalam nito.
      </p>
      <p className="text-[11px] text-ink-faint tabular-nums">
        {formatPhilippineMobile(phone)}
      </p>
    </form>
  );
}
