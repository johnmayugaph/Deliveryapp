'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  completeRecoveryAction,
  proveNewPhoneAction,
  startRecoveryAction,
} from '@/lib/actions/recovery-actions';

/**
 * Recovery, in three steps.
 *
 * The step is client state rather than a URL, on purpose: the middle steps
 * carry a proved email address and a phone number waiting on a code, and
 * neither belongs in a URL that gets pasted into a support chat or left in a
 * shared browser's history.
 *
 * Every screen says what has and has not happened yet. Somebody using this is
 * locked out of their account and inclined to assume the worst, so "nothing
 * has changed yet" is worth more here than brevity.
 */

type Step =
  | { name: 'email' }
  | { name: 'email-code'; email: string }
  | { name: 'phone-code'; email: string; phone: string }
  | { name: 'done'; message: string };

const FIELD =
  'mt-1 w-full rounded-xl border border-black/10 bg-surface px-3 py-2.5 text-base';
const BUTTON =
  'mt-3 w-full rounded-xl bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60';

export function RecoveryFlow() {
  const [step, setStep] = useState<Step>({ name: 'email' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function submit(
    formData: FormData,
    run: (data: FormData) => Promise<void>,
  ) {
    setBusy(true);
    setError(null);
    try {
      await run(formData);
    } finally {
      setBusy(false);
    }
  }

  if (step.name === 'done') {
    return (
      <div className="space-y-3">
        <p className="text-sm leading-relaxed">{step.message}</p>
        <Link
          href="/login"
          className="block rounded-xl bg-brand-700 px-4 py-2.5 text-center text-sm font-semibold text-white"
        >
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {step.name === 'email' ? (
        <form
          action={(formData) =>
            submit(formData, async (data) => {
              const result = await startRecoveryAction(data);
              if (!result.ok) {
                setError(result.message);
                return;
              }
              setNote(result.message);
              setStep({ name: 'email-code', email: String(data.get('email') ?? '') });
            })
          }
        >
          <label className="block">
            <span className="text-[13px] font-semibold">Your recovery email</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
              The address you confirmed on the account, before you lost the number.
            </span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
              className={FIELD}
            />
          </label>
          <button type="submit" disabled={busy} className={BUTTON}>
            {busy ? 'Sending…' : 'Send a code'}
          </button>
        </form>
      ) : null}

      {step.name === 'email-code' ? (
        <form
          action={(formData) =>
            submit(formData, async (data) => {
              data.set('email', step.email);
              const result = await proveNewPhoneAction(data);
              if (!result.ok) {
                setError(result.message);
                return;
              }
              setNote(result.message);
              setStep({
                name: 'phone-code',
                email: result.email ?? step.email,
                phone: result.phone ?? '',
              });
            })
          }
        >
          <label className="block">
            <span className="text-[13px] font-semibold">Code from your email</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              aria-label="Code from your email"
              placeholder="000000"
              className={`${FIELD} tracking-[0.4em]`}
            />
          </label>

          <label className="mt-3 block">
            <span className="text-[13px] font-semibold">Your new number</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
              We text this one next, to check it is yours.
            </span>
            <input
              name="newPhone"
              inputMode="tel"
              autoComplete="tel"
              required
              placeholder="0917 123 4567"
              className={FIELD}
            />
          </label>

          <button type="submit" disabled={busy} className={BUTTON}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            Nothing has changed on your account yet.
          </p>
        </form>
      ) : null}

      {step.name === 'phone-code' ? (
        <form
          action={(formData) =>
            submit(formData, async (data) => {
              data.set('email', step.email);
              data.set('phone', step.phone);
              const result = await completeRecoveryAction(data);
              if (!result.ok) {
                setError(result.message);
                return;
              }
              setStep({ name: 'done', message: result.message });
            })
          }
        >
          <label className="block">
            <span className="text-[13px] font-semibold">Code from your new number</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              aria-label="Code from your new number"
              placeholder="000000"
              className={`${FIELD} tracking-[0.4em]`}
            />
          </label>
          <button type="submit" disabled={busy} className={BUTTON}>
            {busy ? 'Moving your account…' : 'Move my account'}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            When you submit this, your old number stops working and we text it to
            say so. Your credits are held for three days.
          </p>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs leading-relaxed text-red-700">
          {error}
        </p>
      ) : null}
      {note && !error ? (
        <p role="status" className="text-xs leading-relaxed text-ink-muted">
          {note}
        </p>
      ) : null}
    </div>
  );
}
