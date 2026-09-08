import { SettlementEntryType, SettlementParty } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { partnerEarningsCentavos } from '@/lib/fleet/offer-policy';

/**
 * What a rider ACTUALLY earned on a job, as opposed to what today's rule says
 * they would.
 *
 * This exists because of the day surge moved from the platform to the rider.
 * That change is one line in `partnerEarningsCentavos` — and every screen
 * showing a rider their finished jobs was RECOMPUTING earnings from that
 * function, so the moment the rule changed, every job they had ever done
 * silently restated itself. A rider would open last Tuesday and see a figure
 * that was never accrued and never paid.
 *
 * Which is precisely the failure the settlement ledger was built to prevent —
 * an app promising one number and settling another — arriving from the
 * opposite direction. So: for a settled job the LEDGER is the truth, because it
 * holds what was accrued under the rule in force at the time. The rule is only
 * consulted for jobs that have not settled yet.
 *
 * The general form of the lesson: a derived money figure that is recomputed on
 * read is a figure that rewrites itself whenever the formula changes. Store it
 * when it is decided, or read it from where it was stored.
 */

/**
 * Accrued rider earnings per order, for orders that have settled.
 *
 * Only `ORDER_EARNINGS` rows: an adjustment belongs on a partner's statement,
 * not attributed to a job as though the job paid it.
 */
export async function accruedEarningsByOrder(
  fleetPartnerId: string,
  orderIds: readonly string[],
  client?: PrismaTransactionClient,
): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();
  const db = client ?? prisma;

  const rows = await db.settlementEntry.groupBy({
    by: ['orderId'],
    where: {
      party: SettlementParty.FLEET_PARTNER,
      fleetPartnerId,
      type: SettlementEntryType.ORDER_EARNINGS,
      orderId: { in: [...orderIds] },
    },
    _sum: { amountCentavos: true },
  });

  const accrued = new Map<string, number>();
  for (const row of rows) {
    if (row.orderId) accrued.set(row.orderId, row._sum.amountCentavos ?? 0);
  }
  return accrued;
}

/** The order fields the fallback needs. */
export interface EarningsFacts {
  id: string;
  deliveryFeeCentavos: number;
  surgeCentavos: number;
  tipCentavos: number;
}

/**
 * Ledger first, rule second.
 *
 * The fallback is not a formality: orders completed before the settlement
 * ledger existed have no rows, and those have to show something. It is safe
 * because no order in the database carries surge — so for every order that
 * predates the ledger, the new rule and the old one give the same answer. The
 * day that stops being true is the day this fallback starts lying, which is
 * why it is documented rather than quietly convenient.
 */
export function earningsFor(
  order: EarningsFacts,
  accrued: Map<string, number>,
): number {
  const settled = accrued.get(order.id);
  return settled ?? partnerEarningsCentavos(order);
}
