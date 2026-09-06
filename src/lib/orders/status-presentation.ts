import { OrderStatus } from '@prisma/client';

/**
 * Customer-facing labels for order statuses.
 *
 * Keyed by status, not by service: "Naghahanap ng rider" reads correctly
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
  [OrderStatus.PENDING_MERCHANT_ACCEPTANCE]: { label: 'Kumakausap sa store', tone: 'pending' },
  [OrderStatus.MERCHANT_ACCEPTED]: { label: 'Tinanggap ng store', tone: 'active' },
  [OrderStatus.PREPARING]: { label: 'Inihahanda pa', tone: 'active' },
  [OrderStatus.READY_FOR_PICKUP]: { label: 'Ready for pickup', tone: 'active' },
  [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: { label: 'Naghahanap ng rider', tone: 'pending' },
  [OrderStatus.RIDER_ASSIGNED]: { label: 'May rider na', tone: 'active' },
  [OrderStatus.RIDER_AT_PICKUP]: { label: 'Nasa pickup ang rider', tone: 'active' },
  [OrderStatus.SHOPPING_IN_PROGRESS]: { label: 'Namimili pa', tone: 'active' },
  [OrderStatus.AWAITING_BUDGET_APPROVAL]: { label: 'Kailangan ng approval', tone: 'pending' },
  [OrderStatus.PASSENGER_ONBOARD]: { label: 'Nakasakay na', tone: 'active' },
  [OrderStatus.PICKED_UP]: { label: 'Nakuha na', tone: 'active' },
  [OrderStatus.IN_TRANSIT]: { label: 'Padating na', tone: 'active' },
  [OrderStatus.ARRIVED_AT_DROPOFF]: { label: 'Nasa labas na', tone: 'active' },
  [OrderStatus.DELIVERED]: { label: 'Nadeliver', tone: 'done' },
  [OrderStatus.DROPPED_OFF]: { label: 'Nakarating', tone: 'done' },
  [OrderStatus.COMPLETED]: { label: 'Tapos na', tone: 'done' },
  [OrderStatus.FAILED_DELIVERY]: { label: 'Hindi na-deliver', tone: 'failed' },
  [OrderStatus.CANCELLED_BY_CUSTOMER]: { label: 'Kinansela mo', tone: 'failed' },
  [OrderStatus.CANCELLED_BY_MERCHANT]: { label: 'Kinansela ng store', tone: 'failed' },
  [OrderStatus.CANCELLED_BY_RIDER]: { label: 'Kinansela ng rider', tone: 'failed' },
  [OrderStatus.CANCELLED_BY_SYSTEM]: { label: 'Kinansela', tone: 'failed' },
};

export function statusPresentation(status: OrderStatus): StatusPresentation {
  return ORDER_STATUS_PRESENTATION[status];
}
