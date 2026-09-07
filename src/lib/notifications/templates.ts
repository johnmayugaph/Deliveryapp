import { NotificationKind } from '@prisma/client';
import { formatCentavos } from '@/lib/money';

/**
 * The words.
 *
 * Rendered once, at enqueue time, and stored on the row — so what somebody was
 * told does not change because the copy was later edited, and an SMS body that
 * has already left the building stays on the record.
 *
 * Keyed by every kind. The service's own name arrives in the context from the
 * registry, which is why no template here knows that food exists.
 */

export interface NotificationContext {
  /**
   * From the registry: "Kainan", "Padala". Never hardcoded, and absent for the
   * kinds that are not about an order at all — a subscription ending belongs to
   * no vertical.
   */
  serviceName?: string;
  orderNumber?: string;
  storeName?: string;
  /** For a cancellation: what the customer paid, and gets back. */
  amountCentavos?: number;
  /** For an offer: what the partner earns, and how long they have. */
  earningsCentavos?: number;
  secondsToAnswer?: number;
  distanceLabel?: string;
  /** For credits: what arrived and why. */
  creditsCentavos?: number;
  creditsReason?: string;
  planName?: string;
  reason?: string;
}

export interface RenderedNotification {
  title: string;
  body: string;
  /**
   * The SMS version: shorter, and it carries the order number, because a text
   * arrives with no screen around it to say which order it is about.
   */
  sms: string;
}

type Template = (context: NotificationContext) => RenderedNotification;

const orderRef = (context: NotificationContext) =>
  context.orderNumber ? ` (${context.orderNumber})` : '';

/** The vertical's own name where there is one, the product's where there is not. */
const serviceName = (context: NotificationContext) => context.serviceName ?? 'TARA';

export const NOTIFICATION_TEMPLATES: Readonly<Record<NotificationKind, Template>> = {
  [NotificationKind.ORDER_SUBMITTED]: (context) => ({
    title: 'New order',
    body: `A new ${serviceName(context)} order is waiting for your answer${orderRef(context)}.`,
    sms: `New TARA order${orderRef(context)}. Accept or reject within 8 minutes, or it is cancelled.`,
  }),

  [NotificationKind.ORDER_ACCEPTED]: (context) => ({
    title: 'Your order was accepted',
    body: `${context.storeName ?? 'The store'} accepted your order and is preparing it.`,
    sms: `The store accepted your order${orderRef(context)}.`,
  }),

  [NotificationKind.ORDER_READY]: (context) => ({
    title: 'Your order is ready',
    body: 'It is ready, and we are finding a rider.',
    sms: `Your order is ready${orderRef(context)}. We are finding a rider.`,
  }),

  [NotificationKind.ORDER_RIDER_ASSIGNED]: (context) => ({
    title: 'A rider is on it',
    body: 'The rider is on the way to the store to collect your order.',
    sms: `A rider is on your order${orderRef(context)}.`,
  }),

  [NotificationKind.ORDER_PICKED_UP]: (context) => ({
    title: 'Your order was collected',
    body: 'The rider is on the way to you.',
    sms: `The rider collected your order${orderRef(context)} and is on the way.`,
  }),

  [NotificationKind.ORDER_ARRIVED]: (context) => ({
    title: 'Your rider is outside',
    body: 'Your rider is at the dropoff.',
    sms: `Your rider is outside${orderRef(context)}.`,
  }),

  [NotificationKind.ORDER_DELIVERED]: (context) => ({
    title: 'Delivered',
    body: `Your ${serviceName(context)} order is complete. Thank you!`,
    sms: `Your order was delivered${orderRef(context)}. Thank you!`,
  }),

  [NotificationKind.ORDER_CANCELLED]: (context) => ({
    title: 'Order cancelled',
    body: [
      `Your ${serviceName(context)} order was cancelled${orderRef(context)}.`,
      context.reason ? `Reason: ${context.reason}.` : null,
      context.amountCentavos
        ? `We returned ${formatCentavos(context.amountCentavos)} to your Credits.`
        : null,
    ]
      .filter(Boolean)
      .join(' '),
    sms: [
      `Your order was cancelled${orderRef(context)}.`,
      context.amountCentavos
        ? `${formatCentavos(context.amountCentavos)} went back to your Credits.`
        : null,
    ]
      .filter(Boolean)
      .join(' '),
  }),

  [NotificationKind.ORDER_LOST_TO_TIMEOUT]: (context) => ({
    title: 'An order was lost',
    body: `Order${orderRef(context)} was not answered in time, so it was cancelled and the customer refunded.`,
    sms: `Order${orderRef(context)} was cancelled because it was not answered in time.`,
  }),

  [NotificationKind.DISPATCH_OFFER]: (context) => ({
    title: 'A job for you',
    body: [
      context.earningsCentavos ? `${formatCentavos(context.earningsCentavos)}` : 'A job',
      context.distanceLabel ? `· ${context.distanceLabel} to the pickup` : null,
      context.storeName ? `· ${context.storeName}` : null,
    ]
      .filter(Boolean)
      .join(' '),
    sms: [
      'New TARA job',
      context.earningsCentavos ? ` — ${formatCentavos(context.earningsCentavos)}` : '',
      context.secondsToAnswer ? `, ${context.secondsToAnswer}s to answer.` : '.',
    ].join(''),
  }),

  [NotificationKind.CREDITS_GRANTED]: (context) => ({
    title: 'New credits',
    body: [
      context.creditsCentavos
        ? `${formatCentavos(context.creditsCentavos)} arrived in your Credits.`
        : 'Credits arrived.',
      context.creditsReason ?? null,
    ]
      .filter(Boolean)
      .join(' '),
    sms: `You have ${context.creditsCentavos ? formatCentavos(context.creditsCentavos) : ''} in TARA credits.`,
  }),

  [NotificationKind.SUBSCRIPTION_ENDED]: (context) => ({
    title: 'Your plan has ended',
    body: `Your ${context.planName ?? 'plan'} has ended, so no benefits apply at checkout for now.`,
    sms: `Your TARA ${context.planName ?? 'plan'} has ended.`,
  }),
};

export function renderNotification(
  kind: NotificationKind,
  context: NotificationContext,
): RenderedNotification {
  return NOTIFICATION_TEMPLATES[kind](context);
}
