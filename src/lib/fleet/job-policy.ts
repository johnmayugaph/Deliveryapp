import { OrderStatus } from '@prisma/client';

/**
 * What counts as a rider having a job in hand.
 *
 * Pure, and in its own file for a reason this codebase has now met four times:
 * it used to live in `fleet/partner.ts`, which reaches for the session, so a
 * CLIENT component that wanted this list pulled `next/headers` into the
 * browser bundle and the page died with "You're importing a component that
 * needs next/headers". The customer's tracking map is that component.
 *
 * The rule for this repository, stated plainly: **a constant that a client
 * component might want lives in a module that imports nothing but types.**
 * `merchant/staff-policy.ts` exists for the same reason, and each of these
 * has a test asserting it stays clean.
 */

/**
 * Statuses that mean a partner is currently carrying something.
 *
 * Only the states AFTER assignment count — an order merely offered is not a
 * job. Every vertical's in-transit states are here, so a new lifecycle is
 * covered by adding its statuses rather than by finding this list later.
 */
export const ACTIVE_JOB_STATUSES: readonly OrderStatus[] = [
  OrderStatus.RIDER_ASSIGNED,
  OrderStatus.RIDER_AT_PICKUP,
  OrderStatus.SHOPPING_IN_PROGRESS,
  OrderStatus.AWAITING_BUDGET_APPROVAL,
  OrderStatus.PASSENGER_ONBOARD,
  OrderStatus.PICKED_UP,
  OrderStatus.IN_TRANSIT,
  OrderStatus.ARRIVED_AT_DROPOFF,
];
