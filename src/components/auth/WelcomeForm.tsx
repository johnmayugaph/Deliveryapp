'use client';

import { useActionState } from 'react';
import { completeOnboardingFormAction } from '@/lib/actions/auth-actions';

/**
 * Collects the one thing a new account is missing: a name to hand food to.
 *
 * Deliberately an UNCONTROLLED form posting to a server action, rather than
 * React state driving a disabled button. This app targets low-end Android
 * phones on patchy mobile data, where someone can type into a controlled input
 * before hydration attaches — and lose what they typed while the button stays
 * disabled. This version submits either way, and validation lives on the server
 * where it has to be anyway.
 */
export function WelcomeForm() {
  const [state, formAction, isPending] = useActionState(completeOnboardingFormAction, null);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="fullName" className="block text-[13px] font-semibold">
          Pangalan
        </label>
        <p className="mt-0.5 text-[11px] text-ink-muted">
          Ito ang makikita ng rider at ng store.
        </p>
        <input
          id="fullName"
          name="fullName"
          type="text"
          autoComplete="name"
          autoFocus
          required
          minLength={2}
          maxLength={80}
          defaultValue=""
          placeholder="Juan Dela Cruz"
          className="mt-2 w-full rounded-xl bg-surface-sunken px-3 py-3 text-base ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      {state?.status === 'error' ? (
        <p role="alert" className="text-xs text-rose-700">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-xl bg-brand-700 px-4 py-3.5 text-sm font-bold text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-ink-faint"
      >
        {isPending ? 'Saving…' : 'Simulan'}
      </button>
    </form>
  );
}
