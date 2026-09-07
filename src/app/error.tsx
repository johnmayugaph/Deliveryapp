'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { reportClientErrorAction } from '@/lib/actions/monitoring-actions';

/**
 * What a customer sees when a page breaks, and how we find out.
 *
 * Next.js renders this instead of the broken subtree. Two jobs, in this order
 * of importance:
 *
 *  1. **Report it.** Before this existed, an error here was seen by the person
 *     and by nobody else — and most people do not report a broken page, they
 *     leave. The digest is the only thing linking what they saw to the stack
 *     the server recorded, so it is sent even though it means nothing to them.
 *  2. **Offer a way out.** A dead end with an apology is still a dead end. Try
 *     again re-renders; Home always works.
 *
 * It says nothing about what went wrong. Not out of secrecy — the message is
 * genuinely useless to a customer, and a stack trace on a phone screen reads
 * as "this company is broken" rather than as information.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Fire and forget. A failure to report must not replace one broken screen
    // with another, so nothing here awaits or throws.
    void reportClientErrorAction({
      message: error.message,
      ...(error.digest === undefined ? {} : { digest: error.digest }),
      route: typeof window === 'undefined' ? undefined : window.location.pathname,
    }).catch(() => {});
  }, [error]);

  return (
    <main className="px-4 py-16">
      <div className="mx-auto max-w-sm text-center">
        <p aria-hidden className="text-4xl">
          🛠️
        </p>
        <h1 className="mt-3 text-lg font-bold">This screen did not load</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Something on our side broke, not anything you did. We have been told
          about it.
        </p>

        <div className="mt-6 space-y-2">
          <button
            type="button"
            onClick={reset}
            className="w-full rounded-xl bg-brand-700 px-4 py-3 text-sm font-bold text-white hover:bg-brand-800"
          >
            Try again
          </button>
          <Link
            href="/"
            className="block w-full rounded-xl bg-surface-sunken px-4 py-3 text-sm font-semibold text-ink hover:bg-black/5"
          >
            Go home
          </Link>
        </div>

        {/* For a support conversation: "it says A1B2C3 at the bottom" is the
            difference between finding the stack and guessing. Small, quiet,
            and selectable. */}
        {error.digest ? (
          <p className="mt-6 select-all font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            {error.digest}
          </p>
        ) : null}
      </div>
    </main>
  );
}
