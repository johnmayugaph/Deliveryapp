'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { signOutEverywhereAction } from '@/lib/actions/auth-actions';
import type { ActiveSessionSummary } from '@/lib/auth/session';
import { formatDayIn } from '@/lib/time/manila';

/**
 * Where the account is signed in.
 *
 * Worth showing because sessions here are revocable — a list nobody can act on
 * would be decoration. "Sign out everywhere else" keeps the current session, so
 * nobody locks themselves out of the screen they are looking at.
 */

/** Enough of a user-agent string to recognise a device, without parsing it fully. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'iPhone o iPad';
  if (/Android/i.test(userAgent)) return 'Android';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'Mac';
  if (/Windows/i.test(userAgent)) return 'Windows';
  if (/Linux/i.test(userAgent)) return 'Linux';
  return 'Browser';
}

export function ActiveSessions({ sessions }: { sessions: ActiveSessionSummary[] }) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (sessions.length === 0) {
    return null;
  }

  const others = sessions.filter((session) => !session.isCurrent).length;

  return (
    <section aria-labelledby="sessions-heading" className="mt-5 px-4">
      <h2
        id="sessions-heading"
        className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
      >
        Signed in on
      </h2>
      <ul className="mt-2 space-y-1.5">
        {sessions.map((session) => (
          <li
            key={session.id}
            className="flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2.5 shadow-sm ring-1 ring-black/5"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {describeDevice(session.userAgent)}
                {session.isCurrent ? (
                  <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-brand-800">
                    This one
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block text-[11px] text-ink-faint">
                Last used{' '}
                {formatDayIn(session.lastSeenAt)}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {notice ? (
        <p role="status" className="mt-2 text-[11px] text-emerald-700">
          {notice}
        </p>
      ) : others > 0 ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const { revoked } = await signOutEverywhereAction();
              setNotice(`Signed out of ${revoked} other device.`);
              router.refresh();
            })
          }
          className="mt-2 text-xs font-semibold text-brand-700 disabled:text-ink-faint"
        >
          {isPending ? 'Signing out…' : `Sign out of ${others} other device`}
        </button>
      ) : null}
    </section>
  );
}
