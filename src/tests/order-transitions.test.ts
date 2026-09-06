import { describe, expect, it } from 'vitest';
import { OrderActor, OrderStatus, ServiceKey } from '@prisma/client';
import { ORDER_LIFECYCLES, ALL_IN_PROGRESS_STATUSES } from '@/lib/orders/transitions';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  cancellationStatusForActor,
  IllegalTransitionError,
  isTerminal,
  MissingTransitionReasonError,
  UnauthorizedTransitionError,
} from '@/lib/orders/state-machine';

describe('lifecycle config map', () => {
  it('registers a lifecycle for every service key', () => {
    for (const key of Object.values(ServiceKey)) {
      expect(ORDER_LIFECYCLES[key], `missing lifecycle for ${key}`).toBeDefined();
    }
  });

  it('never lets a terminal status transition anywhere', () => {
    for (const key of Object.values(ServiceKey)) {
      const lifecycle = ORDER_LIFECYCLES[key];
      for (const terminal of lifecycle.terminalStatuses) {
        expect(allowedTransitions(key, terminal), `${key} leaves ${terminal}`).toEqual([]);
      }
    }
  });

  it('only ever transitions to statuses that are themselves reachable or terminal', () => {
    // Guards against a typo creating a state nothing can leave but that is not
    // declared terminal — an order stuck forever.
    for (const key of Object.values(ServiceKey)) {
      const lifecycle = ORDER_LIFECYCLES[key];
      const targets = new Set(Object.values(lifecycle.transitions).flat());
      for (const target of targets) {
        const isDeclaredTerminal = lifecycle.terminalStatuses.includes(target);
        const canLeave = (lifecycle.transitions[target] ?? []).length > 0;
        expect(
          isDeclaredTerminal || canLeave,
          `${key}: ${target} is a dead end but is not declared terminal`,
        ).toBe(true);
      }
    }
  });

  it('can reach a terminal state from every service initial state', () => {
    for (const key of Object.values(ServiceKey)) {
      const lifecycle = ORDER_LIFECYCLES[key];
      const seen = new Set<OrderStatus>();
      const queue: OrderStatus[] = [lifecycle.initialStatus];
      let reachedCompletion = false;

      while (queue.length > 0) {
        const status = queue.shift()!;
        if (seen.has(status)) continue;
        seen.add(status);
        if (status === OrderStatus.COMPLETED) {
          reachedCompletion = true;
        }
        queue.push(...allowedTransitions(key, status));
      }

      expect(reachedCompletion, `${key} can never complete`).toBe(true);
    }
  });
});

describe('FOOD uses the merchant chain', () => {
  it('waits for merchant acceptance after being placed', () => {
    expect(ORDER_LIFECYCLES[ServiceKey.FOOD].submittedStatus).toBe(
      OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
    );
    expect(
      canTransition(
        ServiceKey.FOOD,
        OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
        OrderStatus.MERCHANT_ACCEPTED,
      ),
    ).toBe(true);
  });

  it('lets a partner be assigned while the kitchen is still preparing', () => {
    expect(
      canTransition(
        ServiceKey.FOOD,
        OrderStatus.PREPARING,
        OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      ),
    ).toBe(true);
  });
});

describe('PARCEL skips merchant acceptance entirely', () => {
  it('goes straight to dispatch when submitted', () => {
    expect(ORDER_LIFECYCLES[ServiceKey.PARCEL].submittedStatus).toBe(
      OrderStatus.AWAITING_RIDER_ASSIGNMENT,
    );
  });

  it('has no merchant statuses anywhere in its lifecycle', () => {
    const lifecycle = ORDER_LIFECYCLES[ServiceKey.PARCEL];
    const allStates = new Set<OrderStatus>([
      ...(Object.keys(lifecycle.transitions) as OrderStatus[]),
      ...Object.values(lifecycle.transitions).flat(),
    ]);

    for (const merchantState of [
      OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      OrderStatus.MERCHANT_ACCEPTED,
      OrderStatus.PREPARING,
      OrderStatus.READY_FOR_PICKUP,
    ]) {
      expect(allStates.has(merchantState), `PARCEL reaches ${merchantState}`).toBe(false);
    }
  });

  it('rejects a merchant acceptance transition', () => {
    expect(() =>
      assertTransition({
        serviceType: ServiceKey.PARCEL,
        from: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
        to: OrderStatus.MERCHANT_ACCEPTED,
        actor: OrderActor.MERCHANT,
      }),
    ).toThrow(IllegalTransitionError);
  });
});

describe('other verticals have their own shapes', () => {
  it('PABILI gates on budget approval before collection', () => {
    expect(
      canTransition(
        ServiceKey.PABILI,
        OrderStatus.SHOPPING_IN_PROGRESS,
        OrderStatus.AWAITING_BUDGET_APPROVAL,
      ),
    ).toBe(true);
    // Only the customer releases that gate.
    expect(() =>
      assertTransition({
        serviceType: ServiceKey.PABILI,
        from: OrderStatus.AWAITING_BUDGET_APPROVAL,
        to: OrderStatus.PICKED_UP,
        actor: OrderActor.FLEET_PARTNER,
      }),
    ).toThrow(UnauthorizedTransitionError);
  });

  it('RIDE boards a passenger and ends at DROPPED_OFF', () => {
    expect(
      canTransition(
        ServiceKey.RIDE,
        OrderStatus.RIDER_AT_PICKUP,
        OrderStatus.PASSENGER_ONBOARD,
      ),
    ).toBe(true);
    expect(canTransition(ServiceKey.RIDE, OrderStatus.DROPPED_OFF, OrderStatus.COMPLETED)).toBe(
      true,
    );
    // A ride is never "delivered".
    expect(canTransition(ServiceKey.RIDE, OrderStatus.IN_TRANSIT, OrderStatus.DELIVERED)).toBe(
      false,
    );
  });

  it('MART has a shopping leg but no merchant acceptance', () => {
    expect(
      canTransition(
        ServiceKey.MART,
        OrderStatus.RIDER_AT_PICKUP,
        OrderStatus.SHOPPING_IN_PROGRESS,
      ),
    ).toBe(true);
    expect(ORDER_LIFECYCLES[ServiceKey.MART].submittedStatus).not.toBe(
      OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
    );
  });
});

describe('guards', () => {
  it('requires a reason for every cancellation', () => {
    expect(() =>
      assertTransition({
        serviceType: ServiceKey.FOOD,
        from: OrderStatus.PREPARING,
        to: OrderStatus.CANCELLED_BY_CUSTOMER,
        actor: OrderActor.CUSTOMER,
      }),
    ).toThrow(MissingTransitionReasonError);

    expect(() =>
      assertTransition({
        serviceType: ServiceKey.FOOD,
        from: OrderStatus.PREPARING,
        to: OrderStatus.CANCELLED_BY_CUSTOMER,
        actor: OrderActor.CUSTOMER,
        reason: 'Nagbago ang isip',
      }),
    ).not.toThrow();
  });

  it('will not let a customer cancel an order already in transit', () => {
    expect(
      canTransition(
        ServiceKey.FOOD,
        OrderStatus.IN_TRANSIT,
        OrderStatus.CANCELLED_BY_CUSTOMER,
      ),
    ).toBe(false);
  });

  it('maps each actor to its own cancellation status', () => {
    expect(cancellationStatusForActor(OrderActor.CUSTOMER)).toBe(
      OrderStatus.CANCELLED_BY_CUSTOMER,
    );
    expect(cancellationStatusForActor(OrderActor.FLEET_PARTNER)).toBe(
      OrderStatus.CANCELLED_BY_RIDER,
    );
    expect(cancellationStatusForActor(OrderActor.SYSTEM)).toBe(
      OrderStatus.CANCELLED_BY_SYSTEM,
    );
  });

  it('treats COMPLETED as terminal for every vertical', () => {
    for (const key of Object.values(ServiceKey)) {
      expect(isTerminal(key, OrderStatus.COMPLETED)).toBe(true);
    }
  });
});

describe('cross-service in-progress set', () => {
  it('is derived from the map and covers every vertical', () => {
    for (const key of Object.values(ServiceKey)) {
      for (const status of ORDER_LIFECYCLES[key].inProgressStatuses) {
        expect(ALL_IN_PROGRESS_STATUSES).toContain(status);
      }
    }
  });

  it('contains no terminal statuses', () => {
    expect(ALL_IN_PROGRESS_STATUSES).not.toContain(OrderStatus.COMPLETED);
    expect(ALL_IN_PROGRESS_STATUSES).not.toContain(OrderStatus.CANCELLED_BY_CUSTOMER);
  });
});
