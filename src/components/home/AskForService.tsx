'use client';

import { useActionState, useEffect, useState } from 'react';
import { registerInterestAction } from '@/lib/actions/interest-actions';
import type { InterestActionResult } from '@/lib/actions/interest-actions';
import { describeAskCount } from '@/lib/services/presentation';

/**
 * A coming-soon tile you can actually tell something.
 *
 * The tile used to be a dimmed `<div>` — correctly, since there was nothing to
 * activate. Now there is: a tap records that somebody in this city wants this
 * vertical, which is the only evidence the product has for what to build next,
 * and it earns them a message when it opens.
 *
 * The markup inside comes from the server component so that every visual
 * difference still derives from the `Service` row. This owns the parts that
 * change when you tap: the badge, and the line underneath.
 *
 * Works without JavaScript. The form posts natively, the action runs, and the
 * home screen re-renders — which for a signed-in person shows the tile already
 * marked, because `askedByMe` comes from the database. An anonymous visitor
 * with no JavaScript gets a tile that looks unchanged; their tap is still
 * counted, which is the part that matters.
 */

const STORAGE_KEY = 'tara-asked-for';

export function AskForService({
  serviceKey,
  displayName,
  cityName,
  askedByMe,
  tileBackground,
  children,
}: {
  serviceKey: string;
  displayName: string;
  cityName: string;
  /** From the database, for a signed-in person. */
  askedByMe: boolean;
  tileBackground: string;
  children: React.ReactNode;
}) {
  const [result, formAction, pending] = useActionState<
    InterestActionResult | null,
    FormData
  >(async (_previous, formData) => registerInterestAction(formData), null);

  /**
   * The anonymous half of the same memory.
   *
   * A signed-in person's tap is a row, so the tile knows on every page load.
   * Somebody who has not signed in has nothing to look themselves up by, and
   * the honest options are to forget them or to remember on their own device.
   * This is per-device and never leaves it.
   */
  const [rememberedLocally, setRememberedLocally] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const asked: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(asked) && asked.includes(`${serviceKey}:${cityName}`)) {
        setRememberedLocally(true);
      }
    } catch {
      /* Private window, or site data blocked. The tile still works. */
    }
  }, [serviceKey, cityName]);

  useEffect(() => {
    if (!result?.ok) return;
    setRememberedLocally(true);
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const asked: unknown = raw ? JSON.parse(raw) : [];
      const next = new Set(Array.isArray(asked) ? (asked as string[]) : []);
      next.add(`${serviceKey}:${cityName}`);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      /* As above. */
    }
  }, [result, serviceKey, cityName]);

  const asked = askedByMe || rememberedLocally;

  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="serviceKey" value={serviceKey} />
      <button
        type="submit"
        disabled={pending}
        aria-label={
          asked
            ? `${displayName} is not in ${cityName} yet. You have asked for it.`
            : `Tell us you want ${displayName} in ${cityName}`
        }
        className={`relative flex flex-col rounded-tile p-3 text-left transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-wait ${
          asked ? 'opacity-80' : 'opacity-55 hover:opacity-80'
        } ${tileBackground}`}
      >
        <span
          className={`absolute right-2 top-2 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
            asked ? 'bg-brand-600 text-white' : 'bg-white/85 text-ink-muted'
          }`}
        >
          {asked ? 'Asked ✓' : 'Coming soon'}
        </span>
        {children}
        <span
          aria-live="polite"
          className="mt-1 block text-[10px] font-medium leading-tight text-ink-muted"
        >
          {pending
            ? 'Noting…'
            : result?.ok
              ? describeAskCount(result.accounts)
              : result
                ? result.message
                : asked
                  ? 'We will tell you'
                  : 'Want this? Tap'}
        </span>
      </button>
    </form>
  );
}
