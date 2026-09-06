'use client';

import { useTransition } from 'react';
import { signOutAction } from '@/lib/actions/auth-actions';

export function SignOutButton() {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => startTransition(() => signOutAction())}
      className="w-full rounded-xl bg-surface px-3 py-3 text-sm font-semibold text-rose-700 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-rose-50 disabled:text-ink-faint"
    >
      {isPending ? 'Signing out…' : 'Mag-sign out'}
    </button>
  );
}
