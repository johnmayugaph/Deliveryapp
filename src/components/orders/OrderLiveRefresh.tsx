'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Refreshes the tracking screen while an order is in progress.
 *
 * Polling, not push. A websocket is the right answer eventually, but polling a
 * server component every few seconds is honest, costs one query, and stops by
 * itself once the order reaches a terminal state — so it does not sit burning
 * requests on a finished order. It also pauses while the tab is hidden.
 */
export function OrderLiveRefresh({
  isActive,
  intervalMs = 15_000,
}: {
  isActive: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!isActive) return;

    const tick = () => {
      if (document.visibilityState === 'visible') {
        router.refresh();
      }
    };

    const timer = window.setInterval(tick, intervalMs);
    // Catch up immediately when the customer comes back to the tab.
    document.addEventListener('visibilitychange', tick);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [isActive, intervalMs, router]);

  return null;
}
