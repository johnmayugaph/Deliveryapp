import { cache } from 'react';
import {
  DispatchOfferStatus,
  OrderStatus,
  VerificationStatus,
  type FleetPartner,
  type Order,
  type Service,
  type ServiceKey,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireCurrentUser } from '@/lib/auth/session';
import { getLifecycle } from '@/lib/orders/transitions';
import { cashToCollectCentavos } from '@/lib/payments/policy';
import { partnerEarningsCentavos } from '@/lib/fleet/offer-policy';
import { ACTIVE_JOB_STATUSES } from '@/lib/fleet/job-policy';

/**
 * The fleet partner's own view of themselves.
 *
 * A partner may hold approvals for several verticals, so nothing here is
 * food-shaped: the active job, the offers board and the earnings all read the
 * order's `serviceType` and its lifecycle rather than assuming a kitchen.
 */

export class NotAFleetPartnerError extends Error {
  constructor() {
    super('This account is not a fleet partner');
    this.name = 'NotAFleetPartnerError';
  }
}

/** The signed-in person's fleet record, or null if they have not applied. */
export const getFleetPartner = cache(async (): Promise<FleetPartner | null> => {
  const user = await requireCurrentUser();
  return prisma.fleetPartner.findUnique({ where: { userId: user.id } });
});

export async function requireFleetPartner(): Promise<FleetPartner> {
  const partner = await getFleetPartner();
  if (!partner) {
    throw new NotAFleetPartnerError();
  }
  return partner;
}

/* `ACTIVE_JOB_STATUSES` moved to `fleet/job-policy.ts`, which is pure. This
 * module reaches for the session, so a client component importing the list
 * from here dragged `next/headers` into the browser bundle — which is exactly
 * how the customer's tracking map first failed. Re-exported so the callers
 * that already had it are unaffected. */
export { ACTIVE_JOB_STATUSES };

export interface ActiveJob {
  order: Order;
  service: Service;
  pickup: { label: string | null; line1: string; barangay: string | null; cityName: string; contactPhone: string | null; latitude: number; longitude: number };
  dropoff: { label: string | null; line1: string; barangay: string | null; cityName: string; deliveryNotes: string | null; contactName: string | null; contactPhone: string | null; latitude: number; longitude: number };
  /** Transitions this partner may perform now, from the lifecycle map. */
  nextActions: OrderStatus[];
  earningsCentavos: number;
  /**
   * What to collect at the door, in cash. Zero when it is already paid.
   *
   * Computed here rather than on the screen so there is one answer to the
   * question, and it is the same answer everywhere. Getting this wrong costs
   * real money in one direction and a customer's trust in the other: a rider
   * who does not ask hands over food for free, and a rider who asks on a
   * prepaid order is asking somebody to pay twice.
   */
  cashToCollectCentavos: number;
  /** Item lines, when the vertical has any. Read defensively. */
  itemSummary: string | null;
}

/**
 * The partner's current job, if any.
 *
 * One at a time deliberately: batching two deliveries is a real feature with
 * real routing behind it, and pretending to support it by showing two active
 * jobs would just get food delivered cold.
 */
export async function getActiveJob(fleetPartnerId: string): Promise<ActiveJob | null> {
  const row = await prisma.order.findFirst({
    where: { assignedRiderId: fleetPartnerId, status: { in: [...ACTIVE_JOB_STATUSES] } },
    orderBy: { updatedAt: 'desc' },
    include: { service: true, addresses: true },
  });
  if (!row) {
    return null;
  }

  const pickup = row.addresses.find((address) => address.role === 'PICKUP');
  const dropoff = row.addresses.find((address) => address.role === 'DROPOFF');
  if (!pickup || !dropoff) {
    return null;
  }

  const { service, addresses: _addresses, ...order } = row;
  const lifecycle = getLifecycle(order.serviceType);

  return {
    order: order as Order,
    service,
    pickup: {
      label: pickup.label,
      line1: pickup.line1,
      barangay: pickup.barangay,
      cityName: pickup.cityName,
      contactPhone: pickup.contactPhone,
      latitude: pickup.latitude,
      longitude: pickup.longitude,
    },
    dropoff: {
      label: dropoff.label,
      line1: dropoff.line1,
      barangay: dropoff.barangay,
      cityName: dropoff.cityName,
      deliveryNotes: dropoff.deliveryNotes,
      contactName: dropoff.contactName,
      contactPhone: dropoff.contactPhone,
      latitude: dropoff.latitude,
      longitude: dropoff.longitude,
    },
    // The map decides what comes next, so a parcel or a ride shows the right
    // buttons without this function knowing either exists.
    nextActions: (lifecycle.transitions[order.status] ?? []).filter(
      (to) => (lifecycle.permittedActors[to] ?? []).includes('FLEET_PARTNER'),
    ),
    earningsCentavos: partnerEarningsCentavos(order),
    cashToCollectCentavos: cashToCollectCentavos(
      order.paymentMethod,
      order.paymentStatus,
      order.totalCentavos,
    ),
    itemSummary: summariseItems(order.details),
  };
}

/** Item count for the partner's screen, read without assuming a shape. */
function summariseItems(details: unknown): string | null {
  if (details === null || typeof details !== 'object') return null;
  const items = (details as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const count = items.reduce<number>((total, item) => {
    const quantity = (item as { quantity?: unknown }).quantity;
    return total + (typeof quantity === 'number' ? quantity : 1);
  }, 0);
  return `${count} item${count === 1 ? '' : 's'}`;
}

export interface PartnerVerification {
  serviceType: ServiceKey;
  serviceName: string;
  status: VerificationStatus;
  isActiveService: boolean;
  rejectionReason: string | null;
}

/** Per-service approval state, for the partner's own profile. */
export async function listVerifications(
  fleetPartnerId: string,
): Promise<PartnerVerification[]> {
  const rows = await prisma.fleetPartnerServiceVerification.findMany({
    where: { fleetPartnerId },
    include: { service: true },
    orderBy: { service: { sortOrder: 'asc' } },
  });

  return rows.map((row) => ({
    serviceType: row.serviceType,
    serviceName: row.service.displayName,
    status: row.status,
    isActiveService: row.service.isActive,
    rejectionReason: row.rejectionReason,
  }));
}

export interface PartnerEarnings {
  todayCentavos: number;
  todayJobs: number;
  weekCentavos: number;
  weekJobs: number;
  lifetimeJobs: number;
  ratingAvg: number;
  ratingCount: number;
}

/**
 * What the partner has earned.
 *
 * Counted on COMPLETED orders only — a cancelled job pays nothing, and showing
 * it as earned would be a promise we break at payout.
 */
export async function getPartnerEarnings(partner: FleetPartner): Promise<PartnerEarnings> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - 6);

  const rows = await prisma.order.findMany({
    where: {
      assignedRiderId: partner.id,
      status: OrderStatus.COMPLETED,
      completedAt: { gte: startOfWeek },
    },
    select: { completedAt: true, deliveryFeeCentavos: true, tipCentavos: true },
  });

  const today = rows.filter(
    (row) => row.completedAt !== null && row.completedAt >= startOfDay,
  );
  const sum = (list: typeof rows) =>
    list.reduce((total, row) => total + partnerEarningsCentavos(row), 0);

  return {
    todayCentavos: sum(today),
    todayJobs: today.length,
    weekCentavos: sum(rows),
    weekJobs: rows.length,
    lifetimeJobs: partner.completedOrderCount,
    ratingAvg: partner.ratingAvg,
    ratingCount: partner.ratingCount,
  };
}

/** Recent finished jobs, for the partner's history. */
export async function listPartnerHistory(
  fleetPartnerId: string,
  limit = 30,
): Promise<{ order: Order; service: Service; earningsCentavos: number }[]> {
  const rows = await prisma.order.findMany({
    where: {
      assignedRiderId: fleetPartnerId,
      status: { notIn: [...ACTIVE_JOB_STATUSES] },
    },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    include: { service: true },
  });

  return rows.map(({ service, ...order }) => ({
    order: order as Order,
    service,
    earningsCentavos:
      order.status === OrderStatus.COMPLETED ? partnerEarningsCentavos(order) : 0,
  }));
}

/** Offers the partner has answered, for context on their acceptance rate. */
export async function getOfferTallies(fleetPartnerId: string) {
  const grouped = await prisma.dispatchOffer.groupBy({
    by: ['status'],
    where: { fleetPartnerId },
    _count: { _all: true },
  });
  const count = (status: DispatchOfferStatus) =>
    grouped.find((row) => row.status === status)?._count._all ?? 0;

  return {
    accepted: count(DispatchOfferStatus.ACCEPTED),
    declined: count(DispatchOfferStatus.DECLINED),
    expired: count(DispatchOfferStatus.EXPIRED),
    superseded: count(DispatchOfferStatus.SUPERSEDED),
  };
}
