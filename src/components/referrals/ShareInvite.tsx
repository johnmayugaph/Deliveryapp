'use client';

import { useState } from 'react';

/**
 * The code, and the two ways somebody actually shares it.
 *
 * The code is shown large and letter-spaced because its job is to be read off
 * this screen and typed into another phone — which is still how most of this
 * will happen, over a message or out loud.
 *
 * `navigator.share` is the native sheet, which on an Android phone is the whole
 * distance between "I will send this later" and sending it. It is absent on
 * desktop and in some in-app browsers, so copy-to-clipboard is the fallback and
 * the code itself is the fallback to that: three layers, each usable alone.
 */
export function ShareInvite({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  // Built in the browser so it carries whatever host the person is actually
  // using, rather than a base URL configured somewhere else and wrong.
  const link =
    typeof window === 'undefined'
      ? ''
      : `${window.location.origin}/?ref=${encodeURIComponent(code)}`;

  const message = `Try TARA — use my code ${code} and you get credits on your first order. ${link}`;

  async function share(): Promise<void> {
    setFailed(false);
    // Read once into a local: narrowing on `'share' in navigator` otherwise
    // leaves the global typed as never in the branch below it.
    const nav: Navigator | undefined =
      typeof navigator === 'undefined' ? undefined : navigator;
    try {
      if (nav && typeof nav.share === 'function') {
        await nav.share({ text: message });
        return;
      }
      if (!nav?.clipboard) {
        setFailed(true);
        return;
      }
      await nav.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch (error) {
      // A cancelled share sheet is not a failure and must not show an error —
      // the person tapped away on purpose.
      if (error instanceof Error && error.name === 'AbortError') return;
      setFailed(true);
    }
  }

  return (
    <div className="mt-3 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
        Your code
      </p>
      <p className="mt-1 select-all font-mono text-2xl font-bold tracking-[0.22em]">
        {code}
      </p>

      <button
        type="button"
        onClick={() => void share()}
        className="mt-3 w-full rounded-xl bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-800"
      >
        {copied ? 'Copied' : 'Share your code'}
      </button>

      {failed ? (
        <p role="alert" className="mt-2 text-[11px] text-rose-700">
          Could not share automatically — read the code out or type it into a
          message.
        </p>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        They can type the code when they sign up, or open your link.
      </p>
    </div>
  );
}
