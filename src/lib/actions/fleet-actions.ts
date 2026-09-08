'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  DispatchOfferStatus,
  OrderActor,
  OrderStatus,
  VehicleType,
  VerificationStatus,
  ServiceKey,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireOnboardedUser } from '@/lib/auth/session';
import { requireFleetPartner } from '@/lib/fleet/partner';
import { recomputeAcceptanceRate } from '@/lib/fleet/dispatch-offers';
import { syncEnabledServices } from '@/lib/fleet/dispatch';
import { transitionOrder } from '@/lib/orders/state-machine';
import { completeOrder } from '@/lib/orders/maintenance';
import { getLifecycle } from '@/lib/orders/transitions';

/**
 * Fleet partner actions.
 *
 * Every one resolves the partner from the session, never from an id in the
 * arguments — a partner cannot claim a job as somebody else, or move an order
 * that is not theirs. Order transitions go through the state machine as
 * `OrderActor.FLEET_PARTNER`, so what a partner may do is the lifecycle map's
 * decision rather than this file's.
 */

export type FleetActionResult =
  | { ok: true; status?: OrderStatus }
  | { ok: false; message: string };

function revalidateFleet(orderId?: string): void {
  revalidatePath('/fleet');
  revalidatePath('/fleet/job');
  if (orderId) {
    revalidatePath(`/orders/${orderId}`);
    revalidatePath('/orders');
  }
}

// -----------------------------------------------------------------------------
// Availability
// -----------------------------------------------------------------------------

/**
 * Go online or offline, with a position.
 *
 * The position is required to go online: dispatch ranks candidates on distance,
 * and a partner with no location can never be a candidate, so letting them
 * appear "online" would just mean sitting there receiving nothing and
 * concluding the app is broken.
 */
export async function setAvailabilityAction(input: {
  isOnline: boolean;
  latitude?: number;
  longitude?: number;
}): Promise<FleetActionResult> {
  try {
    const partner = await requireFleetPartner();

    if (partner.isSuspended) {
      return { ok: false, message: 'Your account is suspended. Contact support.' };
    }

    if (input.isOnline) {
      if (partner.enabledServices.length === 0) {
        return {
          ok: false,
          message: 'No service is approved yet. Wait for approval before going online.',
        };
      }
      const { latitude, longitude } = input;
      if (
        typeof latitude !== 'number' ||
        typeof longitude !== 'number' ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      ) {
        return { ok: false, message: 'Going online needs your location.' };
      }

      await prisma.fleetPartner.update({
        where: { id: partner.id },
        data: {
          isOnline: true,
          currentLatitude: latitude,
          currentLongitude: longitude,
          locationUpdatedAt: new Date(),
        },
      });
    } else {
      // Position is kept on going offline; it is the last known place, which is
      // what support wants if a job went wrong.
      await prisma.fleetPartner.update({
        where: { id: partner.id },
        data: { isOnline: false },
      });
    }

    revalidateFleet();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toFleetMessage(error) };
  }
}

/**
 * Turn busy alerts on or off.
 *
 * A rider's own decision about being invited to work, and the reason it is not
 * a `NotificationPreference` row: that table is keyed by channel, so declining
 * "it is busy, come out" through it would also mute the push that says an
 * order is waiting. Those are not the same consent.
 *
 * Nothing else changes. The busy panel stays on their own screen either way —
 * what this switches off is the interruption, not the information.
 */
export async function setBusyAlertsAction(
  wantsBusyAlerts: boolean,
): Promise<FleetActionResult> {
  try {
    const partner = await requireFleetPartner();
    await prisma.fleetPartner.update({
      where: { id: partner.id },
      data: { wantsBusyAlerts },
    });
    revalidateFleet();
    revalidatePath('/fleet/profile');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toFleetMessage(error) };
  }
}

/** Position update while online, for the candidate query's bounding box. */
export async function updateLocationAction(input: {
  latitude: number;
  longitude: number;
}): Promise<FleetActionResult> {
  try {
    const partner = await requireFleetPartner();
    if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
      return { ok: false, message: 'Could not read your location.' };
    }
    await prisma.fleetPartner.update({
      where: { id: partner.id },
      data: {
        currentLatitude: input.latitude,
        currentLongitude: input.longitude,
        locationUpdatedAt: new Date(),
      },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toFleetMessage(error) };
  }
}

// -----------------------------------------------------------------------------
// Offers
// -----------------------------------------------------------------------------

/**
 * Claims an offered job.
 *
 * The race between partners is settled by the state machine's optimistic guard:
 * the update matches only while the order is still awaiting assignment, so the
 * second claimant fails cleanly rather than both being assigned. Their offer is
 * marked SUPERSEDED, which deliberately does NOT count against their acceptance
 * rate — being beaten to a job is not a decision they made.
 */
export async function acceptOfferAction(offerId: string): Promise<FleetActionResult> {
  try {
    const partner = await requireFleetPartner();
    const now = new Date();

    const offer = await prisma.dispatchOffer.findUnique({
      where: { id: offerId },
      include: { order: true },
    });

    // Scoped to this partner: an offer id belonging to somebody else is simply
    // not found, rather than an error that confirms it exists.
    if (!offer || offer.fleetPartnerId !== partner.id) {
      return { ok: false, message: 'That offer is gone.' };
    }
    if (offer.status !== DispatchOfferStatus.PENDING) {
      return { ok: false, message: 'That offer has already been answered.' };
    }
    if (offer.expiresAt <= now) {
      return { ok: false, message: 'That offer has expired.' };
    }

    const existing = await prisma.order.findFirst({
      where: {
        assignedRiderId: partner.id,
        status: {
          in: [
            OrderStatus.RIDER_ASSIGNED,
            OrderStatus.RIDER_AT_PICKUP,
            OrderStatus.SHOPPING_IN_PROGRESS,
            OrderStatus.AWAITING_BUDGET_APPROVAL,
            OrderStatus.PASSENGER_ONBOARD,
            OrderStatus.PICKED_UP,
            OrderStatus.IN_TRANSIT,
            OrderStatus.ARRIVED_AT_DROPOFF,
          ],
        },
      },
      select: { orderNumber: true },
    });
    if (existing) {
      return {
        ok: false,
        message: `You are still holding order ${existing.orderNumber}. Finish it first.`,
      };
    }

    const order = await prisma.$transaction(async (tx) => {
      // Assignment and the offer's answer are one unit: an accepted offer with
      // no assignment, or the reverse, would both be wrong.
      const assigned = await transitionOrder(
        {
          orderId: offer.orderId,
          to: OrderStatus.RIDER_ASSIGNED,
          actor: OrderActor.FLEET_PARTNER,
          actorUserId: partner.userId,
          assignedRiderId: partner.id,
          metadata: { offerId: offer.id, rank: offer.rank },
        },
        tx,
      );

      await tx.dispatchOffer.update({
        where: { id: offer.id },
        data: { status: DispatchOfferStatus.ACCEPTED, respondedAt: now },
      });

      // Everybody else was beaten to it, not unresponsive.
      await tx.dispatchOffer.updateMany({
        where: {
          orderId: offer.orderId,
          id: { not: offer.id },
          status: DispatchOfferStatus.PENDING,
        },
        data: { status: DispatchOfferStatus.SUPERSEDED, respondedAt: now },
      });

      await recomputeAcceptanceRate(partner.id, tx);
      return assigned;
    });

    revalidateFleet(order.id);
    redirect('/fleet/job');
  } catch (error) {
    // `redirect` throws by design; let it through.
    if (error instanceof Error && error.message === 'NEXT_REDIRECT') throw error;
    if (typeof error === 'object' && error !== null && 'digest' in error) throw error;
    return { ok: false, message: toFleetMessage(error) };
  }
}

/** Declines an offer. Counts against acceptance rate — it is a real answer. */
export async function declineOfferAction(offerId: string): Promise<FleetActionResult> {
  try {
    const partner = await requireFleetPartner();

    const { count } = await prisma.dispatchOffer.updateMany({
      where: { id: offerId, fleetPartnerId: partner.id, status: DispatchOfferStatus.PENDING },
      data: { status: DispatchOfferStatus.DECLINED, respondedAt: new Date() },
    });
    if (count === 0) {
      return { ok: false, message: 'That offer is gone.' };
    }

    await recomputeAcceptanceRate(partner.id);
    revalidateFleet();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toFleetMessage(error) };
  }
}

// -----------------------------------------------------------------------------
// The job
// -----------------------------------------------------------------------------

/**
 * Advances the active job.
 *
 * The target is checked against the lifecycle map for the order's own vertical,
 * so a partner cannot skip a step and this function needs no knowledge of what
 * they are carrying.
 */
export async function advanceJobAction(
  orderId: string,
  to: OrderStatus,
): Promise<FleetActionResult> {
  try {
    const partner = await requireFleetPartner();

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, assignedRiderId: true, serviceType: true, status: true },
    });
    if (!order || order.assignedRiderId !== partner.id) {
      return { ok: false, message: 'That order is not yours.' };
    }

    const lifecycle = getLifecycle(order.serviceType);
    const permitted = (lifecycle.transitions[order.status] ?? []).includes(to);
    if (!permitted) {
      return { ok: false, message: 'The order has changed. Refresh.' };
    }

    const updated = await transitionOrder({
      orderId,
      to,
      actor: OrderActor.FLEET_PARTNER,
      actorUserId: partner.userId,
    });

    // Delivering closes the loop: completion is what grants the customer any
    // credit-back their subscription accrued, and what counts the job as paid.
    const terminalDelivery =
      to === OrderStatus.DELIVERED || to === OrderStatus.DROPPED_OFF;

    if (terminalDelivery) {
      const completion = await completeOrder({
        orderId,
        actor: OrderActor.SYSTEM,
        actorUserId: partner.userId,
      });
      await prisma.fleetPartner.update({
        where: { id: partner.id },
        data: { completedOrderCount: { increment: 1 } },
      });
      revalidateFleet(orderId);
      return { ok: true, status: completion.order.status };
    }

    revalidateFleet(orderId);
    return { ok: true, status: updated.status };
  } catch (error) {
    return { ok: false, message: toFleetMessage(error) };
  }
}

/** Gives up an assigned job, with a reason. Returns it to dispatch. */
export async function abandonJobAction(
  orderId: string,
  reason: string,
): Promise<FleetActionResult> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    return { ok: false, message: 'Give a reason.' };
  }

  try {
    const partner = await requireFleetPartner();
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, assignedRiderId: true, serviceType: true, status: true },
    });
    if (!order || order.assignedRiderId !== partner.id) {
      return { ok: false, message: 'That order is not yours.' };
    }

    const lifecycle = getLifecycle(order.serviceType);
    const canReturn = (lifecycle.transitions[order.status] ?? []).includes(
      OrderStatus.AWAITING_RIDER_ASSIGNMENT,
    );

    const updated = await prisma.$transaction(async (tx) => {
      if (canReturn) {
        // Back to the pool rather than cancelled: the customer's food is still
        // sitting on a counter, and another partner can still collect it.
        const returned = await transitionOrder(
          {
            orderId,
            to: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
            actor: OrderActor.SYSTEM,
            reason: `Handed back to dispatch: ${trimmed}`,
          },
          tx,
        );
        await tx.order.update({ where: { id: orderId }, data: { assignedRiderId: null } });
        return returned;
      }

      return transitionOrder(
        {
          orderId,
          to: OrderStatus.CANCELLED_BY_RIDER,
          actor: OrderActor.FLEET_PARTNER,
          actorUserId: partner.userId,
          reason: trimmed,
        },
        tx,
      );
    });

    revalidateFleet(orderId);
    return { ok: true, status: updated.status };
  } catch (error) {
    return { ok: false, message: toFleetMessage(error) };
  }
}

// -----------------------------------------------------------------------------
// Onboarding
// -----------------------------------------------------------------------------

/** Returns only on failure: success redirects. */
export type ApplyResult = { ok: false; message: string };

/**
 * Applies to join the fleet.
 *
 * Creates the `FleetPartner` record and a verification row per service applied
 * for, all PENDING. `enabledServices` stays empty until somebody approves them
 * — a partner is not approved by asking, and the per-service model is the whole
 * point: approval for food is not approval to carry a passenger.
 */
export async function applyToFleetAction(input: {
  vehicleType: VehicleType;
  vehiclePlate?: string;
  serviceKeys: ServiceKey[];
}): Promise<ApplyResult> {
  const user = await requireOnboardedUser();

  const services = input.serviceKeys.filter((key) =>
    (Object.values(ServiceKey) as string[]).includes(key),
  );
  if (services.length === 0) {
    return { ok: false, message: 'Pumili ng kahit isang service.' };
  }
  if (!(Object.values(VehicleType) as string[]).includes(input.vehicleType)) {
    return { ok: false, message: 'Choose a vehicle.' };
  }

  const existing = await prisma.fleetPartner.findUnique({ where: { userId: user.id } });
  if (existing) {
    return { ok: false, message: 'You have already applied.' };
  }

  await prisma.$transaction(async (tx) => {
    const partner = await tx.fleetPartner.create({
      data: {
        userId: user.id,
        vehicleType: input.vehicleType,
        vehiclePlate: input.vehiclePlate?.trim().slice(0, 20) || null,
        homeCityId: user.preferredCityId,
        // Empty until approved. Nothing grants itself access here.
        enabledServices: [],
      },
    });

    await tx.fleetPartnerServiceVerification.createMany({
      data: services.map((serviceType) => ({
        fleetPartnerId: partner.id,
        serviceType,
        status: VerificationStatus.PENDING,
        submittedAt: new Date(),
      })),
      skipDuplicates: true,
    });

    // The person is now both a customer and a fleet partner on one record,
    // which is what the roles array is for.
    const roles = new Set(user.roles);
    roles.add('FLEET_PARTNER');
    await tx.user.update({
      where: { id: user.id },
      data: { roles: [...roles] },
    });
  });

  revalidatePath('/fleet');
  revalidatePath('/profile');
  redirect('/fleet');
}

/** Applies for one more service on an existing fleet record. */
export async function applyForServiceAction(
  serviceType: ServiceKey,
): Promise<FleetActionResult> {
  try {
    const partner = await requireFleetPartner();

    await prisma.fleetPartnerServiceVerification.upsert({
      where: {
        fleetPartnerId_serviceType: { fleetPartnerId: partner.id, serviceType },
      },
      create: {
        fleetPartnerId: partner.id,
        serviceType,
        status: VerificationStatus.PENDING,
        submittedAt: new Date(),
      },
      // Re-applying after a rejection clears the old decision rather than
      // leaving a stale reason on screen.
      update: {
        status: VerificationStatus.PENDING,
        submittedAt: new Date(),
        decidedAt: null,
        rejectionReason: null,
      },
    });

    // Recompute in case a previously approved row expired.
    await syncEnabledServices(partner.id);

    revalidatePath('/fleet/profile');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toFleetMessage(error) };
  }
}

function toFleetMessage(error: unknown): string {
  if (error instanceof Error) {
    switch (error.name) {
      case 'NotAFleetPartnerError':
        return 'You are not a fleet partner yet.';
      case 'NotAuthenticatedError':
        return 'Sign in again.';
      case 'OnboardingIncompleteError':
        return 'Finish setting up your account first.';
      case 'IllegalTransitionError':
        return 'The order has changed. Refresh.';
      case 'UnauthorizedTransitionError':
        return 'A rider cannot do that to this order.';
      case 'MissingTransitionReasonError':
        return 'A reason is required.';
      case 'OrderNotFoundError':
        return 'That order is gone.';
    }
  }
  console.error('fleet action failed:', error);
  return 'That did not go through. Try again.';
}
