'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The Turnstile widget, as a form field.
 *
 * It renders a hidden `cf-turnstile-response` input inside whatever form
 * contains it, which is how the token reaches the server action — nothing in
 * the login form declares that field, and nothing should.
 *
 * Rendered EXPLICITLY rather than by the script's own DOM scan. The scan runs
 * once when the script loads and finds whatever is in the document at that
 * moment, which is the wrong model for a form that swaps between two steps: the
 * second step's widget would never be found. Explicit rendering also gives us
 * the handle needed to remove the widget on unmount, so stepping back and forth
 * does not leave orphans behind.
 *
 * A fresh widget per step is deliberate, not incidental. A token is single-use;
 * replaying one on a resend would be rejected by Cloudflare as a duplicate,
 * which would read to the person as a broken button.
 */

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action?: string;
      callback?: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
      theme?: 'light' | 'dark' | 'auto';
      size?: 'normal' | 'flexible' | 'compact';
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Loaded once per page, however many widgets ask for it. */
let scriptPromise: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    const script = existing ?? document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => {
      // Let a later attempt try again rather than caching the failure
      // forever: this fails on a dropped connection as readily as on a
      // blocked one, and the second is not the common case.
      scriptPromise = null;
      reject(new Error('turnstile script failed to load'));
    });
    if (!existing) document.head.appendChild(script);
  });

  return scriptPromise;
}

type Status = 'loading' | 'ready' | 'solved' | 'failed';

export function CaptchaField({ siteKey }: { siteKey: string }) {
  const container = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let cancelled = false;

    loadTurnstile()
      .then(() => {
        if (cancelled || !container.current || !window.turnstile) return;
        setStatus('ready');
        widgetId.current = window.turnstile.render(container.current, {
          sitekey: siteKey,
          // Shows up in Cloudflare's own analytics, so a spike is
          // attributable to the login screen rather than to "the site".
          action: 'login',
          size: 'flexible',
          callback: () => setStatus('solved'),
          'error-callback': () => setStatus('failed'),
          'expired-callback': () => setStatus('ready'),
        });
      })
      .catch(() => {
        if (!cancelled) setStatus('failed');
      });

    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [siteKey]);

  return (
    <div>
      <div ref={container} className="min-h-[1.5rem]" />

      {status === 'failed' ? (
        <p role="alert" className="text-[11px] leading-relaxed text-rose-700">
          The security check could not load. Check your connection and reload
          the page — signing in needs it.
        </p>
      ) : null}

      {/* The first login step is otherwise built to work before the page has
          hydrated. A CAPTCHA cannot: it is JavaScript by construction. Say so
          rather than presenting a button that will be refused. */}
      <noscript>
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          Signing in needs JavaScript, for the security check that stops
          automated sign-in attempts.
        </p>
      </noscript>
    </div>
  );
}
