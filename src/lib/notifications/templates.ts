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
  /** For a subscription bill: what to send, where to quote it, and by when. */
  invoiceReference?: string;
  dueLabel?: string;
  /** For a lapse: how long paying late still restores the plan. */
  recoveryDays?: number;
  /** For a security alert: what changed, in the person's own terms. */
  securityEvent?: string;
  /** Masked — the last four digits of the number the account moved to. */
  maskedPhone?: string;
  /** For a launch: the city the person was standing in when they asked. */
  cityName?: string;
  /** For an error alert: the kind, and where it happened. */
  errorKind?: string;
  errorRoute?: string;
  /** For support: the reference a person can quote, and what it is about. */
  ticketNumber?: string;
  ticketSubject?: string;
  /** For a waiting ticket: "4 hours". Already rendered by `describeWait`. */
  waitLabel?: string;
  /** For store access: what they are at the shop (`storeName` is above). */
  storeRoleLabel?: string;
  storeAccessEvent?: 'GRANTED' | 'ROLE_CHANGED' | 'REMOVED';
  /** For a payment: what it was for, and what is wrong with it if anything. */
  paymentLabel?: string;
  paymentShortfallCentavos?: number;
  /** For a payment awaiting review: how many are queued behind it. */
  paymentQueueDepth?: number;
  /** For a ratings digest: how many, the average, and the worst of them. */
  ratingCount?: number;
  ratingAverage?: number;
  ratingLowest?: number;
  /** "your deliveries" or "the food" — what was being rated. */
  ratingSubject?: string;
  /**
   * Which of the three things happened. Without it a customer's reply to a
   * thread reads as a brand-new ticket, and an administrator learns to stop
   * believing the title.
   */
  ticketEvent?: 'NEW' | 'CUSTOMER_REPLIED' | 'STILL_WAITING';
  /**
   * For a fleet decision: whether it was a yes. A boolean rather than the
   * status enum, because a template that switched on `VerificationStatus`
   * would be a second place deciding what each status means.
   */
  verificationApproved?: boolean;
  /** For a surge alert: the step's own name, and what it adds per job. */
  surgeLabel?: string;
  surgeCentavos?: number;
  /** For a surge alert: the market, so a rider knows whether it is near them. */
  surgeOrdersWaiting?: number;
  surgeRidersAvailable?: number;
  /** For a sustained-surge alert: how long it has been pinned there. */
  surgeMinutes?: number;
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
   * The bill, sent a week before the money is needed.
   *
   * It carries the amount and the reference because those are the two things
   * somebody needs in their transfer app, and putting them in the notification
   * means they never have to open TARA to pay TARA. The deadline is stated
   * plainly rather than as "soon": a subscription lapses on a date, and the
   * customer should be told which one.
   */
  [NotificationKind.SUBSCRIPTION_INVOICE_DUE]: (context) => ({
    title: `${context.planName ?? 'Your plan'} renews ${context.dueLabel ?? 'soon'}`,
    body: [
      context.amountCentavos
        ? `Send ${formatCentavos(context.amountCentavos)} to keep your benefits.`
        : 'Your renewal is due.',
      context.invoiceReference
        ? `Put ${context.invoiceReference} in the note so we can match it.`
        : null,
    ]
      .filter(Boolean)
      .join(' '),
    // Composed from parts and joined, not interpolated. A template with an
    // absent field inlined leaves "ref  by" — two spaces and a missing word —
    // and `notifications.test.ts` refuses that for every kind, which is how
    // this one was caught before it went out to anybody.
    sms: [
      `TARA ${context.planName ?? 'plan'}:`,
      'send',
      context.amountCentavos ? formatCentavos(context.amountCentavos) : 'your renewal',
      context.invoiceReference ? `ref ${context.invoiceReference}` : null,
      `by ${context.dueLabel ?? 'the due date'}.`,
    ]
      .filter(Boolean)
      .join(' '),
  }),

  /**
   * The term ran out unpaid.
   *
   * Leads with the consequence rather than the bill, because the consequence
   * is what the customer will otherwise discover at checkout — and being told
   * by a delivery fee is worse than being told by us. Then says the door is
   * still open, with the number of days, because a vague "soon" gets ignored.
   */
  [NotificationKind.SUBSCRIPTION_PAST_DUE]: (context) => ({
    title: `${context.planName ?? 'Your plan'} is unpaid`,
    body: `Your benefits have stopped for now. Paying${
      context.recoveryDays ? ` within ${context.recoveryDays} days` : ' soon'
    } puts them straight back.`,
    sms: `Your TARA ${context.planName ?? 'plan'} is unpaid and benefits have stopped. Pay to restore it.`,
  }),

  /**
   * Somebody checked the transfer and the plan is on.
   *
   * The one subscription message a customer is actively waiting for. On a rail
   * where a person confirms by hand, there is real time between "I have sent
   * it" and "we have it", and an app that says nothing in that gap is
   * indistinguishable from one that lost the payment.
   *
   * It carries the date the term runs to, not "you are subscribed". A month is
   * what was bought, and the next thing that will happen is another bill.
   */
  [NotificationKind.SUBSCRIPTION_PAYMENT_CONFIRMED]: (context) => ({
    title: `${context.planName ?? 'Your plan'} is on`,
    body: [
      'We have your payment.',
      context.dueLabel
        ? `Your benefits apply at checkout until ${context.dueLabel}.`
        : 'Your benefits apply at checkout from now.',
    ].join(' '),
    sms: [
      `TARA ${context.planName ?? 'plan'}: payment received.`,
      context.dueLabel ? `Benefits run to ${context.dueLabel}.` : 'Benefits are on.',
    ].join(' '),
  }),

  /**
   * The reference did not check out.
   *
   * Carries the reason VERBATIM, which makes the refusal text in the console
   * something a customer reads. The bill is still owed and the message says so
   * — a mistyped digit is not a cancellation, and telling somebody their
   * payment "failed" when the money may well be sitting in the account is how
   * a fixable problem becomes a lost subscriber.
   */
  [NotificationKind.SUBSCRIPTION_PAYMENT_REFUSED]: (context) => ({
    title: `We could not match your ${context.planName ?? 'plan'} payment`,
    body: [
      context.reason ?? 'The reference you sent did not match a transfer we can see.',
      'The bill is still open — send a corrected reference and we will check again.',
    ].join(' '),
    sms: [
      'TARA:',
      context.reason ?? 'we could not match your subscription payment.',
      'Open the app to send a corrected reference.',
    ].join(' '),
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

  /**
   * To an administrator. Says the wait out loud, because "a ticket came in" and
   * "a ticket has been sitting for four hours" are the same sentence otherwise
   * and only one of them is an emergency.
   */
  [NotificationKind.SUPPORT_TICKET_WAITING]: (context) => {
    const reference = context.ticketNumber ?? 'a ticket';
    const event = context.ticketEvent ?? 'NEW';
    const title =
      event === 'STILL_WAITING'
        ? `Waiting ${context.waitLabel ?? 'a while'}: ${reference}`
        : event === 'CUSTOMER_REPLIED'
          ? `Customer replied: ${reference}`
          : `New support ticket ${reference}`;
    return {
      title,
      body:
        `${context.ticketSubject ?? 'Somebody needs help'}${
          event === 'STILL_WAITING'
            ? ` — no answer for ${context.waitLabel ?? 'a while'}.`
            : event === 'CUSTOMER_REPLIED'
              ? ' — they have added something and it is back in the queue.'
              : '.'
        } Open the queue to read it and reply.`,
      sms: context.ticketNumber
        ? `TARA: support ticket ${context.ticketNumber} needs an answer.`
        : 'TARA: a support ticket needs an answer.',
    };
  },

  /**
   * To the customer. Carries no part of the reply itself: the body of a support
   * message can contain anything a person typed, including details about the
   * account, and an SMS is delivered to whoever is holding the phone.
   */
  /**
   * Store access. One kind for three events, told apart by
   * `storeAccessEvent` — a removal announced as "You have been added" would be
   * worse than saying nothing.
   */
  [NotificationKind.STORE_ACCESS_CHANGED]: (context) => {
    const store = context.storeName ?? 'a store';
    const role = context.storeRoleLabel ?? 'staff';
    if (context.storeAccessEvent === 'REMOVED') {
      return {
        title: `You no longer work ${store}`,
        body:
          `Your access to ${store} has been removed. Your own orders and ` +
          'credits are untouched — this is only about the store.',
        sms: `TARA: your access to ${store} has been removed.`,
      };
    }
    if (context.storeAccessEvent === 'ROLE_CHANGED') {
      return {
        title: `You are now ${role} at ${store}`,
        body: `Your role at ${store} changed to ${role}. Open the store to see what that covers.`,
        sms: `TARA: you are now ${role} at ${store}.`,
      };
    }
    return {
      title: `You can now work ${store}`,
      body:
        `You have been added to ${store} as ${role}. Open it from your ` +
        'profile to take orders.',
      sms: `TARA: you have been added to ${store} as ${role}.`,
    };
  },

  /**
   * A ratings digest.
   *
   * Carries the numbers and NEVER the customer's words. A comment is text
   * somebody typed about a person, and a notification is delivered to a lock
   * screen — which is both the wrong place to read it and the wrong place for
   * it to be read by somebody else.
   *
   * It does name the WORST score when one is poor. Saying "3 new ratings" and
   * hiding that one of them was a two would be a digest people learn to
   * ignore, and the bad one is the whole reason to look.
   */
  [NotificationKind.RATINGS_RECEIVED]: (context) => {
    const count = context.ratingCount ?? 1;
    const what = context.ratingSubject ?? 'your work';
    const plural = count === 1 ? 'rating' : 'ratings';
    const average =
      context.ratingAverage === undefined ? null : context.ratingAverage.toFixed(1);
    const poor = context.ratingLowest !== undefined && context.ratingLowest <= 3;

    return {
      title:
        count === 1 && context.ratingLowest !== undefined
          ? `A ${context.ratingLowest}-star rating`
          : `${count} new ${plural}`,
      body:
        `${count} new ${plural} for ${what}` +
        (average === null ? '' : `, averaging ${average}`) +
        (poor
          ? `. The lowest was ${context.ratingLowest} — open it to read what they said.`
          : '. Open it to see the details.'),
      sms: `TARA: you have ${count} new ${plural}.`,
    };
  },

  [NotificationKind.SUPPORT_REPLY]: (context) => ({
    title: 'Support replied',
    body:
      `Somebody has answered your message${
        context.ticketSubject ? ` about "${context.ticketSubject}"` : ''
      }. Tap to read it and reply.`,
    sms: `TARA: support has replied to ${
      context.ticketNumber ?? 'your message'
    }. Open the app to read it.`,
  }),

  /**
   * A decision on a fleet application.
   *
   * Names the service in the title, because "you have been approved" without
   * saying for what is not something anybody can act on — and a partner may
   * hold three applications at three different stages at once.
   *
   * A refusal carries the reason verbatim. That is the whole value of the
   * message: the point of telling somebody their application failed is that
   * they can fix the thing and come back.
   */
  /**
   * Paid, and moving.
   *
   * Says what happens next rather than only that the payment landed, because
   * "payment received" on its own leaves somebody wondering whether they now
   * have to do something else. They do not.
   */
  [NotificationKind.PAYMENT_CONFIRMED]: (context) => ({
    title: `Payment received${orderRef(context)}`,
    body:
      `We matched your ${context.paymentLabel ?? 'payment'} and sent your order ` +
      `to ${context.storeName ?? 'the store'}. Nothing to hand over at the door.`,
    sms: `TARA: payment received for ${context.orderNumber ?? 'your order'}.`,
  }),

  /**
   * Something is wrong with the money and only they can fix it.
   *
   * The reason is passed through verbatim and put first. A message that says
   * "there was a problem with your payment, open the app" wastes the one
   * channel that reached them — they still do not know whether to re-send a
   * reference, send more money, or wait.
   */
  [NotificationKind.PAYMENT_NEEDS_ATTENTION]: (context) => {
    const shortfall = context.paymentShortfallCentavos;
    const detail =
      context.reason ??
      (shortfall && shortfall > 0
        ? `We are short ₱${(shortfall / 100).toFixed(2)} on this order.`
        : 'We could not match your payment.');
    return {
      title: `Your payment needs a look${orderRef(context)}`,
      body: `${detail} Open the order to send a new reference number.`,
      sms: `TARA: ${detail} Open the app for ${context.orderNumber ?? 'your order'}.`,
    };
  },

  /**
   * We have their money and their order is off.
   *
   * Deliberately does not promise a time. On this rail a person makes the
   * transfer by hand, and an app that says "within 24 hours" when it has no
   * way to enforce that has invented a deadline for somebody else to miss.
   * What it does promise is the amount and the destination, which is what
   * makes the message worth sending at all.
   */
  [NotificationKind.PAYMENT_REFUND_DUE]: (context) => ({
    title: `Refund on the way${orderRef(context)}`,
    body:
      `Your order was cancelled and we are holding ${
        context.amountCentavos !== undefined
          ? formatCentavos(context.amountCentavos)
          : 'your payment'
      }. It is being sent back to your ${context.paymentLabel ?? 'account'} — ` +
      'you do not need to do anything.',
    sms: `TARA: ${
      context.amountCentavos !== undefined ? formatCentavos(context.amountCentavos) : 'your payment'
    } for ${context.orderNumber ?? 'your order'} is being returned.`,
  }),

  /**
   * Money going back, and where to.
   *
   * Names the instrument rather than saying "refunded", because on this rail
   * the money returns to a wallet by hand and somebody has to know which one
   * to check. Deliberately does not promise a time we do not control.
   */
  [NotificationKind.PAYMENT_REFUNDED]: (context) => ({
    title: `Refund sent${orderRef(context)}`,
    body:
      `${
        context.amountCentavos !== undefined
          ? `₱${(context.amountCentavos / 100).toFixed(2)}`
          : 'Your payment'
      } is on its way back to your ${context.paymentLabel ?? 'account'}.` +
      (context.reason ? ` ${context.reason}` : ''),
    sms: `TARA: refund sent for ${context.orderNumber ?? 'your order'}.`,
  }),

  /**
   * To us: somebody is waiting on a human.
   *
   * Carries the queue depth because one waiting payment and eleven waiting
   * payments call for different responses, and the number is the difference
   * between a task and a problem.
   */
  [NotificationKind.PAYMENT_AWAITING_REVIEW]: (context) => {
    const depth = context.paymentQueueDepth ?? 1;
    return {
      title: depth === 1 ? 'A payment needs checking' : `${depth} payments need checking`,
      body:
        `A customer says they have paid${orderRef(context)} and the order is ` +
        'held until somebody confirms it. Check the account and confirm or refuse.',
      // Never sent — PAYMENT_AWAITING_REVIEW has no SMS channel in
      // `KIND_POLICY`, because at any volume texting ourselves to do our own
      // job is a bill with no recipient who needed it. Written anyway because
      // the type asks for it, and a future decision to add the channel should
      // not have to invent the words under pressure.
      sms: `TARA: ${depth} payment(s) waiting to be confirmed.`,
    };
  },

  /**
   * Your invite was settled.
   *
   * Two messages from one kind, because they are the same event and a person
   * who shared a code is waiting on the answer either way. The refusal names
   * the reason verbatim — "their first order was below the minimum" is
   * something they can act on next time, and an unexplained absence is not.
   */
  [NotificationKind.REFERRAL_SETTLED]: (context) => {
    const amount = context.amountCentavos ?? 0;
    if (amount > 0) {
      return {
        title: `${formatCentavos(amount)} in credits from your invite`,
        body:
          `Somebody you invited placed their first order and it arrived, so ` +
          `${formatCentavos(amount)} is in your credits. Spend it on your next order.`,
        sms: `TARA: ${formatCentavos(amount)} credits from your invite.`,
      };
    }
    return {
      title: 'Your invite did not earn credits',
      body:
        (context.reason ?? 'Your invite could not be paid this time.') +
        ' Nothing was taken from you, and your code still works.',
      sms: 'TARA: your invite did not earn credits. Open the app for details.',
    };
  },

  /**
   * To an offline rider: your city is short of riders and there is more money
   * on every job right now.
   *
   * Written as an invitation with the numbers in it, not as an instruction.
   * The amount is the whole point — "it is busy" tells a rider nothing they
   * can decide on, and a message that asks somebody to go out in the rain owes
   * them the figure it is worth. The queue depth is there because a rider
   * knows their own city: three waiting is a rush, twelve is a night.
   *
   * There is no SMS form and there never should be. This is the one kind sent
   * to a whole city's worth of riders at once, so a peso a message turns a busy
   * Friday into the biggest line on the bill — and it is also the one kind
   * nobody is waiting for, which is exactly the shape of message that teaches
   * people to ignore texts from us.
   */
  [NotificationKind.SURGE_ACTIVE]: (context) => {
    const extra = formatCentavos(context.surgeCentavos ?? 0);
    const city = context.cityName ?? 'your area';
    const waiting = context.surgeOrdersWaiting ?? 0;
    return {
      title: `${extra} extra per job in ${city}`,
      body:
        `${context.surgeLabel ?? 'Busy'} right now — ${waiting} ` +
        `${waiting === 1 ? 'order' : 'orders'} waiting for a rider. ` +
        `Go online and ${extra} is added to every job you take while it lasts.`,
      // Never sent. Kept truthful rather than empty, because an SMS body is a
      // stored column and a blank one would read as a bug to whoever finds it.
      sms: `TARA: ${extra} extra per job in ${city} right now.`,
    };
  },

  /**
   * To an administrator: a market has been at its top step long enough that
   * the price is no longer doing anything.
   *
   * Deliberately not phrased as an incident. Surge exists to pull riders out
   * for a spike; a market pinned at the ceiling for an hour has been offered
   * everything the ladder has and is still short, which is a recruitment
   * problem rather than a pricing one. The message says that, so nobody spends
   * the afternoon adding a higher step.
   */
  [NotificationKind.SURGE_SUSTAINED]: (context) => {
    const city = context.cityName ?? 'a city';
    const minutes = context.surgeMinutes ?? 0;
    return {
      title: `${city}: top surge step for ${minutes} minutes`,
      body:
        `${city} has been at ${formatCentavos(context.surgeCentavos ?? 0)} — ` +
        `the highest step configured — for ${minutes} minutes, with ` +
        `${context.surgeOrdersWaiting ?? 0} waiting and ` +
        `${context.surgeRidersAvailable ?? 0} riders free. That is short ` +
        'staffing rather than a spike, and a higher step will not fix it.',
      sms: `TARA: ${city} has been at the top surge step for ${minutes} minutes.`,
    };
  },

  [NotificationKind.FLEET_VERIFICATION_DECIDED]: (context) => {
    const service = context.serviceName ?? 'a service';
    const approved = context.verificationApproved === true;
    return {
      title: approved ? `Approved for ${service}` : `${service}: not approved`,
      body:
        (approved
          ? `You can take ${service} jobs now — go online and offers will reach you.`
          : `Your ${service} application was not approved.`) +
        (context.reason ? ` Reason: ${context.reason}` : ''),
      sms: approved
        ? `TARA: you are approved for ${service}.`
        : `TARA: your ${service} application was not approved. Open the app for details.`,
    };
  },
};

export function renderNotification(
  kind: NotificationKind,
  context: NotificationContext,
): RenderedNotification {
  return NOTIFICATION_TEMPLATES[kind](context);
}
