import { OrderStatus, type Order, type Service } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { allowedTransitions, isActorPermitted } from '@/lib/orders/state-machine';
import { OrderActor } from '@prisma/client';

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
  /** Orders here are the ones a customer is actively waiting on a reply for. */
  isUrgent: boolean;
}

export const MERCHANT_STAGES: readonly MerchantStage[] = [
  {
    key: 'needs-decision',
    title: 'Bago',
    blurb: 'Naghihintay ng sagot mo.',
    statuses: [OrderStatus.PENDING_MERCHANT_ACCEPTANCE],
    isUrgent: true,
  },
  {
    key: 'preparing',
    title: 'Inihahanda',
    blurb: 'Tinanggap na, ginagawa pa.',
    statuses: [OrderStatus.MERCHANT_ACCEPTED, OrderStatus.PREPARING],
    isUrgent: false,
  },
  {
    key: 'awaiting-pickup',
    title: 'Hinihintay ang rider',
    blurb: 'Handa na, hindi pa nakuha.',
    statuses: [
      OrderStatus.READY_FOR_PICKUP,
      OrderStatus.AWAITING_RIDER_ASSIGNMENT,
      OrderStatus.RIDER_ASSIGNED,
      OrderStatus.RIDER_AT_PICKUP,
    ],
    isUrgent: false,
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
    return {
      order: order as Order,
      service,
      // The map decides what is offered, so a vertical whose lifecycle differs
      // gets the right buttons without this file knowing about it.
      merchantActions: allowedTransitions(order.serviceType, order.status).filter((to) =>
        isActorPermitted(order.serviceType, to, OrderActor.MERCHANT),
      ),
      waitingSeconds: Math.max(0, Math.round((now - enteredAt.getTime()) / 1000)),
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

/** Recently finished orders, for the history screen. */
export async function loadMerchantHistory(
  storeId: string,
  options: { limit?: number } = {},
): Promise<{ order: Order; service: Service }[]> {
  const rows = await prisma.order.findMany({
    where: {
      status: { notIn: [...QUEUE_STATUSES] },
      details: { path: ['storeId'], equals: storeId },
    },
    orderBy: { createdAt: 'desc' },
    take: options.limit ?? 50,
    include: { service: true },
  });
  return rows.map(({ service, ...order }) => ({ order: order as Order, service }));
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
