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
const serviceName = (context: NotificationContext) => context.serviceName ?? 'Deliveryapp';

export const NOTIFICATION_TEMPLATES: Readonly<Record<NotificationKind, Template>> = {
  [NotificationKind.ORDER_SUBMITTED]: (context) => ({
    title: 'Bagong order',
    body: `May bagong ${serviceName(context)} order na naghihintay ng sagot mo${orderRef(context)}.`,
    sms: `Bagong order sa Deliveryapp${orderRef(context)}. Tanggapin o tanggihan sa loob ng 8 minuto, kung hindi ay makansela ito.`,
  }),

  [NotificationKind.ORDER_ACCEPTED]: (context) => ({
    title: 'Tinanggap ang order mo',
    body: `${context.storeName ?? 'Ang store'} ay tinanggap ang order mo at inihahanda na.`,
    sms: `Tinanggap na ng store ang order mo${orderRef(context)}.`,
  }),

  [NotificationKind.ORDER_READY]: (context) => ({
    title: 'Handa na ang order mo',
    body: 'Handa na ito at hinahanap na namin ang rider.',
    sms: `Handa na ang order mo${orderRef(context)}. Hinahanap na namin ang rider.`,
  }),

  [NotificationKind.ORDER_RIDER_ASSIGNED]: (context) => ({
    title: 'May rider na',
    body: 'Papunta na sa store ang rider para kunin ang order mo.',
    sms: `May rider na ang order mo${orderRef(context)}.`,
  }),

  [NotificationKind.ORDER_PICKED_UP]: (context) => ({
    title: 'Nakuha na ang order mo',
    body: 'Papunta na sa iyo ang rider.',
    sms: `Nakuha na ng rider ang order mo${orderRef(context)}. Papunta na.`,
  }),

  [NotificationKind.ORDER_ARRIVED]: (context) => ({
    title: 'Nasa labas na ang rider',
    body: 'Nandiyan na ang rider mo sa dropoff.',
    sms: `Nasa labas na ang rider mo${orderRef(context)}.`,
  }),

  [NotificationKind.ORDER_DELIVERED]: (context) => ({
    title: 'Nadeliver na',
    body: `Tapos na ang ${serviceName(context)} order mo. Salamat!`,
    sms: `Nadeliver na ang order mo${orderRef(context)}. Salamat!`,
  }),

  [NotificationKind.ORDER_CANCELLED]: (context) => ({
    title: 'Kinansela ang order',
    body: [
      `Kinansela ang ${serviceName(context)} order mo${orderRef(context)}.`,
      context.reason ? `Dahilan: ${context.reason}.` : null,
      context.amountCentavos
        ? `Ibinalik namin ang ${formatCentavos(context.amountCentavos)} sa Credits mo.`
        : null,
    ]
      .filter(Boolean)
      .join(' '),
    sms: [
      `Kinansela ang order mo${orderRef(context)}.`,
      context.amountCentavos
        ? `${formatCentavos(context.amountCentavos)} ang ibinalik sa Credits mo.`
        : null,
    ]
      .filter(Boolean)
      .join(' '),
  }),

  [NotificationKind.ORDER_LOST_TO_TIMEOUT]: (context) => ({
    title: 'Nawala ang isang order',
    body: `Hindi nasagot sa oras ang order${orderRef(context)}, kaya kinansela ito at naibalik ang bayad sa customer.`,
    sms: `Nakansela ang order${orderRef(context)} dahil hindi ito nasagot sa oras.`,
  }),

  [NotificationKind.DISPATCH_OFFER]: (context) => ({
    title: 'May job para sa iyo',
    body: [
      context.earningsCentavos ? `${formatCentavos(context.earningsCentavos)}` : 'May job',
      context.distanceLabel ? `· ${context.distanceLabel} papunta sa pickup` : null,
      context.storeName ? `· ${context.storeName}` : null,
    ]
      .filter(Boolean)
      .join(' '),
    sms: [
      'May bagong job sa Deliveryapp',
      context.earningsCentavos ? ` — ${formatCentavos(context.earningsCentavos)}` : '',
      context.secondsToAnswer ? `, ${context.secondsToAnswer}s para sagutin.` : '.',
    ].join(''),
  }),

  [NotificationKind.CREDITS_GRANTED]: (context) => ({
    title: 'May bagong credits ka',
    body: [
      context.creditsCentavos
        ? `${formatCentavos(context.creditsCentavos)} ang dumating sa Credits mo.`
        : 'May dumating na credits.',
      context.creditsReason ?? null,
    ]
      .filter(Boolean)
      .join(' '),
    sms: `May ${context.creditsCentavos ? formatCentavos(context.creditsCentavos) : ''} credits ka sa Deliveryapp.`,
  }),

  [NotificationKind.SUBSCRIPTION_ENDED]: (context) => ({
    title: 'Tapos na ang plan mo',
    body: `Tapos na ang ${context.planName ?? 'plan'} mo, kaya wala na munang benefits sa checkout.`,
    sms: `Tapos na ang ${context.planName ?? 'plan'} mo sa Deliveryapp.`,
  }),
};

export function renderNotification(
  kind: NotificationKind,
  context: NotificationContext,
): RenderedNotification {
  return NOTIFICATION_TEMPLATES[kind](context);
}
