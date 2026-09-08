'use client';

import { useEffect, useRef, useState } from 'react';
import { updateLocationAction } from '@/lib/actions/fleet-actions';
import {
  SHARE_FLUSH_MS,
  SHARE_INTERVAL_MS,
  SHARE_MIN_METRES,
  shouldShareFix,
  type Fix,
} from '@/lib/orders/tracking';

/**
 * The rider's phone reporting where it is.
 *
 * This is the half of live tracking that did not exist. `updateLocationAction`
 * has been in the codebase since dispatch was built and **nothing ever called
 * it**: a position was written once, when a partner went online, and then
 * aged. Dispatch was ranking candidates on where they had been when they
 * started their shift, and a customer's map — had there been one — would have
 * shown a motorcycle parked wherever the rider had breakfast.
 *
 * `watchPosition` rather than a timer around `getCurrentPosition`: the browser
 * is already keeping a fix for its own purposes, and asking it to start the
 * radio afresh every fifteen seconds is how an app becomes the reason a
 * rider's battery dies before their shift ends. What IS throttled is the
 * writing — every fifteen seconds AND twenty-five metres of movement, so a
 * phone at a red light is quiet.
 *
 * It runs only while the rider is online, which is the same thing as saying it
 * runs only while they are available for work. Going offline stops it, and the
 * rider can see that it is running: a background location share nobody
 * mentions is the kind of thing that ends up in a news story.
 *
 * The newest reading is HELD rather than dropped when the throttle refuses
 * it, and a small timer reconsiders it. `watchPosition` reports changes, so a
 * rider who moves and then stops gets one callback — and if that callback
 * lands inside the throttle window and is thrown away, the position they
 * stopped at is never written. Stopping is what arriving looks like, which
 * makes that the worst possible fix to lose.
 */
export function LocationShare({ isOnline }: { isOnline: boolean }) {
  /** The newest reading the phone has given us, sent or not. */
  const latest = useRef<Fix | null>(null);
  /** The reading the database is known to hold. */
  const lastSent = useRef<Fix | null>(null);
  const inFlight = useRef(false);
  const [state, setState] = useState<'IDLE' | 'SHARING' | 'DENIED' | 'UNAVAILABLE'>(
    'IDLE',
  );
  const [sentAt, setSentAt] = useState<number | null>(null);

  useEffect(() => {
    if (!isOnline) {
      setState('IDLE');
      latest.current = null;
      lastSent.current = null;
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      // Also what an insecure origin looks like: browsers withhold geolocation
      // outside HTTPS (localhost excepted), so a deployment served over plain
      // http lands here rather than on a permission prompt.
      setState('UNAVAILABLE');
      return;
    }

    setState('SHARING');

    function share(): void {
      const next = latest.current;
      if (next === null || inFlight.current) return;
      if (!shouldShareFix(lastSent.current, next, Date.now())) return;

      // Counted before the write, not after: a write that fails is still an
      // attempt, and retrying it every three seconds for the rest of a shift
      // is worse than being one interval behind. `lastSent` moves only on
      // success, so the next attempt still carries the newest position.
      inFlight.current = true;
      const sending = { ...next, at: Date.now() };
      void updateLocationAction({
        latitude: sending.latitude,
        longitude: sending.longitude,
      })
        .then((result) => {
          if (!result.ok) return;
          lastSent.current = sending;
          setSentAt(sending.at);
        })
        .finally(() => {
          inFlight.current = false;
        });
    }

    const watch = navigator.geolocation.watchPosition(
      (position) => {
        latest.current = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          at: Date.now(),
        };
        share();
      },
      (error) => {
        // PERMISSION_DENIED is 1. Everything else — a timeout, no fix indoors
        // — is temporary and the watch keeps trying, so it is not worth
        // telling the rider about.
        if (error.code === 1) setState('DENIED');
      },
      {
        enableHighAccuracy: true,
        // A fix up to fifteen seconds old is fine to reuse: it saves the radio
        // a wake-up and is well inside the freshness window the customer's
        // map applies.
        maximumAge: SHARE_INTERVAL_MS,
        timeout: 20_000,
      },
    );

    const flush = window.setInterval(share, SHARE_FLUSH_MS);

    return () => {
      navigator.geolocation.clearWatch(watch);
      window.clearInterval(flush);
    };
  }, [isOnline]);

  if (!isOnline || state === 'IDLE') return null;

  return (
    <p
      className={`px-4 pb-2 text-[11px] leading-relaxed ${
        state === 'SHARING' ? 'text-ink-faint' : 'text-amber-700'
      }`}
      role={state === 'SHARING' ? undefined : 'status'}
    >
      {state === 'SHARING' ? (
        <>
          Sharing your location while you are online, so customers can see you
          coming. Every {Math.round(SHARE_INTERVAL_MS / 1000)} seconds, and only
          when you have moved {SHARE_MIN_METRES} metres.
          {sentAt === null ? ' Waiting for a first fix…' : ''}
        </>
      ) : state === 'DENIED' ? (
        <>
          Location is blocked for this site, so customers cannot see you coming
          and you are further down the list for nearby jobs. Allow it in your
          browser settings.
        </>
      ) : (
        <>
          This browser will not share a location. On a phone that usually means
          the site is not on a secure connection.
        </>
      )}
    </p>
  );
}
