import {
  Prisma,
  PaymentEventType,
  PaymentMethod,
  type PaymentEvent,
  type PaymentStatus,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import {
  InvalidPaymentEventError,
  derivePaymentStatus,
  reasonIsRequired,
  signedPaymentAmount,
} from '@/lib/payments/policy';

export {
  CashCannotBecomeCreditsError,
  InvalidPaymentEventError,
} from '@/lib/payments/policy';

export interface RecordPaymentEventInput {
  orderId: string;
  type: PaymentEventType;
  method: PaymentMethod;
  /** A magnitude. The sign comes from the type. Zero for intent events. */
  amountCentavos?: number;
  rail?: string;
  reference?: string | null;
  /** Required for a refusal or a refund; the customer reads it. */
  note?: string | null;
  actorUserId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export interface PaymentEventResult {
  event: PaymentEvent;
  /** The order's payment status after this row, recomputed from all of them. */
  paymentStatus: PaymentStatus;
  /** True when an idempotency key matched and nothing new was written. */
  replayed: boolean;
}

/**
 * THE ONLY function in this codebase that records money moving on an order.
 *
 * The credits ledger's `recordWalletTransaction` twin, and the same shape:
 * append a row, recompute the derived status from every row, write the derived
 * value back. One function so that the invariants have one place to live, and
 * so a future rail cannot add a fifth way to mark an order paid.
 *
 * Serializable, because two events on one order — a provider webhook arriving
 * while an admin taps Confirm — must not both read the same prior state and
 * both decide the order is now fully paid.
 */
export async function recordPaymentEvent(
  input: RecordPaymentEventInput,
  client?: PrismaTransactionClient,
): Promise<PaymentEventResult> {
  const run = async (tx: PrismaTransactionClient): Promise<PaymentEventResult> => {
    const note = input.note?.trim() ?? '';
    if (reasonIsRequired(input.type) && note.length < 3) {
      throw new InvalidPaymentEventError(
        `${input.type} requires a reason: the customer is shown it, and a refusal ` +
          'with no reason leaves them unable to tell whether to try again.',
      );
    }

    // Idempotent replay. A provider retrying a webhook and an admin
    // double-tapping Confirm are the same event twice; the second must return
    // the first rather than take the money again.
    if (input.idempotencyKey) {
      const existing = await tx.paymentEvent.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        return {
          event: existing,
          paymentStatus: await syncOrderPaymentStatus(existing.orderId, tx),
          replayed: true,
        };
      }
    }

    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, totalCentavos: true },
    });
    if (!order) {
      throw new InvalidPaymentEventError(`No order with id "${input.orderId}"`);
    }

    const signedAmount = signedPaymentAmount(input.type, input.amountCentavos ?? 0);

    const event = await tx.paymentEvent.create({
      data: {
        orderId: order.id,
        type: input.type,
        method: input.method,
        provider: input.rail ?? 'manual',
        amountCentavos: signedAmount,
        reference: input.reference?.trim() || null,
        note: note || null,
        actorUserId: input.actorUserId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        metadata: input.metadata ?? undefined,
      },
    });

    return {
      event,
      paymentStatus: await syncOrderPaymentStatus(order.id, tx),
      replayed: false,
    };
  };

  if (client) return run(client);
  return prisma.$transaction(run, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}

/**
 * Recomputes an order's payment status from its events and writes it back.
 *
 * The only place `Order.paymentStatus` is written by this module. Exported
 * because it is also the repair tool: run it and a status that had drifted
 * from the events becomes right again, the same way
 * `reconcileWalletBalance` repairs a cached balance.
 */
export async function syncOrderPaymentStatus(
  orderId: string,
  client?: PrismaTransactionClient,
): Promise<PaymentStatus> {
  const db = client ?? prisma;

  const [order, events] = await Promise.all([
    db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { totalCentavos: true },
    }),
    db.paymentEvent.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      select: { type: true, amountCentavos: true },
    }),
  ]);

  const status = derivePaymentStatus(events, order.totalCentavos);
  await db.order.update({ where: { id: orderId }, data: { paymentStatus: status } });
  return status;
}

/**
 * What we are holding for this order that is not ours.
 *
 * The signed sum of its payment events: money in, less money already sent
 * back. On a cancelled order this is the refund owed; on a completed one it is
 * the takings.
 *
 * Deliberately NOT scoped by the order's payment method, because an order can
 * involve two instruments — credits covering part of a total and a transfer
 * covering the rest — and the rule about where a refund goes is per PORTION,
 * not per order. The credits half is answered by the credits ledger's own
 * `ORDER_PAYMENT` rows; this answers the cash half. That distinction is why
 * there is no single `assertRefundMayTouchCredits(order.paymentMethod)` guard
 * here: it would have read the order's headline method and refused to return
 * credits that were genuinely spent on a part-transfer order. The invariant
 * that actually holds is enforced at both ends instead — `recordRefundToSource`
 * refuses a credits-only order, and the database refuses a credits refund on an
 * order that never spent credits.
 */
export async function heldForCustomerCentavos(
  orderId: string,
  client?: PrismaTransactionClient,
): Promise<number> {
  const db = client ?? prisma;
  const total = await db.paymentEvent.aggregate({
    where: { orderId },
    _sum: { amountCentavos: true },
  });
  return total._sum.amountCentavos ?? 0;
}

/** Every event on an order, oldest first. The history support reads. */
export async function paymentHistory(orderId: string): Promise<PaymentEvent[]> {
  return prisma.paymentEvent.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });
}
