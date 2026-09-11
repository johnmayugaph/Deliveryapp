'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setStoreVisibilityAction } from '@/lib/actions/admin-actions';
import type { AdminActionResult } from '@/lib/admin/access';

/**
 * Active or inactive, as a switch.
 *
 * It replaced a whole panel — a heading, a paragraph, a reason box and a red
 * "Hide from customers" button — for what is one bit of state. Three
 * interactions and a warning colour for a thing an operator flips while
 * onboarding a shop made an everyday action look dangerous.
 *
 * OPTIMISTIC, and then corrected. The switch moves the instant it is clicked,
 * because a control that waits a second before responding is one people click
 * twice. If the server refuses — a shop with no menu cannot go Active — it
 * snaps back and says why, rather than leaving the switch lying.
 *
 * The refusal is the reason this is not a plain checkbox: "no menu yet" is a
 * real rule, and it has to be visible at the moment somebody hits it.
 */
export function StoreActiveToggle({
  storeId,
  active,
}: {
  storeId: string;
  active: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useState(active);
  const [note, setNote] = useState<AdminActionResult | null>(null);

  // The server is the truth. When the page re-renders after a refresh, or
  // somebody else changes it, `active` wins over whatever this was showing.
  const [lastSeen, setLastSeen] = useState(active);
  if (lastSeen !== active) {
    setLastSeen(active);
    setShown(active);
  }

  function flip(): void {
    const next = !shown;
    setShown(next);
    setNote(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('storeId', storeId);
      formData.set('visible', next ? '1' : '0');
      const result = await setStoreVisibilityAction(null, formData);
      if (result.ok) {
        router.refresh();
      } else {
        setShown(!next); // Refused — do not leave the switch telling a lie.
        setNote(result);
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={shown}
          aria-label="Active — customers can find this shop"
          disabled={pending}
          onClick={flip}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
            shown ? 'bg-emerald-600' : 'bg-ink-faint'
          }`}
        >
          <span
            aria-hidden
            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              shown ? 'translate-x-[1.125rem]' : 'translate-x-0.5'
            }`}
          />
        </button>
        <span
          className={`text-[11px] font-bold ${shown ? 'text-emerald-800' : 'text-ink-muted'}`}
        >
          {pending ? 'Saving…' : shown ? 'Active' : 'Inactive'}
        </span>
      </span>

      {note ? (
        <span role="alert" className="max-w-sm text-[11px] leading-snug text-rose-700">
          {note.message}
        </span>
      ) : null}
    </span>
  );
}
