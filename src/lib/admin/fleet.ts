import {
  VerificationStatus,
  type FleetPartner,
  type ServiceKey,
  type User,
  type VehicleType,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isWaitingOnUs, queueRank } from '@/lib/fleet/verification-policy';

/**
 * The console's view of the fleet.
 *
 * The screen this feeds replaced `npm run fleet:approve`, which was the last
 * daily job in the whole application that could only be done over SSH. The
 * shape here follows from what that job actually is: somebody looking at a
 * queue of people waiting, deciding one service at a time, oldest first.
 *
 * Nothing here decides anything — reads only. The decisions live in
 * `fleet/verification.ts`, behind the console actions that record an audit row.
 */

export interface PendingApplication {
  partnerId: string;
  userId: string;
  name: string;
  phone: string;
  vehicleType: VehicleType;
  vehiclePlate: string | null;
  cityName: string | null;
  serviceType: ServiceKey;
  serviceName: string;
  documents: string[];
  waitingSince: Date;
  isSuspended: boolean;
}

/**
 * Everybody waiting on a decision, oldest first.
 *
 * One row per APPLICATION rather than per partner, because that is the unit of
 * the decision: a rider approved for food and waiting on passengers appears
 * once, for the thing that is still outstanding.
 */
export async function pendingApplications(): Promise<PendingApplication[]> {
  const rows = await prisma.fleetPartnerServiceVerification.findMany({
    where: { status: VerificationStatus.PENDING },
    include: {
      service: { select: { displayName: true } },
      fleetPartner: {
        include: {
          user: { select: { id: true, fullName: true, displayName: true, phone: true } },
          // The partner's home city is optional, and a rider with none is
          // still a rider — shown as a dash rather than dropped.
        },
      },
    },
  });

  const cityNames = await cityLookup(rows.map((row) => row.fleetPartner.homeCityId));

  return rows
    .map((row) => ({
      partnerId: row.fleetPartnerId,
      userId: row.fleetPartner.user.id,
      name:
        row.fleetPartner.user.fullName ??
        row.fleetPartner.user.displayName ??
        row.fleetPartner.user.phone,
      phone: row.fleetPartner.user.phone,
      vehicleType: row.fleetPartner.vehicleType,
      vehiclePlate: row.fleetPartner.vehiclePlate,
      cityName: row.fleetPartner.homeCityId
        ? cityNames.get(row.fleetPartner.homeCityId) ?? null
        : null,
      serviceType: row.serviceType,
      serviceName: row.service.displayName,
      documents: row.submittedDocuments,
      waitingSince: row.submittedAt ?? row.createdAt,
      isSuspended: row.fleetPartner.isSuspended,
    }))
    .sort((left, right) => left.waitingSince.getTime() - right.waitingSince.getTime());
}

export interface ConsolePartnerRow {
  partnerId: string;
  userId: string;
  name: string;
  phone: string;
  vehicleType: VehicleType;
  cityName: string | null;
  isOnline: boolean;
  isSuspended: boolean;
  enabledServices: ServiceKey[];
  pending: number;
  completedOrderCount: number;
  ratingAvg: number;
  ratingCount: number;
  /** The oldest thing this partner is waiting on us for, if anything. */
  waitingSince: Date | null;
}

/**
 * Every partner, with the ones waiting on us at the top.
 *
 * Same ordering rule as the support queue, and for the same reason: a list
 * sorted newest-first is how somebody who applied on Monday is still waiting
 * on Friday.
 */
export async function listConsolePartners(): Promise<ConsolePartnerRow[]> {
  const partners = await prisma.fleetPartner.findMany({
    include: {
      user: { select: { id: true, fullName: true, displayName: true, phone: true } },
      serviceVerifications: {
        select: { status: true, submittedAt: true, createdAt: true },
      },
    },
  });

  const cityNames = await cityLookup(partners.map((partner) => partner.homeCityId));

  return partners
    .map((partner) => {
      const waiting = partner.serviceVerifications.filter((row) => isWaitingOnUs(row.status));
      const oldest = waiting
        .map((row) => row.submittedAt ?? row.createdAt)
        .sort((left, right) => left.getTime() - right.getTime())[0];
      return {
        partnerId: partner.id,
        userId: partner.user.id,
        name: partner.user.fullName ?? partner.user.displayName ?? partner.user.phone,
        phone: partner.user.phone,
        vehicleType: partner.vehicleType,
        cityName: partner.homeCityId ? cityNames.get(partner.homeCityId) ?? null : null,
        isOnline: partner.isOnline,
        isSuspended: partner.isSuspended,
        enabledServices: partner.enabledServices,
        pending: waiting.length,
        completedOrderCount: partner.completedOrderCount,
        ratingAvg: partner.ratingAvg,
        ratingCount: partner.ratingCount,
        waitingSince: oldest ?? null,
      };
    })
    .sort((left, right) => {
      if ((left.waitingSince === null) !== (right.waitingSince === null)) {
        return left.waitingSince === null ? 1 : -1;
      }
      if (left.waitingSince && right.waitingSince) {
        return left.waitingSince.getTime() - right.waitingSince.getTime();
      }
      return left.name.localeCompare(right.name);
    });
}

export interface ConsolePartnerDetail {
  partner: FleetPartner;
  user: Pick<User, 'id' | 'fullName' | 'displayName' | 'phone' | 'isBlocked' | 'createdAt'>;
  cityName: string | null;
  applications: {
    id: string;
    serviceType: ServiceKey;
    serviceName: string;
    isActiveService: boolean;
    status: VerificationStatus;
    documents: string[];
    submittedAt: Date | null;
    createdAt: Date;
    decidedAt: Date | null;
    decidedBy: string | null;
    rejectionReason: string | null;
    notes: string | null;
  }[];
}

/** One partner, with every application in the order a queue should be worked. */
export async function consolePartnerDetail(
  partnerId: string,
): Promise<ConsolePartnerDetail | null> {
  const partner = await prisma.fleetPartner.findUnique({
    where: { id: partnerId },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          displayName: true,
          phone: true,
          isBlocked: true,
          createdAt: true,
        },
      },
      serviceVerifications: {
        include: {
          service: { select: { displayName: true, isActive: true } },
          decidedBy: { select: { fullName: true, displayName: true, phone: true } },
        },
      },
    },
  });
  if (!partner) return null;

  const cityNames = await cityLookup([partner.homeCityId]);

  const applications = partner.serviceVerifications
    .map((row) => ({
      id: row.id,
      serviceType: row.serviceType,
      serviceName: row.service.displayName,
      isActiveService: row.service.isActive,
      status: row.status,
      documents: row.submittedDocuments,
      submittedAt: row.submittedAt,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      decidedBy: row.decidedBy
        ? row.decidedBy.fullName ?? row.decidedBy.displayName ?? row.decidedBy.phone
        : null,
      rejectionReason: row.rejectionReason,
      notes: row.notes,
    }))
    .sort((left, right) => queueRank(left) - queueRank(right));

  return {
    partner,
    user: partner.user,
    cityName: partner.homeCityId ? cityNames.get(partner.homeCityId) ?? null : null,
    applications,
  };
}

/** How many people are waiting on a decision. For the console's front page. */
export function countPendingApplications(): Promise<number> {
  return prisma.fleetPartnerServiceVerification.count({
    where: { status: VerificationStatus.PENDING },
  });
}

/** One query for the city names several of the above need. */
async function cityLookup(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const cities = await prisma.city.findMany({
    where: { id: { in: wanted } },
    select: { id: true, name: true },
  });
  return new Map(cities.map((city) => [city.id, city.name]));
}
