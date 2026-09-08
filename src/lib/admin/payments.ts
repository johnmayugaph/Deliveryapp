import {
  OrderStatus,
  PaymentEventType,
  PaymentStatus,
  type PaymentMethod,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isTerminal } from '@/lib/orders/state-machine';

/**
 * The console's view of money.
 *
 * Two queues, and they are two different jobs. One is "somebody says they have
 * paid and is waiting on us to look" — a customer standing still until a human
 * acts. The other is "we are holding money for an order that is not going to
 * happen" — nobody blocked, but the longer it sits the worse it looks.
 *
 * Reads only. The decisions live in `payments/manual.ts`, behind the console
 * actions that demand a reason and write an audit row.
 */

export interface PaymentToCheck {
  orderId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  totalCentavos: number;
  method: PaymentMethod;
  /** The newest reference the customer gave us. What to look for. */
  reference: string | null;
  /** Every reference they have offered, newest first. */
  allReferences: string[];
  claimedAt: Date;
  /** How long the customer has been waiting on a human. */
  waitingSeconds: number;
  storeName: string | null;
}

/**
 * Payments claimed and not yet checked, longest wait first.
 *
 * Ordered by the wait rather than by size, because the queue is a queue of
 * PEOPLE. Sorting by amount would be optimising our exposure at the cost of
 * whoever has been staring at a spinner the longest.
 */
export async function paymentsToCheck(now = new Date()): Promise<PaymentToCheck[]> {
  const orders = await prisma.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      // CLAIMED: the customer has given us a reference and nobody has
      // checked it. AUTHORIZED means money arrived but fell short, which is a
      // different job — that order is waiting on the CUSTOMER, not on us.
      paymentStatus: PaymentStatus.CLAIMED,
    },
    select: {
      id: true,
      orderNumber: true,
      totalCentavos: true,
      paymentMethod: true,
      details: true,
      customer: { select: { fullName: true, displayName: true, phone: true } },
      paymentEvents: {
        where: { type: PaymentEventType.CHARGE_SUBMITTED },
        orderBy: { createdAt: 'desc' },
        select: { reference: true, createdAt: true },
      },
    },
  });

  return orders
    .map((order) => {
      const claims = order.paymentEvents;
      const newest = claims[0];
      // A claim is what puts an order in this queue, so this is defensive
      // rather than expected: the derived status cannot be CLAIMED without a
      // submitted reference.
      const claimedAt = newest?.createdAt ?? now;

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName:
          order.customer.displayName ?? order.customer.fullName ?? 'Customer',
        customerPhone: order.customer.phone,
        totalCentavos: order.totalCentavos,
        method: order.paymentMethod,
        reference: newest?.reference ?? null,
        // Every attempt, because the useful one is often not the newest: a
        // customer who mistypes and corrects has given us two numbers and
        // either might be the one in the account.
        allReferences: claims
          .map((claim) => claim.reference)
          .filter((reference): reference is string => reference !== null),
        claimedAt,
        waitingSeconds: Math.max(
          0,
          Math.round((now.getTime() - claimedAt.getTime()) / 1_000),
        ),
        storeName: storeNameOf(order.details),
      };
    })
    .sort((left, right) => right.waitingSeconds - left.waitingSeconds);
}

export interface RefundOwed {
  orderId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  amountCentavos: number;
  method: PaymentMethod;
  endedAt: Date;
  status: OrderStatus;
}

/**
 * Money we are holding on orders that ended, largest first.
 *
 * The opposite ordering to the queue above, and for the opposite reason:
 * nobody is blocked waiting for us here, so the useful order is by exposure —
 * the ₱1,200 refund is the one that turns into a complaint.
 *
 * Computed from the payment ledger rather than from a flag, so it is
 * self-correcting: the moment somebody records the refund, the row leaves this
 * list because the sum went to zero. There is no "refunded" boolean to forget
 * to set.
 */
export async function refundsOwed(): Promise<RefundOwed[]> {
  // Grouped in the database rather than fetched and summed here: this is the
  // one query in the console that touches every payment event ever written,
  // and it grows with takings rather than with anything bounded.
  const held = await prisma.paymentEvent.groupBy({
    by: ['orderId'],
    _sum: { amountCentavos: true },
    having: { amountCentavos: { _sum: { gt: 0 } } },
  });
  if (held.length === 0) return [];

  const orders = await prisma.order.findMany({
    where: { id: { in: held.map((row) => row.orderId) } },
    select: {
      id: true,
      orderNumber: true,
      serviceType: true,
      status: true,
      paymentMethod: true,
      cancelledAt: true,
      completedAt: true,
      updatedAt: true,
      customer: { select: { fullName: true, displayName: true, phone: true } },
    },
  });

  const amounts = new Map(held.map((row) => [row.orderId, row._sum.amountCentavos ?? 0]));

  return orders
    // Only orders that are over. Money held on a live order is money we are
    // owed, and listing it as a refund would have somebody sending it back
    // while the food is still in the kitchen.
    .filter((order) => isTerminal(order.serviceType, order.status))
    // A completed order's takings are ours. Only an order that ended WITHOUT
    // being delivered owes anything back.
    .filter((order) => order.status !== OrderStatus.COMPLETED)
    .map((order) => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName:
        order.customer.displayName ?? order.customer.fullName ?? 'Customer',
      customerPhone: order.customer.phone,
      amountCentavos: amounts.get(order.id) ?? 0,
      method: order.paymentMethod,
      endedAt: order.cancelledAt ?? order.completedAt ?? order.updatedAt,
      status: order.status,
    }))
    .sort((left, right) => right.amountCentavos - left.amountCentavos);
}

/** How many people are waiting on a human. For the console's badge. */
export async function countPaymentsToCheck(): Promise<number> {
  return prisma.order.count({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentStatus: PaymentStatus.CLAIMED,
    },
  });
}

/** The shop's name from the order's payload, read without assuming a shape. */
function storeNameOf(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null;
  const name = (details as { storeName?: unknown }).storeName;
  return typeof name === 'string' ? name : null;
}
