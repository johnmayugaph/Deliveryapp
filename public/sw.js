/**
 * TARA service worker.
 *
 * Deliberately minimal: it handles push and nothing else. No offline caching,
 * no precached shell, no fetch handler at all — a service worker that
 * intercepts requests is a second, stale copy of the app that can serve
 * yesterday's prices, and getting that wrong is worse than being online-only.
 *
 * A fetch handler belongs here eventually. It should be added as a considered
 * caching strategy, not as a side effect of wanting notifications.
 *
 * Served from /public, so its scope is the whole origin, which is what push
 * requires: the worker must be able to open any path the notification points
 * at.
 */

/* global self, clients */

// A new worker takes over immediately rather than waiting for every tab to
// close. Push handling is stateless, so there is no old state to preserve, and
// the alternative is a fixed bug that does not ship until someone reboots.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * A push arrived.
 *
 * The payload is the JSON the server encrypted. A push with no payload, or one
 * that will not parse, still shows something: browsers penalise a worker that
 * receives a push and displays nothing, and a silent push is indistinguishable
 * from a broken app.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'TARA';
  const options = {
    body: payload.body || 'You have an update.',
    icon: '/icon-192.png',
    badge: '/badge-72.png',
    // The tag collapses: a second notification for the same order replaces the
    // first, so a lock screen shows the current state rather than a history.
    tag: payload.tag || 'tara',
    renotify: Boolean(payload.tag),
    data: { href: typeof payload.href === 'string' ? payload.href : '/notifications' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * Somebody tapped it.
 *
 * Focuses an existing tab and navigates it rather than opening another one —
 * a person who taps four order updates should not end up with four tabs.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || '/notifications';

  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of windows) {
        // Same-origin only; matchAll can return clients from other scopes.
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) {
            await client.navigate(href);
          }
          return;
        }
      }

      await clients.openWindow(href);
    })(),
  );
});

/**
 * The browser rotated the subscription's keys.
 *
 * This fires without a page open, so there is no session cookie to authenticate
 * with and the new subscription cannot be registered from here. The next page
 * load re-registers, which is why the client registers on every load rather
 * than only when the switch is flipped.
 */
self.addEventListener('pushsubscriptionchange', () => {
  // Intentionally empty. See above: re-registration happens on the next visit.
});
