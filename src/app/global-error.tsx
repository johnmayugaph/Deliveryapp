'use client';

import { useEffect } from 'react';

/**
 * The last resort: an error in the root layout itself.
 *
 * This replaces the entire document, `<html>` included, which is why it repeats
 * the shell and uses inline styles — the layout that would have provided them
 * is the thing that failed, and a stylesheet reference that also fails leaves
 * an unreadable page.
 *
 * It reports nothing itself, which is deliberate. Importing the report action
 * would pull the app's module graph into the one file that has to keep working
 * when that graph is broken. It does not need to: a root-layout error is a
 * server error first, so `onRequestError` has already recorded the real fault
 * with a real stack. The digest on screen is what ties a support conversation
 * to that row.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Deliberately just the console. The server hook has the real one; adding
    // a network call from the file that exists for "everything is broken" is
    // how a fallback becomes another failure.
    console.error('global error boundary', error.digest ?? error.message);
  }, [error]);

  return (
    <html lang="en-PH">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeContent: 'center',
          padding: '2rem',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#f7f7f5',
          color: '#17181a',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: '22rem' }}>
          <p style={{ fontSize: '2rem', margin: 0 }} aria-hidden>
            🛠️
          </p>
          <h1 style={{ fontSize: '1.05rem', margin: '0.75rem 0 0' }}>
            TARA could not start
          </h1>
          <p style={{ fontSize: '0.85rem', color: '#55575c', lineHeight: 1.55 }}>
            Something on our side broke before the app could load. Try again in
            a moment.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.25rem',
              width: '100%',
              padding: '0.8rem 1rem',
              borderRadius: '0.75rem',
              border: 'none',
              background: '#0a56c4',
              color: '#fff',
              fontSize: '0.85rem',
              fontWeight: 700,
            }}
          >
            Try again
          </button>
          {error.digest ? (
            <p
              style={{
                marginTop: '1.5rem',
                fontFamily: 'ui-monospace, monospace',
                fontSize: '0.62rem',
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
                color: '#83868c',
              }}
            >
              {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
