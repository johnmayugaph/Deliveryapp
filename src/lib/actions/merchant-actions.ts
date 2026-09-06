'use server';

import { revalidatePath } from 'next/cache';
import { OrderActor, OrderStatus, StoreRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireOrderStoreAccess, requireStoreAccess } from '@/lib/merchant/access';
import { allowedTransitions, transitionOrder } from '@/lib/orders/state-machine';
import { refundOrderCredits } from '@/lib/orders/maintenance';

/**
 * Merchant actions.
 *
 * Every one authorises against the store the ORDER belongs to, resolved from
 * the order's own record — never from a store id the client sent alongside it.
 * That is what stops a merchant accepting a neighbour's order by editing a form
 * field, and it is verified against the database.
 *
 * None of these name a target status directly except where the merchant's
 * intent maps to exactly one. The state machine decides whether the move is
 * legal and whether a MERCHANT may make it; these functions only express intent.
 */

export type MerchantActionResult =
  | { ok: true; status: OrderStatus }
  | { ok: false; message: string };

/** Refreshes both the merchant's queue and the customer's tracking screen. */
function revalidateOrderViews(storeId: string, orderId: string): void {
  revalidatePath(`/merchant/${storeId}`);
  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
}

async function performMerchantTransition(
  orderId: string,
  to: OrderStatus,
  options: { reason?: string } = {},
): Promise<MerchantActionResult> {
  try {
    const access = await requireOrderStoreAccess(orderId);

    const order = await transitionOrder({
      orderId,
      to,
      actor: OrderActor.MERCHANT,
      actorUserId: access.user.id,
      ...(options.reason ? { reason: options.reason } : {}),
      metadata: { storeId: access.store.id, byUserId: access.user.id },
    });

    revalidateOrderViews(access.store.id, orderId);
    return { ok: true, status: order.status };
  } catch (error) {
    return { ok: false, message: toMerchantMessage(error) };
  }
}

/** Accepts a new order into the kitchen. */
export async function acceptOrderAction(orderId: string): Promise<MerchantActionResult> {
  return performMerchantTransition(orderId, OrderStatus.MERCHANT_ACCEPTED);
}

/** Marks an accepted order as actually being cooked. */
export async function startPreparingAction(orderId: string): Promise<MerchantActionResult> {
  return performMerchantTransition(orderId, OrderStatus.PREPARING);
}

/**
 * Rejects an order, with a reason, and returns any credits the customer spent.
 *
 * The reason is mandatory — the state machine enforces it for every
 * cancellation — and it reaches the customer verbatim, so "out of stock" beats
 * a silent cancellation they have to phone about.
 */
export async function rejectOrderAction(
  orderId: string,
  reason: string,
): Promise<MerchantActionResult> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    return { ok: false, message: 'Ilagay ang dahilan — makikita ito ng customer.' };
  }

  try {
    const access = await requireOrderStoreAccess(orderId);

    const order = await prisma.$transaction(async (tx) => {
      const updated = await transitionOrder(
        {
          orderId,
          to: OrderStatus.CANCELLED_BY_MERCHANT,
          actor: OrderActor.MERCHANT,
          actorUserId: access.user.id,
          reason: trimmed,
          metadata: { storeId: access.store.id, byUserId: access.user.id },
        },
        tx,
      );
      // Credits spent on an order that will never arrive go straight back.
      await refundOrderCredits({ orderId, reason: 'Tinanggihan ng store' }, tx);
      return updated;
    });

    revalidateOrderViews(access.store.id, orderId);
    revalidatePath('/credits');
    return { ok: true, status: order.status };
  } catch (error) {
    return { ok: false, message: toMerchantMessage(error) };
  }
}

/**
 * Marks food ready, and hands the order to dispatch when no partner is on it
 * yet.
 *
 * Two transitions rather than one because they belong to different actors: the
 * merchant says the food is ready, and the SYSTEM is what starts looking for a
 * rider. Doing it here means an order cannot sit at READY_FOR_PICKUP with
 * nobody searching — which, until the fleet app exists, is the difference
 * between a timeout that fires and an order stuck forever.
 */
export async function markReadyAction(orderId: string): Promise<MerchantActionResult> {
  try {
    const access = await requireOrderStoreAccess(orderId);

    const result = await prisma.$transaction(async (tx) => {
      const ready = await transitionOrder(
        {
          orderId,
          to: OrderStatus.READY_FOR_PICKUP,
          actor: OrderActor.MERCHANT,
          actorUserId: access.user.id,
          metadata: { storeId: access.store.id, byUserId: access.user.id },
        },
        tx,
      );

      if (ready.assignedRiderId !== null) {
        // A partner is already on it; they take it from here.
        return ready;
      }

      const canDispatch = allowedTransitions(
        ready.serviceType,
        OrderStatus.READY_FOR_PICKUP,
      ).includes(OrderStatus.AWAITING_RIDER_ASSIGNMENT);

      if (!canDispatch) {
        return ready;
      }

      return transitionOrder(
        {
          orderId,
          to: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
          actor: OrderActor.SYSTEM,
          reason: 'Handa na ang order; hinahanap ang rider.',
        },
        tx,
      );
    });

    revalidateOrderViews(access.store.id, orderId);
    return { ok: true, status: result.status };
  } catch (error) {
    return { ok: false, message: toMerchantMessage(error) };
  }
}

/**
 * Adds minutes to an order's ETA.
 *
 * The honest alternative to silently running late: the customer's tracking
 * screen shows the new time and the reason lands in the order's event trail.
 */
export async function addPrepMinutesAction(
  orderId: string,
  minutes: number,
): Promise<MerchantActionResult> {
  const added = Math.floor(minutes);
  if (!Number.isInteger(added) || added < 1 || added > 60) {
    return { ok: false, message: 'Sa pagitan ng 1 at 60 minuto.' };
  }

  try {
    const access = await requireOrderStoreAccess(orderId);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, status: true, etaAt: true },
    });

    const base = order.etaAt ?? new Date();
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { etaAt: new Date(base.getTime() + added * 60_000) },
    });

    // Recorded as an event so the delay is visible in support and in the
    // customer's timeline, not just as a quietly moved number.
    await prisma.orderStatusEvent.create({
      data: {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: order.status,
        actor: OrderActor.MERCHANT,
        actorUserId: access.user.id,
        reason: `Dinagdagan ng ${added} minuto ang paghahanda.`,
      },
    });

    revalidateOrderViews(access.store.id, orderId);
    return { ok: true, status: updated.status };
  } catch (error) {
    return { ok: false, message: toMerchantMessage(error) };
  }
}

export type StoreSettingsResult = { ok: true } | { ok: false; message: string };

/**
 * Open or close the store.
 *
 * STAFF may do this — someone has to be able to close when the rice runs out at
 * 8pm and the owner is not there.
 */
export async function setStoreOpenAction(
  storeId: string,
  isOpen: boolean,
): Promise<StoreSettingsResult> {
  try {
    const access = await requireStoreAccess(storeId, StoreRole.STAFF);
    await prisma.store.update({ where: { id: access.store.id }, data: { isOpen } });
    revalidatePath(`/merchant/${storeId}`);
    revalidatePath(`/merchant/${storeId}/settings`);
    revalidatePath(`/stores/${access.store.slug}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toMerchantMessage(error) };
  }
}

/** The store's quoted preparation time, snapshotted into each new order. */
export async function setPreparationMinutesAction(
  storeId: string,
  minutes: number,
): Promise<StoreSettingsResult> {
  const value = Math.floor(minutes);
  if (!Number.isInteger(value) || value < 1 || value > 180) {
    return { ok: false, message: 'Sa pagitan ng 1 at 180 minuto.' };
  }

  try {
    const access = await requireStoreAccess(storeId, StoreRole.MANAGER);
    await prisma.store.update({
      where: { id: access.store.id },
      data: { preparationMinutes: value },
    });
    revalidatePath(`/merchant/${storeId}/settings`);
    revalidatePath(`/stores/${access.store.slug}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toMerchantMessage(error) };
  }
}

/** Take an item off the menu, or put it back. STAFF may do this. */
export async function setItemAvailabilityAction(
  storeId: string,
  menuItemId: string,
  isAvailable: boolean,
): Promise<StoreSettingsResult> {
  try {
    const access = await requireStoreAccess(storeId, StoreRole.STAFF);
    // Scoped to the store, so an item id from elsewhere matches nothing.
    const { count } = await prisma.menuItem.updateMany({
      where: { id: menuItemId, storeId: access.store.id },
      data: { isAvailable },
    });
    if (count === 0) {
      return { ok: false, message: 'Wala sa menu mo ang item na ito.' };
    }
    revalidatePath(`/merchant/${storeId}/menu`);
    revalidatePath(`/stores/${access.store.slug}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toMerchantMessage(error) };
  }
}

/**
 * Change an item's price.
 *
 * Safe to allow because every order snapshots what it charged: raising a price
 * today cannot rewrite last month's receipt. MANAGER and above, since it is the
 * one edit here with money attached.
 */
export async function setItemPriceAction(
  storeId: string,
  menuItemId: string,
  priceCentavos: number,
): Promise<StoreSettingsResult> {
  const price = Math.floor(priceCentavos);
  if (!Number.isInteger(price) || price < 100 || price > 10_000_00) {
    return { ok: false, message: 'Sa pagitan ng ₱1 at ₱10,000.' };
  }

  try {
    const access = await requireStoreAccess(storeId, StoreRole.MANAGER);
    const { count } = await prisma.menuItem.updateMany({
      where: { id: menuItemId, storeId: access.store.id },
      data: { priceCentavos: price },
    });
    if (count === 0) {
      return { ok: false, message: 'Wala sa menu mo ang item na ito.' };
    }
    revalidatePath(`/merchant/${storeId}/menu`);
    revalidatePath(`/stores/${access.store.slug}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toMerchantMessage(error) };
  }
}

/**
 * Turns a domain error into something a merchant can act on.
 *
 * Access failures read as one message whether the store does not exist or is
 * not theirs, so the screen cannot be used to probe for other stores' ids.
 */
function toMerchantMessage(error: unknown): string {
  if (error instanceof Error) {
    switch (error.name) {
      case 'NoStoreAccessError':
        return 'Wala kang access sa store na ito.';
      case 'InsufficientStoreRoleError':
        return 'Kailangan ng mas mataas na access para dito.';
      case 'NotAuthenticatedError':
        return 'Mag-sign in muli.';
      case 'IllegalTransitionError':
        // Almost always a stale screen: somebody else already moved it.
        return 'Nagbago na ang order na ito. I-refresh ang queue.';
      case 'MissingTransitionReasonError':
        return 'Kailangan ng dahilan.';
      case 'UnauthorizedTransitionError':
        return 'Hindi ito kayang gawin ng store para sa order na ito.';
      case 'OrderNotFoundError':
        return 'Hindi na mahanap ang order.';
    }
  }
  console.error('merchant action failed:', error);
  return 'Hindi natuloy. Subukan muli.';
}
