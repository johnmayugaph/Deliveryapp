'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { signOutEverywhereAction } from '@/lib/actions/auth-actions';
import type { ActiveSessionList } from '@/lib/auth/session';
import {
  describeLastUse,
  describeLastUsePrecision,
  describeRevoke,
  deviceRows,
  notListedCount,
} from '@/lib/auth/devices';
import { countOf } from '@/lib/text/count';
import { formatFullDayIn } from '@/lib/time/manila';

/**
 * Where the account is signed in.
 *
 * Worth showing because sessions here are revocable — a list nobody can act on
 * would be decoration. "Sign out everywhere else" keeps the current session, so
 * nobody locks themselves out of the screen they are looking at.
 *
 * Every date and every count on it comes from `lib/auth/devices`, which is
 * where the reasons are: the old "Last used" line was up to five days stale on
 * the row for the session rendering it, and the old button counted the visible
 * rows rather than the sessions it was about to revoke.
 */

export function ActiveSessions({ sessions }: { sessions: ActiveSessionList }) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (sessions.rows.length === 0) {
    return null;
  }

  const rows = deviceRows(sessions.rows);
  const revokeLabel = describeRevoke(sessions.otherCount, countOf);
  const hidden = notListedCount(rows.length, sessions.otherCount);

  return (
    <section aria-labelledby="sessions-heading" className="mt-5 px-4">
      <h2
        id="sessions-heading"
        className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
      >
        Signed in on
      </h2>
      <ul className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-3 rounded-xl bg-surface px-3 py-2.5 shadow-sm ring-1 ring-black/5"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {row.device}
                {row.isCurrent ? (
                  <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-brand-800">
                    This one
                  </span>
                ) : null}
              </span>
              {/* When it started, which is exact and is the fact somebody
                  scanning this list for a stranger actually needs. */}
              <span className="mt-0.5 block text-[11px] text-ink-faint">
                Signed in {formatFullDayIn(row.signedInAt)} ·{' '}
                {describeLastUse(row.lastUse, formatFullDayIn)}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {/* The cap, said out loud. A list that silently stops at twenty is a
          list somebody scans for a device that is not on it. */}
      {hidden > 0 ? (
        <p className="mt-1.5 text-[11px] text-ink-faint">
          {countOf(hidden, 'more session')} not shown. Signing out below covers
          every one of them.
        </p>
      ) : null}

      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
        {describeLastUsePrecision()}
      </p>

      {notice ? (
        <p role="status" className="mt-2 text-[11px] text-emerald-700">
          {notice}
        </p>
      ) : revokeLabel ? (
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const { revoked } = await signOutEverywhereAction();
              // The action's own count, not the one on the button: they agree
              // by construction now, and if they ever stop the truth is what
              // was actually revoked.
              setNotice(`Signed out of ${countOf(revoked, 'other device')}.`);
              router.refresh();
            })
          }
          className="mt-2 text-xs font-semibold text-brand-700 disabled:text-ink-faint"
        >
          {isPending ? 'Signing out…' : revokeLabel}
        </button>
      ) : null}
    </section>
  );
}
