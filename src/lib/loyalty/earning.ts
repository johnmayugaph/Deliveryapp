import { LoyaltyEntryType, type Order } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { ensureLoyaltyAccount, recordLoyaltyEntry } from '@/lib/loyalty/ledger';
import {
  getProgramme,
  getTiersWithBenefits,
  pointsEarnedInWindow,
} from '@/lib/loyalty/programme';
import { expiryFor, pointsForOrder, tierFor } from '@/lib/loyalty/policy';
import { pointsNeverExpireAt } from '@/lib/loyalty/tier-benefits';

/**
 * Earning points, at the moment an order completes.
 *
 * Completion, not placement — the same rule as the referral reward and the
 * settlement accrual, and for the same reason: an order that was cancelled or
 * failed was not a thing anybody should be rewarded for. It runs inside the
 * completion transaction so that a completed order and the points it earned
 * either both happen or neither does.
 *
 * The tier is read at the moment of earning and never afterwards. A customer
 * who reaches Tapat today does not retrospectively earn more on last month's
 * orders — which is the same lesson `settlement/earnings.ts` learned the hard
 * way about rider pay: a derived money figure recomputed on read is a figure
 * that rewrites itself whenever the formula changes.
 *
 * The same rule now decides EXPIRY. A tier conferring POINTS_NEVER_EXPIRE
 * stamps the points earned while the customer is at that tier with no expiry
 * date, and those points keep it forever: dropping back to Suki next year does
 * not retroactively put a clock on points already earned. Which is the honest
 * reading of the promise — "points you earn while you are at this tier never
 * expire" is what the screen says, and it is a promise about the earning
 * rather than about the customer.
 */

export interface EarningOutcome {
  pointsEarned: number;
  /** The tier that was in force, for the description and the notification. */
  tierName: string | null;
  /** True when this call is what wrote the row. */
  earned: boolean;
  /** True when the tier's perk meant these points were stamped with no expiry. */
  neverExpires: boolean;
}

const NOTHING: EarningOutcome = {
  pointsEarned: 0,
  tierName: null,
  earned: false,
  neverExpires: false,
};

export async function earnPointsForOrder(
  order: Pick<Order, 'id' | 'customerId' | 'subtotalCentavos' | 'orderNumber'>,
  client?: PrismaTransactionClient,
  now: Date = new Date(),
): Promise<EarningOutcome> {
  const db = client ?? prisma;

  const programme = await getProgramme(db);
  // The common case while the programme is off: one indexed read and out,
  // which is the right cost to pay on every completion.
  if (!programme.isActive) return NOTHING;

  const [tiers, earnedInWindow] = await Promise.all([
    getTiersWithBenefits(db),
    pointsEarnedInWindow(order.customerId, programme, now, db),
  ]);
  const { current } = tierFor(tiers, earnedInWindow);

  const points = pointsForOrder(programme, order, current);
  if (points <= 0) return NOTHING;

  // The tier's own benefits, from the row `tierFor` picked out of this list.
  const tierBenefits =
    current === null
      ? []
      : tiers.find((tier) => tier.id === current.id)?.benefits ?? [];
  const neverExpires = pointsNeverExpireAt(tierBenefits);

  const account = await ensureLoyaltyAccount(order.customerId, db);

  const result = await recordLoyaltyEntry(
    {
      accountId: account.id,
      type: LoyaltyEntryType.EARNED,
      points,
      description: `Points from order ${order.orderNumber}`,
      relatedOrderId: order.id,
      // One earning per order, ever. A retried completion re-enters here and
      // gets the existing row back rather than a second one.
      idempotencyKey: `loyalty-earn:${order.id}`,
      // Null is what "never" already means in this column, so the perk needs
      // no new representation — see `LoyaltyEntry.expiresAt`.
      expiresAt: neverExpires ? null : expiryFor(programme, now),
    },
    db,
  );

  return {
    pointsEarned: result.entry.points,
    tierName: current?.name ?? null,
    neverExpires,
    // Reported by the ledger, not guessed from a timestamp: a replay landing
    // in the same second would otherwise read as a fresh earning, and the
    // caller uses this to decide whether to tell the customer.
    earned: !result.replayed,
  };
}
