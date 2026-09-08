import {
  NotificationKind,
  PaymentEventType,
  PaymentMethod,
  PaymentStatus,
  OrderStatus,
  type PaymentEvent,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { releaseAfterPayment } from '@/lib/orders/state-machine';
import { enqueueNotification } from '@/lib/notifications/enqueue';
import { administratorsToAlert } from '@/lib/monitoring/queries';
import { countPaymentsToCheck } from '@/lib/admin/payments';
import { recordPaymentEvent, syncOrderPaymentStatus } from '@/lib/payments/events';
import {
  isPrepaid,
  normaliseReference,
  refundDestinationFor,
} from '@/lib/payments/policy';
import { resolvePaymentRail } from '@/lib/payments/rails';
import type { PaymentStart } from '@/lib/payments/rails';

/**
 * The manual transfer rail's operations: what the customer does, and what the
 * person checking the account does about it.
 *
 * Every refusal here is a typed error rather than a boolean, because each one
 * needs different words in front of a different person — a customer who
 * mistyped a reference, an administrator confirming an order that was already
 * confirmed, or a developer who wired a screen to an order that cannot be paid
 * this way.
 */

export class PaymentNotExpectedError extends Error {
  constructor(readonly orderNumber: string) {
    super(`Order ${orderNumber} is not waiting for a transfer.`);
    this.name = 'PaymentNotExpectedError';
  }
}

export class PaymentRailUnavailableError extends Error {
  constructor() {
    super(
      'No prepaid rail is configured. Set PAYMENT_TRANSFER_LABEL, ' +
        'PAYMENT_TRANSFER_ACCOUNT_NAME and PAYMENT_TRANSFER_ACCOUNT_NUMBER.',
    );
    this.name = 'PaymentRailUnavailableError';
  }
}

export class UnreadableReferenceError extends Error {
  constructor() {
    super(
      'That does not look like a reference number. Copy it from the receipt in ' +
        'your wallet app — it is usually 13 digits.',
    );
    this.name = 'UnreadableReferenceError';
  }
}

export class PaymentAlreadySettledError extends Error {
  constructor(readonly status: PaymentStatus) {
    super(`This payment is already ${status.toLowerCase()}.`);
    this.name = 'PaymentAlreadySettledError';
  }
}

/**
 * The wallet's name, for a message that has to tell somebody where to look.
 *
 * Falls back rather than throwing: a notification is not the place to discover
 * that configuration is missing, and "your account" is true of every wallet.
 */
function railLabel(): string {
  return resolvePaymentRail()?.customerLabel ?? 'account';
}

/** The order fields every operation here needs. Nothing wider. */
const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  customerId: true,
  serviceType: true,
  status: true,
  paymentMethod: true,
  paymentStatus: true,
  totalCentavos: true,
} as const;

/**
 * What the customer has to do to pay, resolved against the configured rail.
 *
 * Read at display time rather than stored on the order: the account money goes
 * to is a property of the business today, not of an order placed last week, and
 * copying it onto every order would mean a changed number silently telling old
 * orders to pay the wrong place.
 */
export async function paymentInstructionsFor(orderId: string): Promise<PaymentStart> {
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: ORDER_SELECT,
  });

  if (!isPrepaid(order.paymentMethod) || order.totalCentavos <= 0) {
    throw new PaymentNotExpectedError(order.orderNumber);
  }

  const rail = resolvePaymentRail();
  if (!rail) throw new PaymentRailUnavailableError();

  return rail.begin({
    orderNumber: order.orderNumber,
    amountCentavos: order.totalCentavos,
  });
}

/**
 * The customer says they have sent it, and gives us something to check.
 *
 * Records a claim, not a payment: `CHARGE_SUBMITTED` moves no money, and the
 * order stays in PENDING_PAYMENT until a human confirms. That gap is the whole
 * safety of this rail — anyone can type thirteen digits.
 *
 * Re-submitting is allowed on purpose. A mistyped reference is the most common
 * thing that happens here, and both attempts stay in the history because which
 * one was checked matters if the payment is ever disputed.
 */
export async function submitPaymentReference(input: {
  orderId: string;
  userId: string;
  reference: string;
}): Promise<{ event: PaymentEvent; paymentStatus: PaymentStatus }> {
  const reference = normaliseReference(input.reference);
  if (!reference) throw new UnreadableReferenceError();

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: input.orderId },
    select: ORDER_SELECT,
  });

  // Not `customerId !== userId` as a 404 here: the caller is the customer's own
  // action and has already checked ownership. This is the belt.
  if (order.customerId !== input.userId) {
    throw new PaymentNotExpectedError(order.orderNumber);
  }
  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    throw new PaymentNotExpectedError(order.orderNumber);
  }
  if (
    order.paymentStatus === PaymentStatus.PAID ||
    order.paymentStatus === PaymentStatus.REFUNDED
  ) {
    throw new PaymentAlreadySettledError(order.paymentStatus);
  }

  const result = await recordPaymentEvent({
    orderId: order.id,
    type: PaymentEventType.CHARGE_SUBMITTED,
    method: order.paymentMethod,
    reference,
    actorUserId: input.userId,
  });

  // Tell whoever can act, immediately rather than on a sweep. This is the one
  // queue in the application with a customer standing still behind it: their
  // food is not being cooked until a human looks at an account, so a delay we
  // choose to add is a delay we are choosing to make them wait.
  //
  // Outside the event's transaction on purpose. The claim is recorded and the
  // customer has been answered by that point, and a notification failing is
  // not a reason to lose their reference — they would have to send it again
  // while the money has already left.
  const admins = await administratorsToAlert();
  const queueDepth = await countPaymentsToCheck();
  for (const admin of admins) {
    await enqueueNotification({
      userId: admin.id,
      kind: NotificationKind.PAYMENT_AWAITING_REVIEW,
      relatedOrderId: order.id,
      href: '/admin/payments',
      context: {
        orderNumber: order.orderNumber,
        amountCentavos: order.totalCentavos,
        paymentQueueDepth: queueDepth,
      },
      // Per attempt, not per order: a corrected reference is a new thing to
      // check, and silently swallowing the second one is how a customer waits
      // forever on a number nobody looked at.
      dedupeKey: `payment-review:${result.event.id}:${admin.id}`,
    });
  }

  return { event: result.event, paymentStatus: result.paymentStatus };
}

/**
 * A human confirms the money arrived, and the order goes to the shop.
 *
 * One transaction: the event, the derived status and the release are one fact
 * as far as anybody watching is concerned. A confirmed payment on an order
 * still sitting in PENDING_PAYMENT is the failure mode worth paying a
 * transaction to avoid — the customer has paid and the shop has not been told.
 *
 * `amountCentavos` defaults to the order total but is settable, because the
 * thing that actually happens on this rail is somebody sending the wrong
 * amount. Recording ₱300 against a ₱324 order leaves the order AUTHORIZED
 * rather than PAID, which is exactly right: it is not paid, and the derived
 * status says so without anybody having to remember.
 */
export async function confirmPayment(input: {
  orderId: string;
  adminUserId: string;
  amountCentavos?: number;
  reference?: string;
  note?: string;
}): Promise<{ paymentStatus: PaymentStatus; released: boolean }> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      select: ORDER_SELECT,
    });

    if (!isPrepaid(order.paymentMethod)) {
      throw new PaymentNotExpectedError(order.orderNumber);
    }
    if (
      order.paymentStatus === PaymentStatus.PAID ||
      order.paymentStatus === PaymentStatus.REFUNDED
    ) {
      throw new PaymentAlreadySettledError(order.paymentStatus);
    }

    const amountCentavos = input.amountCentavos ?? order.totalCentavos;

    const { paymentStatus } = await recordPaymentEvent(
      {
        orderId: order.id,
        type: PaymentEventType.CHARGE_CONFIRMED,
        method: order.paymentMethod,
        amountCentavos,
        reference: input.reference ?? null,
        note: input.note ?? null,
        actorUserId: input.adminUserId,
        // One confirmation per order. An administrator double-tapping gets the
        // first row back rather than taking the money twice.
        idempotencyKey: `charge-confirmed:${order.id}`,
      },
      tx,
    );

    // Short payments do not open the kitchen. The customer is told what is
    // missing and the order keeps waiting.
    const released =
      paymentStatus === PaymentStatus.PAID &&
      order.status === OrderStatus.PENDING_PAYMENT;

    if (released) {
      await releaseAfterPayment(
        { orderId: order.id, serviceType: order.serviceType },
        tx,
      );
    }

    await enqueueNotification(
      {
        userId: order.customerId,
        kind: released
          ? NotificationKind.PAYMENT_CONFIRMED
          : NotificationKind.PAYMENT_NEEDS_ATTENTION,
        relatedOrderId: order.id,
        href: `/orders/${order.id}`,
        context: {
          orderNumber: order.orderNumber,
          paymentLabel: railLabel(),
          ...(released
            ? {}
            : { paymentShortfallCentavos: order.totalCentavos - amountCentavos }),
        },
        dedupeKey: `payment-confirmed:${order.id}:${paymentStatus}`,
      },
      tx,
    );

    return { paymentStatus, released };
  });
}

/**
 * The reference did not check out.
 *
 * Does not cancel the order. The customer may have fat-fingered a digit and
 * the money may well be sitting in the account — so they get told why and keep
 * their slot until the payment window runs out on its own. Cancelling on the
 * first bad reference would strand real payments.
 */
export async function refusePayment(input: {
  orderId: string;
  adminUserId: string;
  note: string;
}): Promise<{ paymentStatus: PaymentStatus }> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      select: ORDER_SELECT,
    });

    if (order.paymentStatus === PaymentStatus.PAID) {
      throw new PaymentAlreadySettledError(order.paymentStatus);
    }

    const { paymentStatus } = await recordPaymentEvent(
      {
        orderId: order.id,
        type: PaymentEventType.CHARGE_REFUSED,
        method: order.paymentMethod,
        note: input.note,
        actorUserId: input.adminUserId,
      },
      tx,
    );

    await enqueueNotification(
      {
        userId: order.customerId,
        kind: NotificationKind.PAYMENT_NEEDS_ATTENTION,
        relatedOrderId: order.id,
        href: `/orders/${order.id}`,
        context: {
          orderNumber: order.orderNumber,
          paymentLabel: railLabel(),
          // The reason reaches the customer verbatim. A "no" they cannot act
          // on is worse than no answer, because they stop trying.
          reason: input.note,
        },
        // Keyed to the event, not the order: a customer who mistypes twice
        // gets told twice, because each refusal is about a different attempt.
        dedupeKey: `payment-refused:${order.id}:${Date.now()}`,
      },
      tx,
    );

    return { paymentStatus };
  });
}

/**
 * Money goes back the way it came.
 *
 * Records that a refund was made; it does not make one. On this rail somebody
 * sends the transfer back by hand, and this is the row proving they said they
 * did — with who, when, how much and why. A provider rail would call the
 * provider here and record the same row.
 *
 * The one thing it refuses to do is put the money into credits. That check
 * lives in `refundDestinationFor`, and the database repeats it in
 * `payment_events_append_only.sql` guard 4, because a cash-to-credits path is
 * a top-up and this product does not have one.
 */
export async function recordRefundToSource(input: {
  orderId: string;
  adminUserId: string;
  amountCentavos: number;
  note: string;
}): Promise<{ paymentStatus: PaymentStatus }> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      select: ORDER_SELECT,
    });

    if (refundDestinationFor(order.paymentMethod) !== 'SOURCE_OF_FUNDS') {
      // A credits-paid order refunds through the credits ledger, which has its
      // own function, its own idempotency and its own guards. Routing it here
      // would write a payment row for money that never left the platform.
      throw new PaymentNotExpectedError(order.orderNumber);
    }

    const received = await tx.paymentEvent.aggregate({
      where: { orderId: order.id, amountCentavos: { gt: 0 } },
      _sum: { amountCentavos: true },
    });
    const refunded = await tx.paymentEvent.aggregate({
      where: { orderId: order.id, amountCentavos: { lt: 0 } },
      _sum: { amountCentavos: true },
    });
    const outstanding =
      (received._sum.amountCentavos ?? 0) + (refunded._sum.amountCentavos ?? 0);

    if (input.amountCentavos > outstanding) {
      throw new PaymentNotExpectedError(order.orderNumber);
    }

    const { paymentStatus } = await recordPaymentEvent(
      {
        orderId: order.id,
        type: PaymentEventType.REFUND_ISSUED,
        method: order.paymentMethod,
        amountCentavos: input.amountCentavos,
        note: input.note,
        actorUserId: input.adminUserId,
      },
      tx,
    );

    await enqueueNotification(
      {
        userId: order.customerId,
        kind: NotificationKind.PAYMENT_REFUNDED,
        relatedOrderId: order.id,
        href: `/orders/${order.id}`,
        context: {
          orderNumber: order.orderNumber,
          amountCentavos: input.amountCentavos,
          paymentLabel: railLabel(),
          reason: input.note,
        },
        // Partial refunds are legitimate and repeatable, so the amount is part
        // of the key: two different refunds are two different messages.
        dedupeKey: `payment-refunded:${order.id}:${input.amountCentavos}`,
      },
      tx,
    );

    return { paymentStatus };
  });
}

/**
 * Writes down that a rider took cash.
 *
 * Called when a cash order completes, which is where the codebase already
 * decided a cash order is paid — this makes that decision a row instead of a
 * column write, so a cash order and a transfer have the same kind of history.
 * Idempotent on the order, because completion can be retried.
 */
export async function recordCashCollected(
  input: { orderId: string; amountCentavos: number },
  client?: PrismaTransactionClient,
): Promise<PaymentStatus> {
  if (input.amountCentavos <= 0) {
    return syncOrderPaymentStatus(input.orderId, client);
  }

  const { paymentStatus } = await recordPaymentEvent(
    {
      orderId: input.orderId,
      type: PaymentEventType.CASH_COLLECTED,
      method: PaymentMethod.CASH_ON_DELIVERY,
      amountCentavos: input.amountCentavos,
      idempotencyKey: `cash-collected:${input.orderId}`,
    },
    client,
  );
  return paymentStatus;
}
