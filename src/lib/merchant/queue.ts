import { OrderStatus, type Order, type Service } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { allowedTransitions, isActorPermitted } from '@/lib/orders/state-machine';
import { OrderActor } from '@prisma/client';
import { clockFor, type QueueClock } from '@/lib/merchant/queue-clock';
import { platformAbsorbedCentavos } from '@/lib/settlement/policy';
import {
  REPORT_WINDOW_DAYS,
  SETTLED_STATUSES,
  reportWindowStart,
} from '@/lib/merchant/reporting';
import type { AppliedBenefitRow } from '@/lib/merchant/order-benefits';

/**
 * The merchant order queue.
 *
 * Which orders a merchant can act on, and how they group on screen, is derived
 * from the lifecycle map rather than listed here: a status belongs in the queue
 * if a MERCHANT is permitted to move the order out of it, or if the order is
 * waiting on a partner the merchant is holding food for. Adding a vertical with
 * a merchant leg puts it in this queue with no change to this file.
 */

/**
 * How the queue reads on screen.
 *
 * Three columns, in the order a kitchen actually works: what needs a decision,
 * what is cooking, what is waiting to be collected. The grouping is
 * presentation; the transitions available within each are the map's decision.
 */
export interface MerchantStage {
  key: 'needs-decision' | 'preparing' | 'awaiting-pickup';
  title: string;
  blurb: string;
  statuses: readonly OrderStatus[];
}

/*
 * `isUrgent` used to live here: a per-STAGE flag meaning "a customer is
 * waiting on a reply". It was read by the card to decide whether to warn, and
 * once the card reads the sweeper's real deadline per order it had no reader
 * left in the product — only a test asserting its shape. A flag nothing acts
 * on is data that can be wrong without anybody noticing, and this one was
 * coarser than the thing that replaced it: a stage cannot know that THIS
 * order has forty seconds left.
 */

export const MERCHANT_STAGES: readonly MerchantStage[] = [
  {
    key: 'needs-decision',
    title: 'New',
    blurb: 'Waiting for your answer.',
    statuses: [OrderStatus.PENDING_MERCHANT_ACCEPTANCE],
  },
  {
    key: 'preparing',
    title: 'Preparing',
    blurb: 'Accepted, still cooking.',
    statuses: [OrderStatus.MERCHANT_ACCEPTED, OrderStatus.PREPARING],
  },
  {
    key: 'awaiting-pickup',
    title: 'Waiting for a rider',
    blurb: 'Ready, not collected yet.',
    statuses: [
      OrderStatus.READY_FOR_PICKUP,
      OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      OrderStatus.RIDER_ASSIGNED,
      OrderStatus.RIDER_AT_PICKUP,
    ],
  },
];

/** Every status the live queue shows, derived from the stages above. */
export const QUEUE_STATUSES: readonly OrderStatus[] = MERCHANT_STAGES.flatMap(
  (stage) => [...stage.statuses],
);

export interface QueuedOrder {
  order: Order;
  service: Service;
  /** Transitions this merchant may perform right now, from the map. */
  merchantActions: OrderStatus[];
  /** How long the order has been waiting in its current status, seconds. */
  waitingSeconds: number;
  /**
   * The deadline the sweeper is running on it, or null when there is none.
   *
   * Resolved here rather than in the card, so the rule is applied once on the
   * server and the client renders what it is given.
   */
  clock: QueueClock | null;
}

export interface MerchantQueue {
  stages: { stage: MerchantStage; orders: QueuedOrder[] }[];
  totalLive: number;
}

/**
 * The live queue for a store.
 *
 * Orders are matched on the `storeId` inside their vertical-specific details,
 * which is where a FOOD order records its store. Filtering in the database
 * rather than in memory keeps a busy store's history out of the query.
 */
export async function loadMerchantQueue(storeId: string): Promise<MerchantQueue> {
  const orders = await prisma.order.findMany({
    where: {
      status: { in: [...QUEUE_STATUSES] },
      details: { path: ['storeId'], equals: storeId },
    },
    orderBy: { placedAt: 'asc' },
    include: { service: true, statusEvents: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  const now = Date.now();

  const queued: QueuedOrder[] = orders.map(({ service, statusEvents, ...order }) => {
    const enteredAt = statusEvents[0]?.createdAt ?? order.updatedAt;
    const waitingSeconds = Math.max(0, Math.round((now - enteredAt.getTime()) / 1000));
    return {
      order: order as Order,
      service,
      // The map decides what is offered, so a vertical whose lifecycle differs
      // gets the right buttons without this file knowing about it.
      merchantActions: allowedTransitions(order.serviceType, order.status).filter((to) =>
        isActorPermitted(order.serviceType, to, OrderActor.MERCHANT),
      ),
      waitingSeconds,
      clock: clockFor({
        serviceType: order.serviceType,
        status: order.status,
        waitingSeconds,
      }),
    };
  });

  return {
    stages: MERCHANT_STAGES.map((stage) => ({
      stage,
      orders: queued.filter((entry) => stage.statuses.includes(entry.order.status)),
    })),
    totalLive: queued.length,
  };
}

export interface HistoryRow {
  order: Order;
  service: Service;
  benefits: AppliedBenefitRow[];
}

export interface MerchantHistory {
  rows: HistoryRow[];
  windowDays: number;
  /** Finished orders in the window, whether or not they fit on the screen. */
  totalInWindow: number;
  /**
   * What TARA absorbed across the WHOLE window, from a separate aggregate.
   *
   * Not a sum of `rows`. Summing the rendered rows made the figure mean "the
   * most recent fifty orders" while reading as a period total, so it moved
   * whenever the cap did — and it could never agree with the Regulars tab,
   * which aggregates ninety days.
   */
  absorbedCentavos: number;
  /** How many orders in the window carried a discount. */
  discountedCount: number;
}

const HISTORY_ROW_LIMIT = 50;

/**
 * Recently finished orders, for the history screen.
 *
 * The applied-benefit rows come with them, plus the tier each one came from
 * where that tier still exists. It is one query rather than one per row, and
 * the join is what lets a finished order name the status that conferred a
 * benefit — the customer's tier itself is derived live and is NOT what an old
 * order should be described by.
 *
 * The window and the totals are the point of the second query. A row list is
 * capped so a busy shop's screen stays a screen; a total that is capped with
 * it is a total that means something else.
 */
export async function loadMerchantHistory(
  storeId: string,
  options: { limit?: number; windowDays?: number; now?: Date } = {},
): Promise<MerchantHistory> {
  const windowDays = options.windowDays ?? REPORT_WINDOW_DAYS;
  const shown = options.limit ?? HISTORY_ROW_LIMIT;
  const since = reportWindowStart(options.now ?? new Date(), windowDays);
  const inWindow = {
    details: { path: ['storeId'], equals: storeId },
    createdAt: { gte: since },
  } as const;

  const [rows, totalInWindow, settled] = await Promise.all([
    prisma.order.findMany({
      where: { ...inWindow, status: { notIn: [...QUEUE_STATUSES] } },
      orderBy: { createdAt: 'desc' },
      take: shown,
      include: {
        service: true,
        appliedBenefits: {
          orderBy: { createdAt: 'asc' },
          select: {
            source: true,
            displayLabel: true,
            amountCentavos: true,
            tierBenefit: { select: { tier: { select: { name: true } } } },
          },
        },
      },
    }),
    prisma.order.count({
      where: { ...inWindow, status: { notIn: [...QUEUE_STATUSES] } },
    }),
    /**
     * SETTLED orders only, which is `COMPLETED` alone.
     *
     * The total used to include cancelled and expired orders, and every one of
     * those had its discount counted as money TARA absorbed. Settlement
     * accrues in the completion transaction and nowhere else, so a cancelled
     * order cost TARA nothing — its refund went back to where the money came
     * from. Only the four discount columns are read, because
     * `platformAbsorbedCentavos` is what settlement itself was charged.
     */
    prisma.order.findMany({
      where: { ...inWindow, status: { in: [...SETTLED_STATUSES] } },
      select: {
        promoDiscountCentavos: true,
        subscriptionDiscountCentavos: true,
        loyaltyDiscountCentavos: true,
        walletCreditAppliedCentavos: true,
      },
    }),
  ]);

  const absorbedPerOrder = settled.map(platformAbsorbedCentavos);

  return {
    rows: rows.map(({ service, appliedBenefits, ...order }) => ({
      order: order as Order,
      service,
      benefits: appliedBenefits.map((row) => ({
        source: row.source,
        displayLabel: row.displayLabel,
        amountCentavos: row.amountCentavos,
        // Null once the tier is gone — its benefit rows cascade with it — and
        // the label and the source still survive on the order itself.
        tierName: row.tierBenefit?.tier.name ?? null,
      })),
    })),
    windowDays,
    totalInWindow,
    absorbedCentavos: absorbedPerOrder.reduce((sum, value) => sum + value, 0),
    discountedCount: absorbedPerOrder.filter((value) => value > 0).length,
  };
}

/** Today's counts, for the header. */
export async function loadMerchantSummary(storeId: string): Promise<{
  completedToday: number;
  cancelledToday: number;
  revenueTodayCentavos: number;
}> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const rows = await prisma.order.findMany({
    where: {
      createdAt: { gte: startOfDay },
      details: { path: ['storeId'], equals: storeId },
    },
    select: { status: true, subtotalCentavos: true },
  });

  const cancelled = rows.filter((row) => row.status.startsWith('CANCELLED')).length;
  const completed = rows.filter((row) => row.status === OrderStatus.COMPLETED);

  return {
    completedToday: completed.length,
    cancelledToday: cancelled,
    // The merchant's own take: what the food cost, not what the customer paid
    // including delivery and fees that are ours.
    revenueTodayCentavos: completed.reduce((total, row) => total + row.subtotalCentavos, 0),
  };
}
