import { SettlementEntryType, type Order } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { partnerEarningsCentavos } from '@/lib/fleet/offer-policy';
import { collectorFor, splitOrderValue, type OrderSplit } from '@/lib/settlement/policy';
import { recordSettlementEntry } from '@/lib/settlement/ledger';

/**
 * Turning a completed order into what people are owed.
 *
 * Runs inside the completion transaction. An order that completed and no
 * accrual is a shop that cooked food nobody recorded owing it for, and the
 * only way to find those later is to trawl orders against ledger rows — so it
 * either happens with the completion or not at all.
 *
 * Nothing accrues on a cancelled order: nobody delivered anything, and the
 * customer's money is handled by `settleCancelledOrder`. If a rider did
 * collect on something that then failed, that is what an ADJUSTMENT with a
 * reason is for — a case no rule anticipated, recorded by a person.
 */

/** What accrual wrote, for the caller's return value and for tests. */
export interface AccrualResult {
  split: OrderSplit;
  storeEntryWritten: boolean;
  riderEntryWritten: boolean;
  cashDebitWritten: boolean;
  /**
   * The shop this order was for, already resolved.
   *
   * Returned so a caller does not have to reach into `details` and repeat
   * `storeIdOf` — which the store-referral hook would otherwise do, giving two
   * places an opinion about where a vertical keeps its shop id.
   */
  storeId: string | null;
}

/** The store this order was for, read without assuming a vertical's shape. */
function storeIdOf(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null;
  const id = (details as { storeId?: unknown }).storeId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Accrues settlement for one completed order.
 *
 * Reads the commission from the STORE rather than from the order, and that is
 * a deliberate limitation worth naming: re-negotiating a shop's rate changes
 * what future orders accrue and leaves settled ones alone, which is right —
 * but an order completed a week late accrues at today's rate rather than the
 * rate on the day it was placed. Snapshotting the rate onto the order at
 * checkout would fix it. Not done yet, because the rate is zero everywhere
 * until somebody negotiates one, and a snapshot column that is always 0 is a
 * migration nobody can check.
 */
export async function accrueOrderSettlement(
  order: Pick<
    Order,
    | 'id'
    | 'orderNumber'
    | 'details'
    | 'assignedRiderId'
    | 'paymentMethod'
    | 'subtotalCentavos'
    | 'deliveryFeeCentavos'
    | 'serviceFeeCentavos'
    | 'smallOrderFeeCentavos'
    | 'surgeCentavos'
    | 'tipCentavos'
    | 'promoDiscountCentavos'
    | 'subscriptionDiscountCentavos'
    | 'walletCreditAppliedCentavos'
    | 'totalCentavos'
  >,
  client?: PrismaTransactionClient,
): Promise<AccrualResult> {
  const db = client ?? prisma;

  const storeId = storeIdOf(order.details);
  const store = storeId
    ? await db.store.findUnique({
        where: { id: storeId },
        select: { id: true, name: true, commissionBasisPoints: true },
      })
    : null;

  // The rider's share comes from the same function the fleet screens use to
  // tell a partner what they earn. Two functions computing that number is how
  // the app promises one figure and settles another.
  const riderCentavos = order.assignedRiderId
    ? partnerEarningsCentavos(order)
    : 0;

  const split = splitOrderValue({
    order,
    riderCentavos,
    commissionBasisPoints: store?.commissionBasisPoints ?? 0,
    discountedCentavos:
      order.promoDiscountCentavos +
      order.subscriptionDiscountCentavos +
      order.walletCreditAppliedCentavos,
  });

  let storeEntryWritten = false;
  if (store && split.storeCentavos > 0) {
    const { replayed } = await recordSettlementEntry(
      {
        ref: { party: 'STORE', storeId: store.id },
        type: SettlementEntryType.ORDER_EARNINGS,
        amountCentavos: split.storeCentavos,
        orderId: order.id,
        description: `Order ${order.orderNumber}`,
        idempotencyKey: `settle-store:${order.id}`,
        metadata: {
          subtotalCentavos: order.subtotalCentavos,
          commissionBasisPoints: store.commissionBasisPoints,
          commissionCentavos: order.subtotalCentavos - split.storeCentavos,
        },
      },
      db,
    );
    storeEntryWritten = !replayed;
  }

  let riderEntryWritten = false;
  let cashDebitWritten = false;
  if (order.assignedRiderId) {
    if (split.riderCentavos > 0) {
      const { replayed } = await recordSettlementEntry(
        {
          ref: { party: 'FLEET_PARTNER', fleetPartnerId: order.assignedRiderId },
          type: SettlementEntryType.ORDER_EARNINGS,
          amountCentavos: split.riderCentavos,
          orderId: order.id,
          description: `Order ${order.orderNumber}`,
          idempotencyKey: `settle-rider:${order.id}`,
          metadata: {
            deliveryFeeCentavos: order.deliveryFeeCentavos,
            tipCentavos: order.tipCentavos,
          },
        },
        db,
      );
      riderEntryWritten = !replayed;
    }

    // The half that makes this a ledger rather than a list of earnings. On a
    // cash order the rider took the WHOLE total at the door — the shop's money
    // and ours along with their own fee — so their balance goes negative and
    // they owe us the difference. That number is the float the business has to
    // manage, and until now nothing in the app knew it.
    if (collectorFor(order.paymentMethod) === 'RIDER' && order.totalCentavos > 0) {
      const { replayed } = await recordSettlementEntry(
        {
          ref: { party: 'FLEET_PARTNER', fleetPartnerId: order.assignedRiderId },
          type: SettlementEntryType.CASH_COLLECTED,
          amountCentavos: order.totalCentavos,
          orderId: order.id,
          description: `Cash collected · order ${order.orderNumber}`,
          idempotencyKey: `settle-cash:${order.id}`,
        },
        db,
      );
      cashDebitWritten = !replayed;
    }
  }

  return {
    split,
    storeEntryWritten,
    riderEntryWritten,
    cashDebitWritten,
    storeId,
  };
}
