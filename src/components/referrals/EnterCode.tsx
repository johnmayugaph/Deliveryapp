'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { enterReferralCodeAction } from '@/lib/actions/referral-actions';
import { CODE_LENGTH, normaliseCode } from '@/lib/referrals/policy';

/**
 * Typing in a code somebody read out to you.
 *
 * Normalised as it is typed, using the same pure function the server uses, so
 * a pasted link or a code with spaces in it becomes the code — and so the
 * button enables at exactly the moment the server would accept the length.
 * Two copies of that rule would drift; the pure module exists so there is one.
 */
export function EnterCode() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const code = normaliseCode(value);
  const ready = code.length === CODE_LENGTH && !isPending;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        startTransition(async () => {
          const outcome = await enterReferralCodeAction(code);
          setResult(outcome);
          if (outcome.ok) {
            setValue('');
            router.refresh();
          }
        });
      }}
      className="mt-3 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
    >
      <label className="block">
        <span className="text-[13px] font-semibold">Got a code from a friend?</span>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder="ABC234"
          aria-describedby="code-help"
          className="mt-1.5 w-full rounded-lg bg-surface-sunken px-3 py-2 font-mono text-lg tracking-[0.18em] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>
      <p id="code-help" className="mt-1 text-[11px] text-ink-faint">
        Six characters. Only for accounts that have not ordered yet.
      </p>

      <button
        type="submit"
        disabled={!ready}
        className="mt-2.5 w-full rounded-xl bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-800 disabled:opacity-50"
      >
        {isPending ? 'Checking…' : 'Use this code'}
      </button>

      {result ? (
        <p
          role="alert"
          className={`mt-2 text-xs leading-relaxed ${
            result.ok ? 'text-emerald-700' : 'text-rose-700'
          }`}
        >
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
