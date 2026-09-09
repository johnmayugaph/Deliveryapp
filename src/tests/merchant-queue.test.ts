import { describe, expect, it } from 'vitest';
import { OrderActor, OrderStatus, ServiceKey, StoreRole } from '@prisma/client';
import { MERCHANT_STAGES, QUEUE_STATUSES } from '@/lib/merchant/queue';
import { roleSatisfies, storeIdFromDetails } from '@/lib/merchant/access';
import { allowedTransitions, isActorPermitted } from '@/lib/orders/state-machine';
import { ALL_STATUS_TIMEOUTS, ORDER_LIFECYCLES } from '@/lib/orders/transitions';
import { STORE_ROLE_LABELS } from '@/lib/merchant/staff-policy';

describe('store roles', () => {
  it('ranks owner above manager above staff', () => {
    expect(roleSatisfies(StoreRole.OWNER, StoreRole.MANAGER)).toBe(true);
    expect(roleSatisfies(StoreRole.MANAGER, StoreRole.STAFF)).toBe(true);
    expect(roleSatisfies(StoreRole.OWNER, StoreRole.STAFF)).toBe(true);
  });

  it('does not let a lower role satisfy a higher one', () => {
    expect(roleSatisfies(StoreRole.STAFF, StoreRole.MANAGER)).toBe(false);
    expect(roleSatisfies(StoreRole.STAFF, StoreRole.OWNER)).toBe(false);
    expect(roleSatisfies(StoreRole.MANAGER, StoreRole.OWNER)).toBe(false);
  });

  it('lets every role satisfy itself', () => {
    for (const role of Object.values(StoreRole)) {
      expect(roleSatisfies(role, role)).toBe(true);
    }
  });

  it('labels every role, so the header never renders an enum', () => {
    for (const role of Object.values(StoreRole)) {
      expect(STORE_ROLE_LABELS[role]).toBeTruthy();
      expect(STORE_ROLE_LABELS[role]).not.toBe(role);
    }
  });
});

describe('reading the store out of a details container', () => {
  it('finds a FOOD order’s store', () => {
    expect(storeIdFromDetails({ storeId: 'store_1', items: [] })).toBe('store_1');
  });

  it('returns null for a vertical with no store, rather than guessing', () => {
    // A parcel has no merchant leg; there is nothing a merchant could
    // legitimately do to it, and the authorisation check must say so.
    expect(storeIdFromDetails({ packageDescription: 'documents' })).toBeNull();
  });

  it('is defensive about shapes it has never seen', () => {
    for (const input of [null, undefined, 'a string', 42, [], {}, { storeId: 7 }, { storeId: '' }]) {
      expect(storeIdFromDetails(input)).toBeNull();
    }
  });
});

describe('queue stages', () => {
  it('covers every status a merchant can act on', () => {
    // Any status from which a FOOD merchant may make a move must appear in the
    // queue, or the order becomes invisible to the kitchen holding the food.
    const lifecycle = ORDER_LIFECYCLES[ServiceKey.FOOD];
    const actionable = (Object.keys(lifecycle.transitions) as OrderStatus[]).filter((from) =>
      allowedTransitions(ServiceKey.FOOD, from).some((to) =>
        isActorPermitted(ServiceKey.FOOD, to, OrderActor.MERCHANT),
      ),
    );

    for (const status of actionable) {
      // DRAFT and PENDING_PAYMENT are pre-submission: the customer has not
      // sent the order yet, so it is correctly not in anyone's queue.
      if (status === OrderStatus.DRAFT || status === OrderStatus.PENDING_PAYMENT) continue;
      expect(
        QUEUE_STATUSES.includes(status),
        `${status} is merchant-actionable but absent from the queue`,
      ).toBe(true);
    }
  });

  it('never lists one status in two stages', () => {
    const seen = new Set<OrderStatus>();
    for (const stage of MERCHANT_STAGES) {
      for (const status of stage.statuses) {
        expect(seen.has(status), `${status} appears twice`).toBe(false);
        seen.add(status);
      }
    }
  });

  it('excludes terminal statuses — a finished order is history, not queue', () => {
    for (const status of ORDER_LIFECYCLES[ServiceKey.FOOD].terminalStatuses) {
      expect(QUEUE_STATUSES).not.toContain(status);
    }
  });

  it('excludes statuses where the food has left the store', () => {
    for (const status of [
      OrderStatus.PICKED_UP,
      OrderStatus.IN_TRANSIT,
      OrderStatus.ARRIVED_AT_DROPOFF,
      OrderStatus.DELIVERED,
    ]) {
      expect(QUEUE_STATUSES).not.toContain(status);
    }
  });

  it('puts the status the sweeper is timing in the first stage', () => {
    /**
     * This asserted a per-stage `isUrgent` flag, which the card read to decide
     * whether to warn. The flag is gone: the card reads the sweeper's real
     * deadline per order now, which is strictly better because a stage cannot
     * know that THIS order has forty seconds left. What is worth keeping is
     * the arrangement — the status with a deadline on it is the one at the top
     * of the screen — and that is checked against the timeout list rather than
     * against a flag beside it.
     */
    const timed = ALL_STATUS_TIMEOUTS.filter(
      (timeout) => timeout.serviceType === ServiceKey.FOOD,
    ).map((timeout) => timeout.status);
    expect(timed).toContain(OrderStatus.PENDING_MERCHANT_ACCEPTANCE);
    expect(MERCHANT_STAGES[0]!.statuses).toContain(
      OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
    );
  });

  it('orders the stages the way a kitchen works', () => {
    expect(MERCHANT_STAGES.map((stage) => stage.key)).toEqual([
      'needs-decision',
      'preparing',
      'awaiting-pickup',
    ]);
  });
});

describe('what the map offers a merchant', () => {
  it('offers accept or reject on a new order, and nothing else', () => {
    const actions = allowedTransitions(
      ServiceKey.FOOD,
      OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
    ).filter((to) => isActorPermitted(ServiceKey.FOOD, to, OrderActor.MERCHANT));

    expect(actions).toContain(OrderStatus.MERCHANT_ACCEPTED);
    expect(actions).toContain(OrderStatus.CANCELLED_BY_MERCHANT);
    expect(actions).not.toContain(OrderStatus.READY_FOR_PICKUP);
    expect(actions).not.toContain(OrderStatus.PICKED_UP);
  });

  it('offers ready once the food is being prepared', () => {
    const actions = allowedTransitions(ServiceKey.FOOD, OrderStatus.PREPARING).filter((to) =>
      isActorPermitted(ServiceKey.FOOD, to, OrderActor.MERCHANT),
    );
    expect(actions).toContain(OrderStatus.READY_FOR_PICKUP);
  });

  it('offers a merchant nothing once a partner is carrying the food', () => {
    for (const status of [OrderStatus.PICKED_UP, OrderStatus.IN_TRANSIT]) {
      const actions = allowedTransitions(ServiceKey.FOOD, status).filter((to) =>
        isActorPermitted(ServiceKey.FOOD, to, OrderActor.MERCHANT),
      );
      expect(actions, `${status} still offers the merchant something`).toEqual([]);
    }
  });

  it('offers nothing at all in a vertical with no merchant leg', () => {
    // A parcel never passes through a kitchen; the queue must stay empty for it
    // without this being special-cased anywhere.
    const lifecycle = ORDER_LIFECYCLES[ServiceKey.PARCEL];
    for (const from of Object.keys(lifecycle.transitions) as OrderStatus[]) {
      const actions = allowedTransitions(ServiceKey.PARCEL, from).filter((to) =>
        isActorPermitted(ServiceKey.PARCEL, to, OrderActor.MERCHANT),
      );
      // Only a merchant-initiated cancellation, which a parcel lifecycle keeps
      // for support's benefit; nothing that implies a kitchen.
      expect(actions.every((to) => to === OrderStatus.CANCELLED_BY_MERCHANT)).toBe(true);
    }
  });

  it('lets the merchant hand a ready order to dispatch', () => {
    // markReadyAction relies on this being a legal move, as SYSTEM.
    expect(
      allowedTransitions(ServiceKey.FOOD, OrderStatus.READY_FOR_PICKUP),
    ).toContain(OrderStatus.AWAITING_RIDER_ASSIGNMENT);
    expect(
      isActorPermitted(ServiceKey.FOOD, OrderStatus.AWAITING_RIDER_ASSIGNMENT, OrderActor.SYSTEM),
    ).toBe(true);
    // But not as the merchant — finding a rider is ours to do.
    expect(
      isActorPermitted(ServiceKey.FOOD, OrderStatus.AWAITING_RIDER_ASSIGNMENT, OrderActor.MERCHANT),
    ).toBe(false);
  });
});
