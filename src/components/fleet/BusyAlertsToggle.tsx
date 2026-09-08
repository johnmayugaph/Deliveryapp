'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setBusyAlertsAction } from '@/lib/actions/fleet-actions';

/**
 * Whether to be told when the market goes busy.
 *
 * The only per-kind switch in the app, and it exists because this is the only
 * message that asks a rider to do something rather than telling them something
 * happened. The channel switches in the customer's settings cannot express it:
 * turning push off to avoid "come out, it is busy" would also turn off "an
 * order is waiting for you".
 *
 * The copy says what stays. A switch that reads as "stop telling me about
 * surge" would be read as "stop paying me surge" by somebody scanning it, and
 * a rider who believes that will never touch it — so it says out loud that the
 * money and the panel are unaffected.
 */
export function BusyAlertsToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function change(next: boolean): void {
    // Optimistic, then reconciled: a switch that waits on a round trip before
    // moving reads as broken on a phone with one bar.
    setOn(next);
    setError(null);
    startTransition(async () => {
      const result = await setBusyAlertsAction(next);
      if (result.ok) {
        router.refresh();
      } else {
        setOn(!next);
        setError(result.message);
      }
    });
  }

  return (
    <div className="rounded-xl bg-surface px-4 py-3 shadow-sm ring-1 ring-black/5">
      <label className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold">
            Tell me when it gets busy
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-muted">
            A notification when your city has more orders than riders and there
            is extra on every job. Never between 10pm and 6am. Turning this off
            does not change what you are paid, and the amount still shows on
            your offers board.
          </span>
        </span>
        <input
          type="checkbox"
          checked={on}
          disabled={isPending}
          onChange={(event) => change(event.target.checked)}
          className="mt-0.5 h-5 w-5 flex-none accent-brand-700 disabled:opacity-60"
        />
      </label>
      {error ? (
        <p role="alert" className="mt-1.5 text-[11px] text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
