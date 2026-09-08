import { prisma } from '@/lib/prisma';
import { isInPhilippines } from '@/lib/geo/philippines';
import {
  isTrackableStatus,
  positionIsFresh,
  type RiderPosition,
} from '@/lib/orders/tracking';

/**
 * Where the rider carrying THIS order is, if the person asking is its customer.
 *
 * The only way a position leaves the database, and it takes an order id and a
 * user id rather than a rider id — deliberately. A function that answered
 * "where is partner X" would be one query away from a screen that tracks a
 * person rather than a delivery, and there is no honest customer-facing reason
 * to want that.
 *
 * Four gates, in this order, because each one makes the next meaningful:
 *
 *  1. **The order is theirs.** Checked against `customerId`, not against
 *     anything the client sent.
 *  2. **Somebody is carrying it.** A trackable status, from the same list the
 *     rider's own screen uses.
 *  3. **There is a fix at all.** A rider who has never shared has nulls.
 *  4. **The fix is recent.** Past ninety seconds this returns null and the
 *     screen says it has lost the signal, rather than showing a stale pin
 *     that reads as a stationary motorcycle.
 *
 * Returns null in every refusal case, with no distinction between them. That
 * is not laziness: a caller who could tell "not your order" from "no fix yet"
 * could use this to learn whether an order id exists.
 */
export async function riderPositionForCustomer(
  input: { orderId: string; userId: string },
  now: Date = new Date(),
): Promise<RiderPosition | null> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: {
      customerId: true,
      status: true,
      assignedRider: {
        select: {
          currentLatitude: true,
          currentLongitude: true,
          locationUpdatedAt: true,
          isSuspended: true,
        },
      },
    },
  });

  if (!order) return null;
  if (order.customerId !== input.userId) return null;
  if (!isTrackableStatus(order.status)) return null;

  const rider = order.assignedRider;
  if (!rider) return null;
  if (rider.currentLatitude === null || rider.currentLongitude === null) return null;
  if (rider.locationUpdatedAt === null) return null;
  if (!positionIsFresh(rider.locationUpdatedAt, now)) return null;

  // A reading outside the country is a bad fix rather than a rider: geolocation
  // reports (0, 0) and other nonsense on a failed lock, and a pin in the Gulf
  // of Guinea would put the customer's map over the ocean and their trust
  // somewhere similar.
  if (
    !isInPhilippines({
      latitude: rider.currentLatitude,
      longitude: rider.currentLongitude,
    })
  ) {
    return null;
  }

  return {
    latitude: rider.currentLatitude,
    longitude: rider.currentLongitude,
    updatedAt: rider.locationUpdatedAt,
  };
}
