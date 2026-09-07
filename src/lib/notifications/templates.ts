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
  /** For a security alert: what changed, in the person's own terms. */
  securityEvent?: string;
  /** Masked — the last four digits of the number the account moved to. */
  maskedPhone?: string;
  /** For a launch: the city the person was standing in when they asked. */
  cityName?: string;
  /** For an error alert: the kind, and where it happened. */
  errorKind?: string;
  errorRoute?: string;
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
  /**
   * The one message that exists to be unwelcome.
   *
   * Written so somebody who did NOT do this knows what to do in the first
   * sentence, because that person is the reason the message exists. It names
   * no support phone number on purpose — an alert that tells you where to call
   * is the shape a phishing message copies.
   */
  [NotificationKind.SECURITY_ALERT]: (context) => ({
    title: 'Your sign-in number changed',
    body:
      `${context.securityEvent ?? 'The phone number for this account was changed'}` +
      `${context.maskedPhone ? ` to ${context.maskedPhone}` : ''}. ` +
      'If this was you, nothing else is needed. If it was not, open Help now — ' +
      'your credits are on hold for three days, so nothing can be spent yet.',
    sms:
      `TARA: the sign-in number for your account was changed${
        context.maskedPhone ? ` to ${context.maskedPhone}` : ''
      }. Not you? Your credits are frozen for 3 days. Open Help in the app.`,
  }),

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

  /**
   * To an administrator: something is failing that was not failing before.
   *
   * The only notification in the system addressed to the people running the
   * business rather than to somebody using it, and the only one whose job is
   * to shorten the gap between a page breaking and anybody knowing. It carries
   * the fault, not the fix: a title somebody can triage from a lock screen,
   * and a link to the console for the stack.
   *
   * The message deliberately does NOT carry the error text. A stack in a push
   * notification is unreadable, and it would put a redacted-but-still-detailed
   * fault description on a lock screen in a jeepney.
   */
  [NotificationKind.ERROR_DETECTED]: (context) => ({
    title: `Something is failing: ${context.errorKind ?? 'an error'}`,
    body:
      `A fault not seen before${
        context.errorRoute ? ` at ${context.errorRoute}` : ''
      } was recorded just now. Open the console for the details — it is grouped, so ` +
      'you will see whether it is happening once or constantly.',
    sms: `TARA: a new fault${
      context.errorRoute ? ` at ${context.errorRoute}` : ''
    } — check /admin/errors.`,
  }),

  /**
   * The one message somebody asked for in advance.
   *
   * So it says so in the first clause: a launch announcement that does not
   * remind you that you put your hand up reads as marketing, and the person
   * has forgotten — the tap could have been months ago.
   */
  [NotificationKind.SERVICE_NOW_AVAILABLE]: (context) => ({
    title: `${serviceName(context)} is open${context.cityName ? ` in ${context.cityName}` : ''}`,
    body:
      `You asked for ${serviceName(context)}${
        context.cityName ? ` in ${context.cityName}` : ' here'
      }, and it is live now. Tap to have a look.`,
    sms: `TARA: ${serviceName(context)} is now available${
      context.cityName ? ` in ${context.cityName}` : ''
    } — you asked us to tell you.`,
  }),
};

export function renderNotification(
  kind: NotificationKind,
  context: NotificationContext,
): RenderedNotification {
  return NOTIFICATION_TEMPLATES[kind](context);
}
