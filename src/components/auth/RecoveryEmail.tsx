'use client';

import { useState } from 'react';
import {
  confirmEmailAction,
  removeRecoveryEmailAction,
  requestEmailVerificationAction,
} from '@/lib/actions/recovery-actions';

/**
 * The recovery address, on the profile screen.
 *
 * Three states, and the copy is what does the work. This is a setting almost
 * nobody sets up before they need it, so the section has to earn the thirty
 * seconds — which means saying what happens WITHOUT it, plainly, rather than
 * describing the feature.
 */

export interface RecoveryEmailProps {
  /** The address on the account, verified or not. */
  email: string | null;
  verified: boolean;
  /** False when the deployment has no email provider — then there is nothing
   *  to offer, and pretending otherwise would strand somebody later. */
  available: boolean;
}

const FIELD =
  'mt-1 w-full rounded-xl border border-black/10 bg-surface px-3 py-2 text-sm';

export function RecoveryEmail({ email, verified, available }: RecoveryEmailProps) {
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  /**
   * Returns void, not the outcome: a form `action` must resolve to void, and a
   * handler that returns a value here is a type error React reports at the
   * call site rather than the definition. Each caller does its own
   * state change inside `work` instead.
   */
  async function run(work: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
    setBusy(true);
    try {
      const result = await work();
      setMessage(result.message);
      setFailed(!result.ok);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="recovery-heading" className="mt-5 px-4">
      <h2 id="recovery-heading" className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        If you lose your number
      </h2>

      <div className="mt-2 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
        {!available ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            Email is not set up on this deployment yet. If you lose your number,
            support can move the account by hand.
          </p>
        ) : verified && email ? (
          <>
            <p className="text-sm font-semibold">{email}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Confirmed. If you lose your number, this address can move your
              account to a new one — and nothing else can.
            </p>
            <form
              action={() =>
                run(async () => {
                  const result = await removeRecoveryEmailAction();
                  if (result.ok) setAwaitingCode(false);
                  return result;
                })
              }
            >
              <button
                type="submit"
                disabled={busy}
                className="mt-3 rounded-xl bg-surface-sunken px-3 py-2 text-[13px] font-semibold disabled:opacity-60"
              >
                {busy ? 'Removing…' : 'Remove'}
              </button>
            </form>
          </>
        ) : awaitingCode && email ? (
          <form
            action={(formData) =>
              run(async () => {
                const result = await confirmEmailAction(formData);
                if (result.ok) setAwaitingCode(false);
                return result;
              })
            }
          >
            <p className="text-xs leading-relaxed text-ink-muted">
              We sent a code to <span className="font-semibold">{email}</span>.
            </p>
            <label className="mt-2 block">
              <span className="text-[13px] font-semibold">Code</span>
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
            <button
              type="submit"
              disabled={busy}
              className="mt-3 rounded-xl bg-brand-700 px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
            >
              {busy ? 'Confirming…' : 'Confirm'}
            </button>
          </form>
        ) : (
          <form
            action={(formData) =>
              run(async () => {
                const result = await requestEmailVerificationAction(formData);
                if (result.ok) setAwaitingCode(true);
                return result;
              })
            }
          >
            <p className="text-xs leading-relaxed text-ink-muted">
              Your phone number is how you sign in. Right now, losing it means
              losing this account — your orders, your addresses and your credits.
              An email address is the only way back.
            </p>
            <label className="mt-2 block">
              <span className="text-[13px] font-semibold">Email address</span>
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                defaultValue={email ?? ''}
                placeholder="you@example.com"
                className={FIELD}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="mt-3 rounded-xl bg-brand-700 px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
            >
              {busy ? 'Sending…' : 'Send a code'}
            </button>
            {email && !verified ? (
              <p className="mt-2 text-[11px] leading-relaxed text-amber-800">
                {email} is on the account but was never confirmed, so it cannot
                recover anything yet.
              </p>
            ) : null}
          </form>
        )}

        {message ? (
          <p
            role="status"
            className={`mt-2 text-xs leading-relaxed ${
              failed ? 'text-red-700' : 'text-emerald-700'
            }`}
          >
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
