'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeAction } from '@/lib/actions/subscription-actions';

/**
 * Sign up for the plan.
 *
 * The label is "Subscribe" and the sentence under it says what actually
 * happens: nothing is charged, a bill appears, and the benefits start once
 * somebody has confirmed the transfer. A button that said "Start my benefits"
 * would be selling something this rail cannot deliver in the moment.
 *
 * `router.refresh()` on success for the same reason the console's forms do it:
 * `revalidatePath` invalidates the server's copy, and a server action called
 * from a client function is not a navigation, so without it the page keeps
 * rendering the pre-subscription state and the bill never appears.
 */
export function SubscribeButton({ priceLabel }: { priceLabel: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div>
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await subscribeAction();
            if (!result.ok) {
              setError(result.message);
              return;
            }
            router.refresh();
          })
        }
        className="w-full rounded-xl bg-brand-700 px-3 py-3 text-sm font-bold text-white transition-colors hover:bg-brand-800 disabled:bg-ink-faint"
      >
        {isPending ? 'Signing you up…' : `Subscribe — ${priceLabel} a month`}
      </button>

      {error ? (
        <p role="alert" className="mt-2 text-xs font-medium text-rose-700">
          {error}
        </p>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
        Nothing is charged now. We will show you where to send the transfer,
        and your benefits start once we have confirmed it.
      </p>
    </div>
  );
}
