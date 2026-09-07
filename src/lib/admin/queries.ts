import {
  NotificationChannel,
  NotificationDeliveryStatus,
  OrderStatus,
  SubscriptionStatus,
  VerificationStatus,
  WalletTransactionType,
  type ServiceKey,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getAllServices } from '@/lib/services/registry';
import { ALL_IN_PROGRESS_STATUSES } from '@/lib/orders/transitions';
import { storeIdFromDetails } from '@/lib/merchant/access';

/**
 * What the console reads.
 *
 * Every one of these is registry-driven or enum-driven. There is no list of
 * services in this file and no branch on which service an order belongs to:
 * the orders view groups by whatever `Service` rows exist, so launching a
 * sixth vertical adds a column to the console without anybody editing it.
 *
 * Aggregates are done in the database rather than by loading rows and counting
 * in TypeScript. An admin overview that pulls every order to count them works
 * beautifully on seed data and falls over on the first busy Friday.
 */

/**
 * Orders still in flight — the ones somebody is waiting on right now.
 *
 * Taken from the union of every service's lifecycle rather than from "every
 * status that is not terminal", so a status no lifecycle can actually reach
 * does not show up as a filter nobody can trigger.
 */
const LIVE_ORDER_STATUSES: OrderStatus[] = [...ALL_IN_PROGRESS_STATUSES];

/** Every way an order can end without being delivered. */
const CANCELLED_STATUSES: OrderStatus[] = [
  OrderStatus.CANCELLED_BY_CUSTOMER,
  OrderStatus.CANCELLED_BY_MERCHANT,
  OrderStatus.CANCELLED_BY_RIDER,
  OrderStatus.CANCELLED_BY_SYSTEM,
];

export interface ServiceHealthRow {
  key: ServiceKey;
  displayName: string;
  isActive: boolean;
  isComingSoon: boolean;
  cityCount: number;
  liveOrders: number;
  ordersToday: number;
  completedToday: number;
  cancelledToday: number;
  grossTodayCentavos: number;
}

/**
 * One row per service, whether or not it has ever taken an order.
 *
 * Including the unlaunched ones is the point: "Mart, active: no, orders: 0" is
 * the line that makes the four unbuilt verticals visible instead of absent,
 * and the registry is the only thing that knows they exist.
 */
export async function serviceHealth(now = new Date()): Promise<ServiceHealthRow[]> {
  const since = startOfManilaDay(now);
  const services = await getAllServices();

  const [live, today, completed, cancelled, gross] = await Promise.all([
    prisma.order.groupBy({
      by: ['serviceType'],
      where: { status: { in: LIVE_ORDER_STATUSES } },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ['serviceType'],
      where: { createdAt: { gte: since }, status: { not: OrderStatus.DRAFT } },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ['serviceType'],
      where: { createdAt: { gte: since }, status: OrderStatus.DELIVERED },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ['serviceType'],
      where: {
        createdAt: { gte: since },
        status: { in: CANCELLED_STATUSES },
      },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ['serviceType'],
      where: { createdAt: { gte: since }, status: OrderStatus.DELIVERED },
      _sum: { totalCentavos: true },
    }),
  ]);

  const countBy = (
    rows: { serviceType: ServiceKey; _count: { _all?: number | undefined } | true | undefined }[],
    key: ServiceKey,
  ) => {
    const row = rows.find((candidate) => candidate.serviceType === key);
    if (!row || row._count === undefined || row._count === true) return 0;
    return row._count._all ?? 0;
  };

  return services.map((service) => ({
    key: service.key,
    displayName: service.displayName,
    isActive: service.isActive,
    isComingSoon: service.isComingSoon,
    cityCount: service.availableCityIds.length,
    liveOrders: countBy(live, service.key),
    ordersToday: countBy(today, service.key),
    completedToday: countBy(completed, service.key),
    cancelledToday: countBy(cancelled, service.key),
    grossTodayCentavos:
      gross.find((row) => row.serviceType === service.key)?._sum.totalCentavos ?? 0,
  }));
}

/** Midnight in Manila for the day containing `at`. */
export function startOfManilaDay(at: Date): Date {
  const PH_OFFSET_MS = 8 * 60 * 60 * 1000;
  const shifted = new Date(at.getTime() + PH_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - PH_OFFSET_MS);
}

export interface PlatformSummary {
  people: number;
  onboarded: number;
  blocked: number;
  storesOpen: number;
  fleetApproved: number;
  fleetOnline: number;
  liveSubscriptions: number;
  /** Outstanding credits — a liability, and the number worth watching. */
  creditFloatCentavos: number;
  creditsGrantedTodayCentavos: number;
  pushDevices: number;
}

export async function platformSummary(now = new Date()): Promise<PlatformSummary> {
  const since = startOfManilaDay(now);

  const [
    people,
    onboarded,
    blocked,
    storesOpen,
    fleetApproved,
    fleetOnline,
    liveSubscriptions,
    float,
    grantedToday,
    pushDevices,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { onboardedAt: { not: null } } }),
    prisma.user.count({ where: { isBlocked: true } }),
    prisma.store.count({ where: { isOpen: true } }),
    // Approval is held PER SERVICE, so "approved" means approved for at least
    // one. A single boolean here would have to pick a service, and picking one
    // is the branch this codebase does not allow.
    prisma.fleetPartner.count({
      where: { serviceVerifications: { some: { status: VerificationStatus.APPROVED } } },
    }),
    prisma.fleetPartner.count({
      where: {
        isOnline: true,
        isSuspended: false,
        serviceVerifications: { some: { status: VerificationStatus.APPROVED } },
      },
    }),
    prisma.userSubscription.count({
      where: { status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] } },
    }),
    // The float is the sum of derived balances, not a replay of the ledger:
    // the balance column is maintained by the one function that may write it,
    // and reconciliation is a separate concern with its own routine.
    prisma.wallet.aggregate({ _sum: { balanceCentavos: true } }),
    prisma.walletTransaction.aggregate({
      where: {
        createdAt: { gte: since },
        type: { in: [WalletTransactionType.PROMO_CREDIT, WalletTransactionType.REFERRAL_BONUS] },
      },
      _sum: { amountCentavos: true },
    }),
    prisma.webPushSubscription.count({ where: { expiredAt: null } }),
  ]);

  return {
    people,
    onboarded,
    blocked,
    storesOpen,
    fleetApproved,
    fleetOnline,
    liveSubscriptions,
    creditFloatCentavos: float._sum.balanceCentavos ?? 0,
    creditsGrantedTodayCentavos: grantedToday._sum.amountCentavos ?? 0,
    pushDevices,
  };
}

export interface OrderFilter {
  serviceType?: ServiceKey;
  status?: OrderStatus;
  /** Only orders still in flight. */
  liveOnly?: boolean;
  /** A phone number or an order number. */
  search?: string;
  limit?: number;
}

/**
 * Orders across every vertical, newest first.
 *
 * One query with a filter object rather than a function per service, because
 * "show me everything happening right now" is the question an operator
 * actually has and a per-service screen cannot answer it.
 */
export async function listOrders(filter: OrderFilter = {}) {
  const search = filter.search?.trim();

  return prisma.order.findMany({
    where: {
      status: filter.status
        ? filter.status
        : filter.liveOnly
          ? { in: LIVE_ORDER_STATUSES }
          : { not: OrderStatus.DRAFT },
      ...(filter.serviceType ? { serviceType: filter.serviceType } : {}),
      ...(search
        ? {
            OR: [
              { orderNumber: { contains: search, mode: 'insensitive' as const } },
              { customer: { phone: { contains: search } } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: filter.limit ?? 60,
    select: {
      id: true,
      orderNumber: true,
      serviceType: true,
      status: true,
      totalCentavos: true,
      walletCreditAppliedCentavos: true,
      createdAt: true,
      // The store lives in the vertical-specific `details` container, not in
      // a column: not every service has one. Resolved after the fact by
      // `attachStores`, in one query for the whole page.
      details: true,
      customer: { select: { id: true, fullName: true, displayName: true, phone: true } },
      assignedRider: {
        select: { id: true, user: { select: { fullName: true, phone: true } } },
      },
    },
  });
}

/**
 * Names the stores for a page of orders, in one query.
 *
 * Kept separate from `listOrders` because the store id is inside a JSON
 * column, so Prisma cannot join it. Doing it here rather than per row is the
 * difference between one query and sixty.
 */
export async function attachStores<T extends { details: unknown }>(
  orders: T[],
): Promise<(T & { storeName: string | null })[]> {
  const ids = [
    ...new Set(orders.map((order) => storeIdFromDetails(order.details)).filter(
      (id): id is string => id !== null,
    )),
  ];
  if (ids.length === 0) {
    return orders.map((order) => ({ ...order, storeName: null }));
  }

  const stores = await prisma.store.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const nameById = new Map(stores.map((store) => [store.id, store.name] as const));

  return orders.map((order) => {
    const id = storeIdFromDetails(order.details);
    return { ...order, storeName: id ? nameById.get(id) ?? null : null };
  });
}

/** Everything about one order, for the screen support actually opens. */
export async function orderDetail(orderNumber: string) {
  return prisma.order.findUnique({
    where: { orderNumber },
    include: {
      customer: {
        select: { id: true, fullName: true, displayName: true, phone: true, isBlocked: true },
      },
      assignedRider: {
        select: { id: true, user: { select: { id: true, fullName: true, phone: true } } },
      },
      // Addresses are SNAPSHOTS on the order, not references to the book: what
      // was typed at checkout is what the rider was given, whatever the person
      // has edited since.
      addresses: { orderBy: { role: 'asc' } },
      statusEvents: {
        orderBy: { createdAt: 'asc' },
        include: { actorUser: { select: { fullName: true, phone: true } } },
      },
      walletTransactions: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          amountCentavos: true,
          description: true,
          createdAt: true,
        },
      },
      notifications: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kind: true,
          title: true,
          createdAt: true,
          deliveries: {
            select: { channel: true, status: true, attempts: true, lastError: true },
          },
        },
      },
      dispatchOffers: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          createdAt: true,
          expiresAt: true,
          respondedAt: true,
          fleetPartner: { select: { user: { select: { fullName: true, phone: true } } } },
        },
      },
    },
  });
}

/**
 * People, by phone or name.
 *
 * Deliberately requires a search term: a console that lists every account by
 * default invites browsing, and browsing other people's records is the thing
 * an audit trail exists to discourage.
 */
export async function searchUsers(term: string, limit = 30) {
  const search = term.trim();
  if (search.length < 3) return [];

  return prisma.user.findMany({
    where: {
      OR: [
        { phone: { contains: search } },
        { fullName: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      phone: true,
      fullName: true,
      displayName: true,
      roles: true,
      isBlocked: true,
      createdAt: true,
      onboardedAt: true,
      _count: { select: { orders: true } },
    },
  });
}

/** One person, everything the console may show about them. */
export async function userDetail(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      wallet: {
        include: {
          transactions: {
            orderBy: { createdAt: 'desc' },
            take: 40,
            include: {
              adminUser: { select: { fullName: true, phone: true } },
            },
          },
        },
      },
      orders: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          orderNumber: true,
          serviceType: true,
          status: true,
          totalCentavos: true,
          createdAt: true,
        },
      },
      subscriptions: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { plan: { select: { name: true } } },
      },
      pushSubscriptions: {
        orderBy: { lastSeenAt: 'desc' },
        select: { id: true, userAgent: true, lastSeenAt: true, expiredAt: true, failureCount: true },
      },
      notificationPreferences: true,
      fleetPartner: {
        select: {
          id: true,
          isOnline: true,
          isSuspended: true,
          vehicleType: true,
          serviceVerifications: {
            select: { serviceType: true, status: true },
          },
        },
      },
      storeMemberships: { include: { store: { select: { name: true, slug: true } } } },
      _count: { select: { sessions: true, supportTickets: true } },
    },
  });
}

export interface DeliveryHealth {
  byChannel: {
    channel: NotificationChannel;
    pending: number;
    sent: number;
    failed: number;
    skipped: number;
  }[];
  /** The rows an operator can actually do something about. */
  recentFailures: Awaited<ReturnType<typeof recentDeliveryFailures>>;
  /** Subscriptions the push services have told us are dead. */
  expiredPushDevices: number;
}

export async function recentDeliveryFailures(limit = 25) {
  return prisma.notificationDelivery.findMany({
    where: { status: NotificationDeliveryStatus.FAILED },
    orderBy: { nextAttemptAt: 'desc' },
    take: limit,
    select: {
      id: true,
      channel: true,
      attempts: true,
      lastError: true,
      nextAttemptAt: true,
      notification: {
        select: {
          kind: true,
          title: true,
          createdAt: true,
          user: { select: { id: true, phone: true, fullName: true } },
        },
      },
    },
  });
}

export async function deliveryHealth(): Promise<DeliveryHealth> {
  const [grouped, recentFailures, expiredPushDevices] = await Promise.all([
    prisma.notificationDelivery.groupBy({
      by: ['channel', 'status'],
      _count: { _all: true },
    }),
    recentDeliveryFailures(),
    prisma.webPushSubscription.count({ where: { expiredAt: { not: null } } }),
  ]);

  const at = (channel: NotificationChannel, status: NotificationDeliveryStatus) =>
    grouped.find((row) => row.channel === channel && row.status === status)?._count._all ?? 0;

  return {
    // Keyed off the enum, so a fourth channel appears here without an edit.
    byChannel: Object.values(NotificationChannel).map((channel) => ({
      channel,
      pending: at(channel, NotificationDeliveryStatus.PENDING),
      sent: at(channel, NotificationDeliveryStatus.SENT),
      failed: at(channel, NotificationDeliveryStatus.FAILED),
      skipped: at(channel, NotificationDeliveryStatus.SKIPPED),
    })),
    recentFailures,
    expiredPushDevices,
  };
}

/** Cities, for the launch switches. */
export async function listCities() {
  return prisma.city.findMany({
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, province: true, isActive: true },
  });
}
