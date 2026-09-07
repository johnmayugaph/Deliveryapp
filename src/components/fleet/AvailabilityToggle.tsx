'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setAvailabilityAction } from '@/lib/actions/fleet-actions';

/**
 * Online / offline.
 *
 * Going online needs a position, because dispatch ranks candidates on distance
 * and a partner with no location can never be a candidate — appearing "online"
 * while being unreachable would just mean sitting there receiving nothing and
 * concluding the app is broken.
 *
 * The browser's geolocation is the source. When it is refused, the partner is
 * told exactly why they cannot go online rather than being left with a button
 * that does nothing.
 */
export function AvailabilityToggle({
  isOnline,
  canGoOnline,
  homeLatitude,
  homeLongitude,
}: {
  isOnline: boolean;
  canGoOnline: boolean;
  /** Fallback position, so a desktop browser or a refused prompt still works. */
  homeLatitude: number | null;
  homeLongitude: number | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function currentPosition(): Promise<{ latitude: number; longitude: number } | null> {
    return new Promise((resolve) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) =>
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          }),
        () => resolve(null),
        { timeout: 8000, maximumAge: 30_000 },
      );
    });
  }

  function toggle() {
    setError(null);
    startTransition(async () => {
      if (!isOnline) {
        const position =
          (await currentPosition()) ??
          (homeLatitude !== null && homeLongitude !== null
            ? { latitude: homeLatitude, longitude: homeLongitude }
            : null);

        if (!position) {
          setError(
            'Going online needs your location. Allow it in your browser.',
          );
          return;
        }
        const result = await setAvailabilityAction({ isOnline: true, ...position });
        if (result.ok) router.refresh();
        else setError(result.message);
        return;
      }

      const result = await setAvailabilityAction({ isOnline: false });
      if (result.ok) router.refresh();
      else setError(result.message);
    });
  }

  return (
    <div className="text-right">
      <button
        type="button"
        disabled={isPending || (!isOnline && !canGoOnline)}
        aria-pressed={isOnline}
        onClick={toggle}
        className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-50 ${
          isOnline
            ? 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
            : 'bg-surface-sunken text-ink-muted hover:bg-brand-50'
        }`}
      >
        {isPending ? '…' : isOnline ? 'Online' : 'Offline'}
      </button>
      <p className="mt-1 text-[10px] text-ink-faint">
        {isOnline ? 'Tap to go offline' : canGoOnline ? 'Tap to go online' : 'Waiting on approval'}
      </p>
      {error ? (
        <p role="alert" className="mt-1 max-w-[11rem] text-[10px] leading-snug text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
