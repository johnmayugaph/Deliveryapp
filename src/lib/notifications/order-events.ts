import { NotificationKind, OrderStatus } from '@prisma/client';
import type { NotificationAudience } from '@/lib/notifications/policy';

/**
 * Which order statuses are worth telling somebody about, and whom.
 *
 * Keyed by EVERY `OrderStatus`, so a new status in the superset cannot be added
 * without deciding whether it earns a message. Most do not: `null` is the
 * common answer, and each one says why in a word or two.
 *
 * There is no service branch here. PABILI's budget approval and RIDE's
 * passenger boarding appear as statuses like any other, and a vertical that
 * never reaches a status simply never fires its notification. The copy is keyed
 * by kind and takes the service's display NAME from the registry, so "Kainan"
 * versus "Padala" is data.
 */

/**
 * Who hears about a status, and what each of them is told.
 *
 * A map rather than a list because the same event is not the same news to
 * everybody: a timeout cancellation is "your order was cancelled and refunded"
 * to a customer and "you lost an order by not answering" to a store.
 */
export interface OrderNotificationSpec {
  audiences: Readonly<Partial<Record<NotificationAudience, NotificationKind>>>;
}

export const ORDER_STATUS_NOTIFICATIONS: Readonly<
  Record<OrderStatus, OrderNotificationSpec | null>
> = {
  // Not yet anybody's business: the customer is still in checkout.
  [OrderStatus.DRAFT]: null,
  [OrderStatus.PENDING_PAYMENT]: null,

  [OrderStatus.PENDING_MERCHANT_ACCEPTANCE]: {
    audiences: {
      MERCHANT: NotificationKind.ORDER_SUBMITTED,
    },
  },
  [OrderStatus.MERCHANT_ACCEPTED]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_ACCEPTED,
    },
  },
  // The customer already knows it was accepted; "now cooking" adds nothing.
  [OrderStatus.PREPARING]: null,
  [OrderStatus.READY_FOR_PICKUP]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_READY,
    },
  },
  // Internal: dispatch is looking. Telling a customer we have not found a rider
  // yet invites a question nobody can answer.
  [OrderStatus.AWAITING_RIDER_ASSIGNMENT]: null,
  [OrderStatus.RIDER_ASSIGNED]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_RIDER_ASSIGNED,
    },
  },
  // The store sees the rider walk in; the customer does not care yet.
  [OrderStatus.RIDER_AT_PICKUP]: null,
  // MART: the shopper is in the aisles. Worth a screen, not an interruption.
  [OrderStatus.SHOPPING_IN_PROGRESS]: null,
  // PABILI: this one is a genuine action for the customer, and PABILI is not
  // built yet — so it gets the same treatment as the rest of its lifecycle and
  // will need its own kind when the vertical ships.
  [OrderStatus.AWAITING_BUDGET_APPROVAL]: null,
  // RIDE: the passenger is in the vehicle and does not need a text about it.
  [OrderStatus.PASSENGER_ONBOARD]: null,
  [OrderStatus.PICKED_UP]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_PICKED_UP,
    },
  },
  // Between pickup and the doorstep there is nothing to do.
  [OrderStatus.IN_TRANSIT]: null,
  [OrderStatus.ARRIVED_AT_DROPOFF]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_ARRIVED,
    },
  },
  [OrderStatus.DELIVERED]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_DELIVERED,
    },
  },
  [OrderStatus.DROPPED_OFF]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_DELIVERED,
    },
  },
  // COMPLETED follows DELIVERED by seconds and is an accounting step. Where it
  // grants credit-back, the ledger raises CREDITS_GRANTED instead.
  [OrderStatus.COMPLETED]: null,

  [OrderStatus.FAILED_DELIVERY]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_CANCELLED,
      MERCHANT: NotificationKind.ORDER_CANCELLED,
    },
  },
  // The customer did it themselves, so they know. The store may have been
  // cooking.
  [OrderStatus.CANCELLED_BY_CUSTOMER]: {
    audiences: {
      MERCHANT: NotificationKind.ORDER_CANCELLED,
    },
  },
  [OrderStatus.CANCELLED_BY_MERCHANT]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_CANCELLED,
    },
  },
  [OrderStatus.CANCELLED_BY_RIDER]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_CANCELLED,
      MERCHANT: NotificationKind.ORDER_CANCELLED,
    },
  },
  // A system cancellation is a timeout: the store lost the order by not
  // answering, and the customer is owed an explanation and a refund.
  [OrderStatus.CANCELLED_BY_SYSTEM]: {
    audiences: {
      CUSTOMER: NotificationKind.ORDER_CANCELLED,
      // Not the same news: the store lost an order it never answered.
      MERCHANT: NotificationKind.ORDER_LOST_TO_TIMEOUT,
    },
  },
};

export function notificationForStatus(status: OrderStatus): OrderNotificationSpec | null {
  return ORDER_STATUS_NOTIFICATIONS[status];
}
