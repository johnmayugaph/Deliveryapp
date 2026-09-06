import {
  OrderActor,
  OrderStatus,
  PaymentStatus,
  type Order,
  type ServiceKey,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { transitionOrder } from '@/lib/orders/state-machine';
import { ALL_STATUS_TIMEOUTS } from '@/lib/orders/transitions';
import { grantCredit, refundToCredits } from '@/lib/wallet/ledger';

/**
 * Scheduled order maintenance.
 *
 * Two jobs, both vertical-agnostic:
 *   - `expireStaleOrders()` acts on the timeout policies declared in
 *     `ORDER_LIFECYCLES`. It reads the flattened `ALL_STATUS_TIMEOUTS` and does
 *     not know that FOOD waits on a merchant or that PABILI waits on a budget
 *     approval — those are entries in the map.
 *   - `refundOrderCredits()` returns credits spent on an order that will never
 *     be delivered. Credits go back to CREDITS, never to cash: there is no rail
 *     out, by design.
 *
 * Run from cron: `npm run jobs:orders`.
 */

export interface ExpiredOrderResult {
  orderId: string;
  orderNumber: string;
  serviceType: ServiceKey;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  refundedCentavos: number;
}

/**
 * Returns credits spent on an order, if any, when that order ends without
 * being delivered.
 *
 * Idempotent: the ledger's `idempotencyKey` is derived from the order id, so a
 * job that runs twice refunds once. It reads the actual `ORDER_PAYMENT` rows
 * rather than trusting `Order.walletCreditAppliedCentavos`, because the ledger
 * is the truth about what was taken.
 */
export async function refundOrderCredits(
  input: { orderId: string; reason: string },
  client?: PrismaTransactionClient,
): Promise<number> {
  const db = client ?? prisma;

  const order = await db.order.findUniqueOrThrow({
    where: { id: input.orderId },
    select: { id: true, orderNumber: true, customerId: true },
  });

  const payments = await db.walletTransaction.aggregate({
    where: { relatedOrderId: order.id, type: 'ORDER_PAYMENT' },
    _sum: { amountCentavos: true },
  });
  // ORDER_PAYMENT rows are negative; the refund is their magnitude.
  const spentCentavos = Math.abs(payments._sum.amountCentavos ?? 0);
  if (spentCentavos === 0) {
    return 0;
  }

  const alreadyRefunded = await db.walletTransaction.aggregate({
    where: { relatedOrderId: order.id, type: 'REFUND' },
    _sum: { amountCentavos: true },
  });
  const outstanding = spentCentavos - (alreadyRefunded._sum.amountCentavos ?? 0);
  if (outstanding <= 0) {
    return 0;
  }

  await refundToCredits(
    {
      userId: order.customerId,
      orderId: order.id,
      amountCentavos: outstanding,
      description: `Refund · order ${order.orderNumber} · ${input.reason}`,
      idempotencyKey: `order-refund:${order.id}`,
    },
    client,
  );

  await db.order.update({
    where: { id: order.id },
    data: { paymentStatus: PaymentStatus.REFUNDED },
  });

  return outstanding;
}

/**
 * Moves orders that have sat too long in a waiting state, per the timeout
 * policies, and refunds any credits they consumed.
 *
 * Each order is handled in its own transaction: one order failing to expire
 * must not block the rest of the sweep.
 */
export async function expireStaleOrders(
  options: { now?: Date; limitPerPolicy?: number } = {},
): Promise<ExpiredOrderResult[]> {
  const now = options.now ?? new Date();
  const limit = options.limitPerPolicy ?? 200;
  const results: ExpiredOrderResult[] = [];

  for (const policy of ALL_STATUS_TIMEOUTS) {
    const cutoff = new Date(now.getTime() - policy.afterSeconds * 1_000);

    // `updatedAt` is a CONSERVATIVE filter, not the exact moment the order
    // entered this state: any later write moves it forward, never back. So an
    // order can be swept slightly late but never early, which is the right way
    // round for a policy that cancels people's orders. The exact wait is read
    // from the status-event trail below, for the audit record.
    const candidates = await prisma.order.findMany({
      where: {
        serviceType: policy.serviceType,
        status: policy.status,
        updatedAt: { lt: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      include: {
        statusEvents: {
          where: { toStatus: policy.status },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    for (const order of candidates) {
      try {
        const refundedCentavos = await prisma.$transaction(async (tx) => {
          await transitionOrder(
            {
              orderId: order.id,
              to: policy.to,
              actor: OrderActor.SYSTEM,
              reason: policy.reason,
              metadata: {
                expiredFrom: policy.status,
                timeoutSeconds: policy.afterSeconds,
                waitedSeconds: Math.round(
                  (now.getTime() - (order.statusEvents[0]?.createdAt ?? order.updatedAt).getTime()) /
                    1_000,
                ),
              },
            },
            tx,
          );

          return refundOrderCredits({ orderId: order.id, reason: policy.reason }, tx);
        });

        results.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          serviceType: order.serviceType,
          fromStatus: policy.status,
          toStatus: policy.to,
          refundedCentavos,
        });
      } catch (error) {
        // Another actor probably moved the order between our read and the
        // transition — the merchant accepted just in time. That is the guard
        // working, not a failure to report.
        console.warn(
          `expireStaleOrders: skipped ${order.orderNumber}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  return results;
}

/**
 * Completes a delivered order and grants any credit-back its subscription
 * benefits accrued.
 *
 * Credit-back is not a discount: the customer paid full price at checkout, and
 * the credits arrive here, on completion, through the ledger. Idempotent by
 * order id, so a retry cannot double-grant.
 */
export async function completeOrder(input: {
  orderId: string;
  actor?: OrderActor;
  actorUserId?: string;
}): Promise<{ order: Order; creditBackCentavos: number }> {
  return prisma.$transaction(async (tx) => {
    const order = await transitionOrder(
      {
        orderId: input.orderId,
        to: OrderStatus.COMPLETED,
        actor: input.actor ?? OrderActor.SYSTEM,
        actorUserId: input.actorUserId,
      },
      tx,
    );

    const accrued = await tx.orderAppliedBenefit.aggregate({
      where: { orderId: order.id },
      _sum: { creditBackCentavos: true },
    });
    const creditBackCentavos = accrued._sum.creditBackCentavos ?? 0;

    if (creditBackCentavos > 0) {
      await grantCredit(
        {
          userId: order.customerId,
          type: 'PROMO_CREDIT',
          amountCentavos: creditBackCentavos,
          description: `Credits back · order ${order.orderNumber}`,
          idempotencyKey: `credit-back:${order.id}`,
        },
        tx,
      );
    }

    // A completed cash order has been paid by definition.
    if (order.paymentStatus === PaymentStatus.PENDING) {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentStatus: PaymentStatus.PAID },
      });
    }

    return { order, creditBackCentavos };
  });
}
