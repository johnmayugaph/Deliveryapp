import { OrderActor, OrderStatus, Prisma, type Order, type ServiceKey } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import {
  getLifecycle,
  STATUSES_REQUIRING_REASON,
  STATUS_TIMESTAMP_FIELDS,
} from '@/lib/orders/transitions';

/**
 * The order state machine.
 *
 * It reads `ORDER_LIFECYCLES` and nothing else. It does not know what food is,
 * that a parcel has no merchant, or that a ride carries a person — those facts
 * live in the config map. Adding a vertical means adding a lifecycle, not
 * editing this file.
 */

export class IllegalTransitionError extends Error {
  constructor(
    readonly serviceType: ServiceKey,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(
      `"${serviceType}" orders cannot move from ${from} to ${to}. ` +
        `Allowed from ${from}: ${allowedTransitions(serviceType, from).join(', ') || '(none — terminal)'}.`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export class UnauthorizedTransitionError extends Error {
  constructor(
    readonly serviceType: ServiceKey,
    readonly to: OrderStatus,
    readonly actor: OrderActor,
  ) {
    super(`A ${actor} may not move a "${serviceType}" order to ${to}`);
    this.name = 'UnauthorizedTransitionError';
  }
}

export class MissingTransitionReasonError extends Error {
  constructor(readonly to: OrderStatus) {
    super(`Moving an order to ${to} requires a reason`);
    this.name = 'MissingTransitionReasonError';
  }
}

export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`No order with id "${orderId}"`);
    this.name = 'OrderNotFoundError';
  }
}

/** Statuses reachable from `from` for this vertical. */
export function allowedTransitions(
  serviceType: ServiceKey,
  from: OrderStatus,
): readonly OrderStatus[] {
  return getLifecycle(serviceType).transitions[from] ?? [];
}

export function canTransition(
  serviceType: ServiceKey,
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  return allowedTransitions(serviceType, from).includes(to);
}

export function isTerminal(serviceType: ServiceKey, status: OrderStatus): boolean {
  return getLifecycle(serviceType).terminalStatuses.includes(status);
}

export function isInProgress(serviceType: ServiceKey, status: OrderStatus): boolean {
  return getLifecycle(serviceType).inProgressStatuses.includes(status);
}

/**
 * Whether `actor` is permitted to move an order of this vertical into `to`.
 * A status with no explicit actor list is ours to drive: SYSTEM and support
 * only.
 */
export function isActorPermitted(
  serviceType: ServiceKey,
  to: OrderStatus,
  actor: OrderActor,
): boolean {
  const permitted = getLifecycle(serviceType).permittedActors[to];
  if (!permitted) {
    return actor === OrderActor.SYSTEM || actor === OrderActor.SUPPORT_AGENT;
  }
  return permitted.includes(actor);
}

export interface TransitionRequest {
  orderId: string;
  to: OrderStatus;
  actor: OrderActor;
  actorUserId?: string;
  reason?: string;
  metadata?: Prisma.InputJsonValue;
  /** Set alongside a RIDER_ASSIGNED transition. */
  assignedRiderId?: string;
  /** Revised customer-facing ETA, if this transition produces one. */
  etaAt?: Date;
}

/** Validates a transition without performing it. Throws on the first problem. */
export function assertTransition(input: {
  serviceType: ServiceKey;
  from: OrderStatus;
  to: OrderStatus;
  actor: OrderActor;
  reason?: string;
}): void {
  const { serviceType, from, to, actor, reason } = input;

  if (!canTransition(serviceType, from, to)) {
    throw new IllegalTransitionError(serviceType, from, to);
  }
  if (!isActorPermitted(serviceType, to, actor)) {
    throw new UnauthorizedTransitionError(serviceType, to, actor);
  }
  if (STATUSES_REQUIRING_REASON.includes(to) && !reason?.trim()) {
    throw new MissingTransitionReasonError(to);
  }
}

/** Cancellation statuses, derived so this stays in step with the enum. */
const CANCELLATION_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CANCELLED_BY_CUSTOMER,
  OrderStatus.CANCELLED_BY_MERCHANT,
  OrderStatus.CANCELLED_BY_RIDER,
  OrderStatus.CANCELLED_BY_SYSTEM,
];

/**
 * Moves an order to a new status, atomically, and records the event.
 *
 * Runs inside a transaction and re-reads the order under it, so two riders
 * tapping "picked up" at once cannot both win. Timestamp columns are stamped
 * from `STATUS_TIMESTAMP_FIELDS` rather than by branching on the vertical.
 */
export async function transitionOrder(
  request: TransitionRequest,
  client?: PrismaTransactionClient,
): Promise<Order> {
  const run = async (tx: PrismaTransactionClient): Promise<Order> => {
    const order = await tx.order.findUnique({ where: { id: request.orderId } });
    if (!order) {
      throw new OrderNotFoundError(request.orderId);
    }

    assertTransition({
      serviceType: order.serviceType,
      from: order.status,
      to: request.to,
      actor: request.actor,
      reason: request.reason,
    });

    const data: Prisma.OrderUpdateInput = { status: request.to };

    const timestampField = STATUS_TIMESTAMP_FIELDS[request.to];
    if (timestampField) {
      // Only stamp a timestamp once. A re-dispatch that revisits
      // AWAITING_RIDER_ASSIGNMENT must not rewrite the original placedAt.
      const existing = order[timestampField as keyof Order];
      if (existing === null || existing === undefined) {
        Object.assign(data, { [timestampField]: new Date() });
      }
    }

    if (CANCELLATION_STATUSES.includes(request.to)) {
      data.cancellationReason = request.reason ?? null;
      data.cancelledBy = request.actor;
    }

    if (request.assignedRiderId !== undefined) {
      data.assignedRider = { connect: { id: request.assignedRiderId } };
    }

    if (request.etaAt !== undefined) {
      data.etaAt = request.etaAt;
    }

    const updated = await tx.order.update({
      where: {
        id: order.id,
        // Optimistic guard: if something else moved the order between our read
        // and this write, the update matches zero rows and Prisma throws.
        status: order.status,
      },
      data,
    });

    await tx.orderStatusEvent.create({
      data: {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: request.to,
        actor: request.actor,
        actorUserId: request.actorUserId ?? null,
        reason: request.reason ?? null,
        metadata: request.metadata ?? undefined,
      },
    });

    return updated;
  };

  // Compose into a caller's transaction when given one, so checkout can place
  // an order, spend credits and submit it as a single atomic unit.
  return client ? run(client) : prisma.$transaction((tx) => run(tx));
}

/**
 * Moves a freshly created order into its vertical's submitted state. Checkout
 * calls this instead of naming a status, which is what keeps checkout free of
 * per-vertical knowledge: food lands in PENDING_MERCHANT_ACCEPTANCE, a parcel
 * lands in AWAITING_RIDER_ASSIGNMENT, and neither is spelled out here.
 */
export async function submitOrder(
  input: {
    orderId: string;
    serviceType: ServiceKey;
    actor?: OrderActor;
    actorUserId?: string;
  },
  client?: PrismaTransactionClient,
): Promise<Order> {
  return transitionOrder(
    {
      orderId: input.orderId,
      to: getLifecycle(input.serviceType).submittedStatus,
      actor: input.actor ?? OrderActor.CUSTOMER,
      actorUserId: input.actorUserId,
    },
    client,
  );
}

/**
 * The cancellation status matching an actor, so callers ask "cancel this, as
 * the customer" rather than picking an enum member by hand.
 */
export function cancellationStatusForActor(actor: OrderActor): OrderStatus {
  switch (actor) {
    case OrderActor.CUSTOMER:
      return OrderStatus.CANCELLED_BY_CUSTOMER;
    case OrderActor.MERCHANT:
      return OrderStatus.CANCELLED_BY_MERCHANT;
    case OrderActor.FLEET_PARTNER:
      return OrderStatus.CANCELLED_BY_RIDER;
    case OrderActor.SUPPORT_AGENT:
    case OrderActor.SYSTEM:
      return OrderStatus.CANCELLED_BY_SYSTEM;
  }
}
