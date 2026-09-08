'use server';

import { getCurrentUser } from '@/lib/auth/session';
import { riderPositionForCustomer } from '@/lib/orders/rider-position';

/**
 * The one thing the customer's map asks for, every ten seconds.
 *
 * A whole-page refresh would re-render the timeline, the receipt and the
 * rating form to move a pin; this returns three fields. It is also why the
 * poll can be faster than the page's own fifteen-second refresh without
 * costing more.
 *
 * Times are sent as epoch milliseconds rather than `Date`, so the client can
 * compute freshness against ITS own clock. A phone whose clock is ten minutes
 * out would otherwise be told a fix is stale when it is not, or the reverse —
 * and the reverse is the one that shows a wrong pin.
 */
export interface RiderPositionResult {
  found: boolean;
  latitude?: number;
  longitude?: number;
  updatedAtMs?: number;
  /** The server's own clock, so the client can age the fix without trusting
   *  its own. */
  serverNowMs: number;
}

export async function riderPositionAction(orderId: string): Promise<RiderPositionResult> {
  const now = new Date();
  const user = await getCurrentUser();
  if (!user) return { found: false, serverNowMs: now.getTime() };

  const position = await riderPositionForCustomer(
    { orderId, userId: user.id },
    now,
  );
  if (!position) return { found: false, serverNowMs: now.getTime() };

  return {
    found: true,
    latitude: position.latitude,
    longitude: position.longitude,
    updatedAtMs: position.updatedAt.getTime(),
    serverNowMs: now.getTime(),
  };
}
