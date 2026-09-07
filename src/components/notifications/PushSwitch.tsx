'use client';

import { useCallback, useEffect, useState } from 'react';
import { disablePushAction, registerPushAction } from '@/lib/actions/push-actions';

/**
 * The push switch.
 *
 * Push is the one part of the app that cannot work without JavaScript, because
 * the subscription is created by the browser and does not exist until it
 * resolves. So this component is honest about the four states a browser can be
 * in, rather than showing one button that sometimes does nothing:
 *
 *   unsupported  — no service worker or no Push API. Nothing to offer.
 *   denied       — permission was refused, and the site cannot ask again. Only
 *                  the browser's own settings can undo it, so say so.
 *   off          — supported, not yet granted or not subscribed here.
 *   on           — subscribed, and the server has the keys.
 *
 * The `denied` case is the one worth the code. A button that asks again after a
 * refusal does nothing at all — the browser resolves it immediately without
 * showing a prompt — and a person taps it repeatedly wondering what is broken.
 */

type PushState = 'checking' | 'unsupported' | 'denied' | 'off' | 'on';

export interface PushSwitchProps {
  /** Our VAPID public key, from the server. The browser binds to it. */
  vapidPublicKey: string;
  /** Whether the account's PUSH channel switch is currently on. */
  enabledForAccount: boolean;
}

/** The browser wants the key as a Uint8Array, not base64url. */
function decodeVapidKey(base64Url: string): Uint8Array {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=');
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function PushSwitch({ vapidPublicKey, enabledForAccount }: PushSwitchProps) {
  const [state, setState] = useState<PushState>('checking');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /**
   * Reconciles the browser with the server on every mount.
   *
   * If permission is granted and a subscription exists, it is re-registered —
   * see `registerPushAction` for why that has to happen on each visit rather
   * than only when the switch is flipped.
   */
  useEffect(() => {
    let cancelled = false;

    async function reconcile() {
      if (!isSupported()) {
        if (!cancelled) setState('unsupported');
        return;
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setState('denied');
        return;
      }
      if (Notification.permission !== 'granted') {
        if (!cancelled) setState('off');
        return;
      }

      try {
        const registration = await navigator.serviceWorker.register('/sw.js');
        const existing = await registration.pushManager.getSubscription();
        if (cancelled) return;

        if (!existing) {
          setState('off');
          return;
        }

        // Permission is granted and the browser has a subscription, so the
        // stored keys are refreshed whether or not the account switch is on.
        // Turning the switch back on must not require re-granting permission.
        const result = await registerPushAction(
          existing.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } },
          navigator.userAgent,
        );
        if (cancelled) return;
        setState(result.ok && enabledForAccount ? 'on' : result.ok ? 'on' : 'off');
        if (!result.ok && result.message) setMessage(result.message);
      } catch {
        if (!cancelled) setState('off');
      }
    }

    void reconcile();
    return () => {
      cancelled = true;
    };
  }, [enabledForAccount]);

  const turnOn = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'denied') {
        setState('denied');
        return;
      }
      if (permission !== 'granted') {
        // Dismissed rather than refused. The browser will ask again later.
        setMessage('No answer yet — tap again when you are ready to allow it.');
        return;
      }

      const registration = await navigator.serviceWorker.register('/sw.js');
      // `userVisibleOnly` is required by Chrome and is also a promise we keep:
      // every push this app sends shows a notification.
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(vapidPublicKey),
      });

      const result = await registerPushAction(
        subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } },
        navigator.userAgent,
      );
      if (result.ok) {
        setState('on');
      } else {
        setMessage(result.message ?? 'That did not work. Try again.');
      }
    } catch {
      setMessage(
        'This browser would not set up notifications. It may be in private ' +
          'browsing, where push is unavailable.',
      );
    } finally {
      setBusy(false);
    }
  }, [vapidPublicKey]);

  const turnOff = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      // Server first. If the browser-side unsubscribe fails we have still
      // stopped sending, which is what the person asked for; the reverse order
      // would leave a browser that keeps receiving.
      await disablePushAction();

      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      const existing = await registration?.pushManager.getSubscription();
      await existing?.unsubscribe();

      setState('off');
    } finally {
      setBusy(false);
    }
  }, []);

  if (state === 'checking') {
    // No spinner: this resolves in a frame or two, and a flash of loading state
    // beside a settings row reads as breakage.
    return null;
  }

  return (
    <section
      aria-labelledby="push-heading"
      className="mx-4 mt-4 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
    >
      <h2 id="push-heading" className="text-[13px] font-semibold">
        Notifications on this device
      </h2>

      {state === 'unsupported' ? (
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          This browser cannot show notifications. Everything still arrives in the
          inbox below, and we text you the ones that need an answer.
        </p>
      ) : null}

      {state === 'denied' ? (
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          Notifications are blocked for TARA in this browser, and we cannot ask
          again from here — you would have to allow them in the browser&apos;s own
          site settings. Until then, everything is in the inbox below.
        </p>
      ) : null}

      {state === 'off' ? (
        <>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Get order updates on your lock screen, free, even with the app closed.
          </p>
          <button
            type="button"
            onClick={turnOn}
            disabled={busy}
            className="mt-3 rounded-xl bg-brand-700 px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Setting up…' : 'Turn on notifications'}
          </button>
        </>
      ) : null}

      {state === 'on' ? (
        <>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            On for this device. Updates about one order replace each other, so
            your lock screen shows where it is now rather than a list.
          </p>
          <button
            type="button"
            onClick={turnOff}
            disabled={busy}
            className="mt-3 rounded-xl bg-surface-sunken px-3 py-2 text-[13px] font-semibold disabled:opacity-60"
          >
            {busy ? 'Turning off…' : 'Turn off notifications'}
          </button>
        </>
      ) : null}

      {message ? (
        <p role="status" className="mt-2 text-xs leading-relaxed text-ink-muted">
          {message}
        </p>
      ) : null}
    </section>
  );
}
