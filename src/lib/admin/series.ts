import { OrderStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { startOfManilaDay } from '@/lib/admin/queries';
import { LANDED_STATUSES } from '@/lib/orders/transitions';

/**
 * Time series for the console's dashboard.
 *
 * Everything here is counted over MANILA DAYS, not UTC ones. A dashboard whose
 * "today" starts at 8am local is a dashboard that reports a quiet morning every
 * morning, and the operator reading it is in Manila.
 *
 * The queries read `Order` and nothing else. There is no aggregate table and no
 * cached rollup — at this size the honest count is cheap, and a rollup that
 * drifts is a number nobody can reconcile, which is the same rule the credits
 * ledger and the store ratings already follow.
 */

export interface DayPoint {
  /** Midnight Manila for this day, as an instant. */
  day: Date;
  /** Orders placed. */
  orders: number;
  /** Orders that reached a completed state. */
  completed: number;
  /** Gross on completed orders, centavos. Nothing is counted until it lands. */
  grossCentavos: number;
}

export interface DashboardSeries {
  days: DayPoint[];
  /** Totals over the whole window, so a caption never has to re-add the array. */
  totals: { orders: number; completed: number; grossCentavos: number };
  /** The same figures for the day in progress. */
  today: { orders: number; completed: number; grossCentavos: number };
  /** Yesterday, for a change figure. Null when the window is one day. */
  yesterday: { orders: number; completed: number; grossCentavos: number } | null;
}

/**
 * Orders and gross per day, over the last `days` Manila days including today.
 *
 * One query, bucketed in memory. The alternative — a `$queryRaw` with
 * `date_trunc` — has to name the Manila offset in SQL, and a timezone written
 * in two places is a timezone that will disagree with itself.
 */
export async function dashboardSeries(
  days = 30,
  now = new Date(),
): Promise<DashboardSeries> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const todayStart = startOfManilaDay(now);
  const from = new Date(todayStart.getTime() - (days - 1) * DAY_MS);

  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: from } },
    select: { createdAt: true, status: true, totalCentavos: true },
  });

  const landed = new Set<OrderStatus>(LANDED_STATUSES);

  const buckets = new Map<number, DayPoint>();
  for (let index = 0; index < days; index += 1) {
    const day = new Date(from.getTime() + index * DAY_MS);
    buckets.set(day.getTime(), { day, orders: 0, completed: 0, grossCentavos: 0 });
  }

  for (const order of orders) {
    const key = startOfManilaDay(order.createdAt).getTime();
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.orders += 1;
    if (landed.has(order.status)) {
      bucket.completed += 1;
      bucket.grossCentavos += order.totalCentavos;
    }
  }

  const points = [...buckets.values()];
  const totals = points.reduce(
    (sum, point) => ({
      orders: sum.orders + point.orders,
      completed: sum.completed + point.completed,
      grossCentavos: sum.grossCentavos + point.grossCentavos,
    }),
    { orders: 0, completed: 0, grossCentavos: 0 },
  );

  const last = points[points.length - 1]!;
  const previous = points.length > 1 ? points[points.length - 2]! : null;

  return {
    days: points,
    totals,
    today: { orders: last.orders, completed: last.completed, grossCentavos: last.grossCentavos },
    yesterday: previous
      ? {
          orders: previous.orders,
          completed: previous.completed,
          grossCentavos: previous.grossCentavos,
        }
      : null,
  };
}

/**
 * Change from one figure to another, as a percentage.
 *
 * Null when there is nothing to compare against. A dashboard that renders
 * "+100%" because yesterday was zero is telling an operator that something
 * doubled, which is not what happened — the honest answer is that there is no
 * comparison, and the caption says so.
 */
export function changePercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export interface RankedStore {
  id: string;
  name: string;
  logoUrl: string | null;
  orders: number;
  grossCentavos: number;
}

/**
 * The shops with the most completed orders in the window.
 *
 * `storeId` lives inside the vertical's details container rather than in a
 * column, so this groups in memory over the window's completed orders — see
 * `orders/details.ts`. It is bounded by the window, not by the table.
 */
export async function topStores(days = 30, limit = 5, now = new Date()): Promise<RankedStore[]> {
  const from = new Date(startOfManilaDay(now).getTime() - (days - 1) * 24 * 60 * 60 * 1000);

  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: from }, status: { in: [...LANDED_STATUSES] } },
    select: { details: true, totalCentavos: true },
  });

  const byStore = new Map<string, { orders: number; grossCentavos: number }>();
  for (const order of orders) {
    const details = order.details;
    if (details === null || typeof details !== 'object' || Array.isArray(details)) continue;
    const storeId = (details as Record<string, unknown>).storeId;
    if (typeof storeId !== 'string' || storeId === '') continue;
    const entry = byStore.get(storeId) ?? { orders: 0, grossCentavos: 0 };
    entry.orders += 1;
    entry.grossCentavos += order.totalCentavos;
    byStore.set(storeId, entry);
  }

  const ranked = [...byStore.entries()]
    .sort((a, b) => b[1].orders - a[1].orders || b[1].grossCentavos - a[1].grossCentavos)
    .slice(0, limit);

  if (ranked.length === 0) return [];

  const stores = await prisma.store.findMany({
    where: { id: { in: ranked.map(([id]) => id) } },
    select: { id: true, name: true, logoUrl: true },
  });
  const byId = new Map(stores.map((store) => [store.id, store]));

  return ranked.flatMap(([id, counts]) => {
    const store = byId.get(id);
    return store ? [{ ...store, ...counts }] : [];
  });
}

export interface CustomerMix {
  /** Accounts whose first completed order landed inside the window. */
  newCustomers: number;
  /** Accounts that have completed more than one order, ever. */
  returning: number;
  /** Every account, whether they have ordered or not. */
  registered: number;
  /** Completed orders per ordering customer, to one decimal. Null with none. */
  ordersPerCustomer: number | null;
}

export async function customerMix(days = 30, now = new Date()): Promise<CustomerMix> {
  const from = new Date(startOfManilaDay(now).getTime() - (days - 1) * 24 * 60 * 60 * 1000);

  const [completed, registered] = await Promise.all([
    prisma.order.findMany({
      where: { status: { in: [...LANDED_STATUSES] } },
      select: { customerId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.user.count(),
  ]);

  const firstOrderAt = new Map<string, Date>();
  const countByCustomer = new Map<string, number>();
  for (const order of completed) {
    if (!firstOrderAt.has(order.customerId)) {
      firstOrderAt.set(order.customerId, order.createdAt);
    }
    countByCustomer.set(order.customerId, (countByCustomer.get(order.customerId) ?? 0) + 1);
  }

  const newCustomers = [...firstOrderAt.values()].filter((at) => at >= from).length;
  const returning = [...countByCustomer.values()].filter((count) => count > 1).length;
  const ordering = countByCustomer.size;

  return {
    newCustomers,
    returning,
    registered,
    ordersPerCustomer:
      ordering === 0 ? null : Math.round((completed.length / ordering) * 10) / 10,
  };
}
