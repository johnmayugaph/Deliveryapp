import { OrderActor, OrderStatus, ServiceKey } from '@prisma/client';

/**
 * Per-service order lifecycles.
 *
 * `OrderStatus` is a SUPERSET of every state any vertical can reach. This map,
 * not the ordering of that enum, decides which states a given vertical may
 * enter and in what order. The state machine in `./state-machine.ts` reads this
 * map and knows nothing about food, parcels, or passengers.
 *
 * The shapes genuinely differ, which is the whole point:
 *   FOOD   — merchant accepts, prepares, then a partner carries it.
 *   MART   — no merchant acceptance; a shopper picks the items themselves.
 *   PARCEL — no merchant leg at all: straight to dispatch.
 *   PABILI — a shopping leg plus a budget-approval gate before purchase.
 *   RIDE   — a passenger boards instead of a package being collected.
 */

/** Statuses reachable from a given status. Absent key == unreachable state. */
export type StatusTransitionMap = Partial<Record<OrderStatus, readonly OrderStatus[]>>;

/**
 * A state an order must not sit in forever, and where it goes if it does.
 *
 * Expressed per service so the sweeper job that acts on these needs no
 * knowledge of any vertical: a FOOD order waiting on a merchant and a PABILI
 * order waiting on a customer's budget approval are the same shape of problem.
 */
export interface StatusTimeout {
  /** The state that must not be occupied indefinitely. */
  status: OrderStatus;
  /** How long an order may remain there. */
  afterSeconds: number;
  /** Where it goes when the clock runs out. Must be a legal transition. */
  to: OrderStatus;
  /** Recorded as the cancellation reason, so the customer gets an explanation. */
  reason: string;
}

export interface ServiceLifecycle {
  /** State a freshly created order starts in. */
  initialStatus: OrderStatus;
  /**
   * The status an order sits in while it waits for the customer to pay or
   * confirm. Checkout moves an order here; nothing else should.
   */
  submittedStatus: OrderStatus;
  /** Nothing may leave these. */
  terminalStatuses: readonly OrderStatus[];
  /** Statuses the customer should see an active-order strip for. */
  inProgressStatuses: readonly OrderStatus[];
  transitions: StatusTransitionMap;
  /** Who may perform a given transition. Absent == SYSTEM and SUPPORT_AGENT only. */
  permittedActors: Partial<Record<OrderStatus, readonly OrderActor[]>>;
  /** States that time out. Swept by `expireStaleOrders()`. */
  timeouts: readonly StatusTimeout[];
}

/**
 * Who may move an order to RIDER_ASSIGNED.
 *
 * FLEET_PARTNER is here because a partner ACCEPTING an offer is the normal path
 * — that is what `FleetPartner.acceptanceRate` measures. SYSTEM covers
 * auto-assignment, and support covers reassignment by hand.
 */
const ASSIGNMENT_ACTORS: readonly OrderActor[] = [
  OrderActor.FLEET_PARTNER,
  OrderActor.SYSTEM,
  OrderActor.SUPPORT_AGENT,
];

/** Cancellation states, and who is allowed to put an order into each. */
const CANCELLATION_ACTORS: Partial<Record<OrderStatus, readonly OrderActor[]>> = {
  [OrderStatus.CANCELLED_BY_CUSTOMER]: [OrderActor.CUSTOMER, OrderActor.SUPPORT_AGENT],
  [OrderStatus.CANCELLED_BY_MERCHANT]: [OrderActor.MERCHANT, OrderActor.SUPPORT_AGENT],
  [OrderStatus.CANCELLED_BY_RIDER]: [OrderActor.FLEET_PARTNER, OrderActor.SUPPORT_AGENT],
  [OrderStatus.CANCELLED_BY_SYSTEM]: [OrderActor.SYSTEM, OrderActor.SUPPORT_AGENT],
};

/**
 * Statuses that always require a written reason. The state machine enforces
 * this rather than each caller remembering to pass one.
 */
export const STATUSES_REQUIRING_REASON: readonly OrderStatus[] = [
  OrderStatus.CANCELLED_BY_CUSTOMER,
  OrderStatus.CANCELLED_BY_MERCHANT,
  OrderStatus.CANCELLED_BY_RIDER,
  OrderStatus.CANCELLED_BY_SYSTEM,
  OrderStatus.FAILED_DELIVERY,
];

/**
 * Which `Order` timestamp column a status entry stamps. Declarative so the
 * state machine sets timestamps without a per-service branch.
 */
export const STATUS_TIMESTAMP_FIELDS: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.PENDING_PAYMENT]: 'placedAt',
  [OrderStatus.PENDING_MERCHANT_ACCEPTANCE]: 'placedAt',
  [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: 'placedAt',
  [OrderStatus.MERCHANT_ACCEPTED]: 'acceptedAt',
  [OrderStatus.READY_FOR_PICKUP]: 'readyAt',
  [OrderStatus.PICKED_UP]: 'pickedUpAt',
  [OrderStatus.PASSENGER_ONBOARD]: 'pickedUpAt',
  [OrderStatus.DELIVERED]: 'deliveredAt',
  [OrderStatus.DROPPED_OFF]: 'deliveredAt',
  [OrderStatus.COMPLETED]: 'completedAt',
  [OrderStatus.CANCELLED_BY_CUSTOMER]: 'cancelledAt',
  [OrderStatus.CANCELLED_BY_MERCHANT]: 'cancelledAt',
  [OrderStatus.CANCELLED_BY_RIDER]: 'cancelledAt',
  [OrderStatus.CANCELLED_BY_SYSTEM]: 'cancelledAt',
};

/** Cancellation states available while an order has not yet been collected. */
const PRE_PICKUP_CANCELLATIONS: readonly OrderStatus[] = [
  OrderStatus.CANCELLED_BY_CUSTOMER,
  OrderStatus.CANCELLED_BY_MERCHANT,
  OrderStatus.CANCELLED_BY_RIDER,
  OrderStatus.CANCELLED_BY_SYSTEM,
];

/** Once a partner is carrying the goods, only the partner or we can end it. */
const IN_TRANSIT_CANCELLATIONS: readonly OrderStatus[] = [
  OrderStatus.CANCELLED_BY_RIDER,
  OrderStatus.CANCELLED_BY_SYSTEM,
];

const TERMINAL_STATUSES: readonly OrderStatus[] = [
  OrderStatus.COMPLETED,
  OrderStatus.FAILED_DELIVERY,
  OrderStatus.CANCELLED_BY_CUSTOMER,
  OrderStatus.CANCELLED_BY_MERCHANT,
  OrderStatus.CANCELLED_BY_RIDER,
  OrderStatus.CANCELLED_BY_SYSTEM,
];

// -----------------------------------------------------------------------------

/**
 * FOOD — the existing chain, unchanged. Merchant accepts, kitchen prepares,
 * a partner collects and delivers.
 */
const FOOD_LIFECYCLE: ServiceLifecycle = {
  initialStatus: OrderStatus.DRAFT,
  submittedStatus: OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
  terminalStatuses: TERMINAL_STATUSES,
  inProgressStatuses: [
    OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
    OrderStatus.MERCHANT_ACCEPTED,
    OrderStatus.PREPARING,
    OrderStatus.READY_FOR_PICKUP,
    OrderStatus.AWAITING_RIDER_ASSIGNMENT,
    OrderStatus.RIDER_ASSIGNED,
    OrderStatus.RIDER_AT_PICKUP,
    OrderStatus.PICKED_UP,
    OrderStatus.IN_TRANSIT,
    OrderStatus.ARRIVED_AT_DROPOFF,
    OrderStatus.DELIVERED,
  ],
  transitions: {
    [OrderStatus.DRAFT]: [OrderStatus.PENDING_PAYMENT, OrderStatus.PENDING_MERCHANT_ACCEPTANCE, OrderStatus.CANCELLED_BY_CUSTOMER],
    [OrderStatus.PENDING_PAYMENT]: [OrderStatus.PENDING_MERCHANT_ACCEPTANCE, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.PENDING_MERCHANT_ACCEPTANCE]: [OrderStatus.MERCHANT_ACCEPTED, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.MERCHANT_ACCEPTED]: [OrderStatus.PREPARING, OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    // Dispatch runs alongside the kitchen: a partner can be found while the
    // food is still cooking, which is why PREPARING reaches both.
    [OrderStatus.PREPARING]: [OrderStatus.READY_FOR_PICKUP, OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.READY_FOR_PICKUP]: [OrderStatus.AWAITING_RIDER_ASSIGNMENT, OrderStatus.RIDER_ASSIGNED, OrderStatus.RIDER_AT_PICKUP, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: [OrderStatus.RIDER_ASSIGNED, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.RIDER_ASSIGNED]: [OrderStatus.RIDER_AT_PICKUP, OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.RIDER_AT_PICKUP]: [OrderStatus.PICKED_UP, OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.PICKED_UP]: [OrderStatus.IN_TRANSIT, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.IN_TRANSIT]: [OrderStatus.ARRIVED_AT_DROPOFF, OrderStatus.DELIVERED, OrderStatus.FAILED_DELIVERY, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.ARRIVED_AT_DROPOFF]: [OrderStatus.DELIVERED, OrderStatus.FAILED_DELIVERY, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED],
  },
  timeouts: [
    {
      // The one that matters most: without it a placed order can sit unanswered
      // forever while the customer waits for food that is never being cooked.
      status: OrderStatus.PENDING_MERCHANT_ACCEPTANCE,
      afterSeconds: 8 * 60,
      to: OrderStatus.CANCELLED_BY_SYSTEM,
      reason: 'Hindi nakasagot ang store sa loob ng 8 minuto.',
    },
    {
      // Dispatch searched and found nobody.
      status: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      afterSeconds: 20 * 60,
      to: OrderStatus.CANCELLED_BY_SYSTEM,
      reason: 'Wala kaming nakitang available na rider.',
    },
  ],
  permittedActors: {
    [OrderStatus.PENDING_MERCHANT_ACCEPTANCE]: [OrderActor.CUSTOMER, OrderActor.SYSTEM],
    [OrderStatus.MERCHANT_ACCEPTED]: [OrderActor.MERCHANT, OrderActor.SUPPORT_AGENT],
    [OrderStatus.PREPARING]: [OrderActor.MERCHANT, OrderActor.SUPPORT_AGENT],
    [OrderStatus.READY_FOR_PICKUP]: [OrderActor.MERCHANT, OrderActor.SUPPORT_AGENT],
    [OrderStatus.RIDER_ASSIGNED]: ASSIGNMENT_ACTORS,
    [OrderStatus.RIDER_AT_PICKUP]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.PICKED_UP]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.IN_TRANSIT]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.ARRIVED_AT_DROPOFF]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.DELIVERED]: [OrderActor.FLEET_PARTNER, OrderActor.SUPPORT_AGENT],
    ...CANCELLATION_ACTORS,
  },
};

/**
 * MART — a shopper buys from a catalogue. There is a store, but the store never
 * accepts anything, so merchant acceptance is absent from this chain.
 */
const MART_LIFECYCLE: ServiceLifecycle = {
  initialStatus: OrderStatus.DRAFT,
  submittedStatus: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
  terminalStatuses: TERMINAL_STATUSES,
  inProgressStatuses: [
    OrderStatus.AWAITING_RIDER_ASSIGNMENT,
    OrderStatus.RIDER_ASSIGNED,
    OrderStatus.RIDER_AT_PICKUP,
    OrderStatus.SHOPPING_IN_PROGRESS,
    OrderStatus.PICKED_UP,
    OrderStatus.IN_TRANSIT,
    OrderStatus.ARRIVED_AT_DROPOFF,
    OrderStatus.DELIVERED,
  ],
  transitions: {
    [OrderStatus.DRAFT]: [OrderStatus.PENDING_PAYMENT, OrderStatus.AWAITING_RIDER_ASSIGNMENT, OrderStatus.CANCELLED_BY_CUSTOMER],
    [OrderStatus.PENDING_PAYMENT]: [OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: [OrderStatus.RIDER_ASSIGNED, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.RIDER_ASSIGNED]: [OrderStatus.RIDER_AT_PICKUP, OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.RIDER_AT_PICKUP]: [OrderStatus.SHOPPING_IN_PROGRESS, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.SHOPPING_IN_PROGRESS]: [OrderStatus.PICKED_UP, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.PICKED_UP]: [OrderStatus.IN_TRANSIT, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.IN_TRANSIT]: [OrderStatus.ARRIVED_AT_DROPOFF, OrderStatus.DELIVERED, OrderStatus.FAILED_DELIVERY, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.ARRIVED_AT_DROPOFF]: [OrderStatus.DELIVERED, OrderStatus.FAILED_DELIVERY, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED],
  },
  timeouts: [
    {
      status: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      afterSeconds: 20 * 60,
      to: OrderStatus.CANCELLED_BY_SYSTEM,
      reason: 'Wala kaming nakitang available na rider.',
    },
  ],
  permittedActors: {
    [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: [OrderActor.CUSTOMER, OrderActor.SYSTEM],
    [OrderStatus.RIDER_ASSIGNED]: ASSIGNMENT_ACTORS,
    [OrderStatus.RIDER_AT_PICKUP]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.SHOPPING_IN_PROGRESS]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.PICKED_UP]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.IN_TRANSIT]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.ARRIVED_AT_DROPOFF]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.DELIVERED]: [OrderActor.FLEET_PARTNER, OrderActor.SUPPORT_AGENT],
    ...CANCELLATION_ACTORS,
  },
};

/**
 * PARCEL — skips merchant acceptance entirely. A placed parcel order goes
 * straight to dispatch; there is nobody to accept it but us.
 */
const PARCEL_LIFECYCLE: ServiceLifecycle = {
  initialStatus: OrderStatus.DRAFT,
  submittedStatus: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
  terminalStatuses: TERMINAL_STATUSES,
  inProgressStatuses: [
    OrderStatus.AWAITING_RIDER_ASSIGNMENT,
    OrderStatus.RIDER_ASSIGNED,
    OrderStatus.RIDER_AT_PICKUP,
    OrderStatus.PICKED_UP,
    OrderStatus.IN_TRANSIT,
    OrderStatus.ARRIVED_AT_DROPOFF,
    OrderStatus.DELIVERED,
  ],
  transitions: {
    [OrderStatus.DRAFT]: [OrderStatus.PENDING_PAYMENT, OrderStatus.AWAITING_RIDER_ASSIGNMENT, OrderStatus.CANCELLED_BY_CUSTOMER],
    [OrderStatus.PENDING_PAYMENT]: [OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: [OrderStatus.RIDER_ASSIGNED, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.RIDER_ASSIGNED]: [OrderStatus.RIDER_AT_PICKUP, OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.RIDER_AT_PICKUP]: [OrderStatus.PICKED_UP, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.PICKED_UP]: [OrderStatus.IN_TRANSIT, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.IN_TRANSIT]: [OrderStatus.ARRIVED_AT_DROPOFF, OrderStatus.DELIVERED, OrderStatus.FAILED_DELIVERY, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.ARRIVED_AT_DROPOFF]: [OrderStatus.DELIVERED, OrderStatus.FAILED_DELIVERY, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED],
  },
  timeouts: [
    {
      status: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      afterSeconds: 20 * 60,
      to: OrderStatus.CANCELLED_BY_SYSTEM,
      reason: 'Wala kaming nakitang available na rider.',
    },
  ],
  permittedActors: {
    [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: [OrderActor.CUSTOMER, OrderActor.SYSTEM],
    [OrderStatus.RIDER_ASSIGNED]: ASSIGNMENT_ACTORS,
    [OrderStatus.RIDER_AT_PICKUP]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.PICKED_UP]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.IN_TRANSIT]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.ARRIVED_AT_DROPOFF]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.DELIVERED]: [OrderActor.FLEET_PARTNER, OrderActor.SUPPORT_AGENT],
    ...CANCELLATION_ACTORS,
  },
};

/**
 * PABILI — a shopping leg with a budget gate. The partner shops, then waits for
 * the customer to approve the actual amount before the goods are collected.
 */
const PABILI_LIFECYCLE: ServiceLifecycle = {
  initialStatus: OrderStatus.DRAFT,
  submittedStatus: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
  terminalStatuses: TERMINAL_STATUSES,
  inProgressStatuses: [
    OrderStatus.AWAITING_RIDER_ASSIGNMENT,
    OrderStatus.RIDER_ASSIGNED,
    OrderStatus.SHOPPING_IN_PROGRESS,
    OrderStatus.AWAITING_BUDGET_APPROVAL,
    OrderStatus.PICKED_UP,
    OrderStatus.IN_TRANSIT,
    OrderStatus.ARRIVED_AT_DROPOFF,
    OrderStatus.DELIVERED,
  ],
  transitions: {
    [OrderStatus.DRAFT]: [OrderStatus.PENDING_PAYMENT, OrderStatus.AWAITING_RIDER_ASSIGNMENT, OrderStatus.CANCELLED_BY_CUSTOMER],
    [OrderStatus.PENDING_PAYMENT]: [OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: [OrderStatus.RIDER_ASSIGNED, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.RIDER_ASSIGNED]: [OrderStatus.SHOPPING_IN_PROGRESS, OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.SHOPPING_IN_PROGRESS]: [OrderStatus.AWAITING_BUDGET_APPROVAL, OrderStatus.PICKED_UP, ...PRE_PICKUP_CANCELLATIONS],
    // The customer either approves the receipt total or the order ends here.
    [OrderStatus.AWAITING_BUDGET_APPROVAL]: [OrderStatus.PICKED_UP, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.PICKED_UP]: [OrderStatus.IN_TRANSIT, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.IN_TRANSIT]: [OrderStatus.ARRIVED_AT_DROPOFF, OrderStatus.DELIVERED, OrderStatus.FAILED_DELIVERY, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.ARRIVED_AT_DROPOFF]: [OrderStatus.DELIVERED, OrderStatus.FAILED_DELIVERY, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED],
  },
  timeouts: [
    {
      status: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      afterSeconds: 20 * 60,
      to: OrderStatus.CANCELLED_BY_SYSTEM,
      reason: 'Wala kaming nakitang available na rider.',
    },
    {
      // A partner cannot stand in a shop indefinitely waiting for a reply.
      status: OrderStatus.AWAITING_BUDGET_APPROVAL,
      afterSeconds: 10 * 60,
      to: OrderStatus.CANCELLED_BY_SYSTEM,
      reason: 'Hindi na-approve ang budget sa loob ng 10 minuto.',
    },
  ],
  permittedActors: {
    [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: [OrderActor.CUSTOMER, OrderActor.SYSTEM],
    [OrderStatus.RIDER_ASSIGNED]: ASSIGNMENT_ACTORS,
    [OrderStatus.SHOPPING_IN_PROGRESS]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.AWAITING_BUDGET_APPROVAL]: [OrderActor.FLEET_PARTNER],
    // Only the customer releases the budget gate.
    [OrderStatus.PICKED_UP]: [OrderActor.CUSTOMER, OrderActor.SUPPORT_AGENT],
    [OrderStatus.IN_TRANSIT]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.ARRIVED_AT_DROPOFF]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.DELIVERED]: [OrderActor.FLEET_PARTNER, OrderActor.SUPPORT_AGENT],
    ...CANCELLATION_ACTORS,
  },
};

/**
 * RIDE — a passenger boards rather than a package being collected, and the trip
 * ends at DROPPED_OFF rather than DELIVERED.
 */
const RIDE_LIFECYCLE: ServiceLifecycle = {
  initialStatus: OrderStatus.DRAFT,
  submittedStatus: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
  terminalStatuses: TERMINAL_STATUSES,
  inProgressStatuses: [
    OrderStatus.AWAITING_RIDER_ASSIGNMENT,
    OrderStatus.RIDER_ASSIGNED,
    OrderStatus.RIDER_AT_PICKUP,
    OrderStatus.PASSENGER_ONBOARD,
    OrderStatus.IN_TRANSIT,
    OrderStatus.ARRIVED_AT_DROPOFF,
    OrderStatus.DROPPED_OFF,
  ],
  transitions: {
    [OrderStatus.DRAFT]: [OrderStatus.AWAITING_RIDER_ASSIGNMENT, OrderStatus.CANCELLED_BY_CUSTOMER],
    [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: [OrderStatus.RIDER_ASSIGNED, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.RIDER_ASSIGNED]: [OrderStatus.RIDER_AT_PICKUP, OrderStatus.AWAITING_RIDER_ASSIGNMENT, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.RIDER_AT_PICKUP]: [OrderStatus.PASSENGER_ONBOARD, ...PRE_PICKUP_CANCELLATIONS],
    [OrderStatus.PASSENGER_ONBOARD]: [OrderStatus.IN_TRANSIT, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.IN_TRANSIT]: [OrderStatus.ARRIVED_AT_DROPOFF, OrderStatus.DROPPED_OFF, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.ARRIVED_AT_DROPOFF]: [OrderStatus.DROPPED_OFF, ...IN_TRANSIT_CANCELLATIONS],
    [OrderStatus.DROPPED_OFF]: [OrderStatus.COMPLETED],
  },
  timeouts: [
    {
      status: OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      afterSeconds: 20 * 60,
      to: OrderStatus.CANCELLED_BY_SYSTEM,
      reason: 'Wala kaming nakitang available na rider.',
    },
  ],
  permittedActors: {
    [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: [OrderActor.CUSTOMER, OrderActor.SYSTEM],
    [OrderStatus.RIDER_ASSIGNED]: ASSIGNMENT_ACTORS,
    [OrderStatus.RIDER_AT_PICKUP]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.PASSENGER_ONBOARD]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.IN_TRANSIT]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.ARRIVED_AT_DROPOFF]: [OrderActor.FLEET_PARTNER],
    [OrderStatus.DROPPED_OFF]: [OrderActor.FLEET_PARTNER, OrderActor.SUPPORT_AGENT],
    ...CANCELLATION_ACTORS,
  },
};

/**
 * The config map. Keyed by every `ServiceKey`, so a sixth vertical is a
 * compile error here rather than an order stuck in DRAFT in production.
 */
export const ORDER_LIFECYCLES: Readonly<Record<ServiceKey, ServiceLifecycle>> = {
  [ServiceKey.FOOD]: FOOD_LIFECYCLE,
  [ServiceKey.MART]: MART_LIFECYCLE,
  [ServiceKey.PARCEL]: PARCEL_LIFECYCLE,
  [ServiceKey.PABILI]: PABILI_LIFECYCLE,
  [ServiceKey.RIDE]: RIDE_LIFECYCLE,
};

export function getLifecycle(serviceType: ServiceKey): ServiceLifecycle {
  return ORDER_LIFECYCLES[serviceType];
}

/**
 * Every status any lifecycle treats as in-progress, for the cross-service
 * "you have an order on the way" strip. Derived from the map, so a new
 * vertical's states are included the moment its lifecycle is registered.
 */
export const ALL_IN_PROGRESS_STATUSES: readonly OrderStatus[] = Array.from(
  new Set(
    Object.values(ORDER_LIFECYCLES).flatMap((lifecycle) => [...lifecycle.inProgressStatuses]),
  ),
);

/**
 * Every timeout across every vertical, flattened for the sweeper. Derived from
 * the map, so registering a lifecycle registers its timeouts too.
 */
export const ALL_STATUS_TIMEOUTS: readonly (StatusTimeout & { serviceType: ServiceKey })[] =
  (Object.entries(ORDER_LIFECYCLES) as [ServiceKey, ServiceLifecycle][]).flatMap(
    ([serviceType, lifecycle]) =>
      lifecycle.timeouts.map((timeout) => ({ ...timeout, serviceType })),
  );
