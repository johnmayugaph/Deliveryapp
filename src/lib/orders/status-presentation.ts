import { OrderStatus } from '@prisma/client';

/**
 * Customer-facing labels for order statuses.
 *
 * Keyed by status, not by service: "Finding a rider" reads correctly
 * whether the rider is collecting lunch or a parcel. Where a vertical genuinely
 * needs different words, the right fix is a distinct status in the superset —
 * which is why RIDE ends at DROPPED_OFF rather than reusing DELIVERED.
 */
export interface StatusPresentation {
  label: string;
  /** 'pending' | 'active' | 'done' | 'failed' — drives the strip's colour. */
  tone: 'pending' | 'active' | 'done' | 'failed';
}

export const ORDER_STATUS_PRESENTATION: Readonly<Record<OrderStatus, StatusPresentation>> = {
  [OrderStatus.DRAFT]: { label: 'Draft', tone: 'pending' },
  [OrderStatus.PENDING_PAYMENT]: { label: 'Waiting for payment', tone: 'pending' },
  [OrderStatus.PENDING_MERCHANT_ACCEPTANCE]: { label: 'Contacting the store', tone: 'pending' },
  [OrderStatus.MERCHANT_ACCEPTED]: { label: 'Accepted by the store', tone: 'active' },
  [OrderStatus.PREPARING]: { label: 'Being prepared', tone: 'active' },
  [OrderStatus.READY_FOR_PICKUP]: { label: 'Ready for pickup', tone: 'active' },
  [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: { label: 'Finding a rider', tone: 'pending' },
  [OrderStatus.RIDER_ASSIGNED]: { label: 'Rider assigned', tone: 'active' },
  [OrderStatus.RIDER_AT_PICKUP]: { label: 'Rider at the store', tone: 'active' },
  [OrderStatus.SHOPPING_IN_PROGRESS]: { label: 'Shopping now', tone: 'active' },
  [OrderStatus.AWAITING_BUDGET_APPROVAL]: { label: 'Needs your approval', tone: 'pending' },
  [OrderStatus.PASSENGER_ONBOARD]: { label: 'On board', tone: 'active' },
  [OrderStatus.PICKED_UP]: { label: 'Picked up', tone: 'active' },
  [OrderStatus.IN_TRANSIT]: { label: 'On the way', tone: 'active' },
  [OrderStatus.ARRIVED_AT_DROPOFF]: { label: 'Outside your door', tone: 'active' },
  [OrderStatus.DELIVERED]: { label: 'Delivered', tone: 'done' },
  [OrderStatus.DROPPED_OFF]: { label: 'Dropped off', tone: 'done' },
  [OrderStatus.COMPLETED]: { label: 'Completed', tone: 'done' },
  [OrderStatus.FAILED_DELIVERY]: { label: 'Delivery failed', tone: 'failed' },
  [OrderStatus.CANCELLED_BY_CUSTOMER]: { label: 'You cancelled', tone: 'failed' },
  [OrderStatus.CANCELLED_BY_MERCHANT]: { label: 'Cancelled by the store', tone: 'failed' },
  [OrderStatus.CANCELLED_BY_RIDER]: { label: 'Cancelled by the rider', tone: 'failed' },
  [OrderStatus.CANCELLED_BY_SYSTEM]: { label: 'Cancelled', tone: 'failed' },
};

export function statusPresentation(status: OrderStatus): StatusPresentation {
  return ORDER_STATUS_PRESENTATION[status];
}
