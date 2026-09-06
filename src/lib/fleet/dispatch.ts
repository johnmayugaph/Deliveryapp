import {
  Prisma,
  ServiceKey,
  VerificationStatus,
  type FleetPartner,
} from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { getService } from '@/lib/services/registry';
import { boundingBox, haversineMeters } from '@/lib/geo';

/**
 * Dispatch candidate selection.
 *
 * The only change from the previous rider-only design: the candidate list is
 * filtered by `FleetPartner.enabledServices`, so a partner approved for food
 * is not offered a passenger trip. Everything else about ranking is unchanged —
 * distance first, then rating, then acceptance rate, then how busy they are.
 */

export interface DispatchQuery {
  serviceType: ServiceKey;
  pickupLatitude: number;
  pickupLongitude: number;
  /** Search radius, metres. */
  radiusMeters?: number;
  cityId?: string;
  limit?: number;
  /** Partners who already declined this order. */
  excludePartnerIds?: readonly string[];
}

export interface RankedCandidate {
  partner: FleetPartner;
  distanceMeters: number;
  score: number;
}

const DEFAULT_RADIUS_METERS = 5_000;
const DEFAULT_LIMIT = 20;
/**
 * Ranking. Unchanged from the rider-only version: proximity dominates, rating
 * and reliability break ties.
 */
function scoreCandidate(partner: FleetPartner, distanceMeters: number): number {
  const proximityScore = Math.max(0, 1 - distanceMeters / DEFAULT_RADIUS_METERS) * 60;
  const ratingScore = (partner.ratingCount > 0 ? partner.ratingAvg / 5 : 0.6) * 25;
  const reliabilityScore = partner.acceptanceRate * 15;
  return proximityScore + ratingScore + reliabilityScore;
}

/**
 * Candidates for an order, nearest and best first.
 *
 * `requiresRider` is read from the Service registry: a vertical that needs no
 * partner returns an empty list rather than being special-cased by the caller.
 */
export async function findDispatchCandidates(
  query: DispatchQuery,
  client?: PrismaTransactionClient,
): Promise<RankedCandidate[]> {
  const service = await getService(query.serviceType);
  if (!service.requiresRider) {
    return [];
  }

  const db = client ?? prisma;
  const radius = query.radiusMeters ?? DEFAULT_RADIUS_METERS;

  // Coarse bounding box in SQL, exact distance in memory.
  const { latDelta, lngDelta } = boundingBox(
    query.pickupLatitude,
    query.pickupLongitude,
    radius,
  );

  const where: Prisma.FleetPartnerWhereInput = {
    isOnline: true,
    isSuspended: false,
    // The service-neutral fleet filter: approved for THIS vertical.
    enabledServices: { has: query.serviceType },
    currentLatitude: {
      gte: query.pickupLatitude - latDelta,
      lte: query.pickupLatitude + latDelta,
    },
    currentLongitude: {
      gte: query.pickupLongitude - lngDelta,
      lte: query.pickupLongitude + lngDelta,
    },
    ...(query.cityId ? { homeCityId: query.cityId } : {}),
    ...(query.excludePartnerIds?.length
      ? { id: { notIn: [...query.excludePartnerIds] } }
      : {}),
  };

  const partners = await db.fleetPartner.findMany({
    where,
    take: (query.limit ?? DEFAULT_LIMIT) * 4,
  });

  return partners
    .flatMap((partner) => {
      if (partner.currentLatitude === null || partner.currentLongitude === null) {
        return [];
      }
      const distanceMeters = haversineMeters(
        query.pickupLatitude,
        query.pickupLongitude,
        partner.currentLatitude,
        partner.currentLongitude,
      );
      if (distanceMeters > radius) {
        return [];
      }
      return [{ partner, distanceMeters, score: scoreCandidate(partner, distanceMeters) }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, query.limit ?? DEFAULT_LIMIT);
}

/**
 * Recomputes `enabledServices` from the partner's per-service verifications.
 *
 * `enabledServices` is a denormalised read model — dispatch hits it on every
 * candidate query — and this is the only function that writes it. Approval for
 * one service never leaks into another: a row must be APPROVED, and unexpired,
 * for its service to appear.
 */
export async function syncEnabledServices(
  fleetPartnerId: string,
  client?: PrismaTransactionClient,
): Promise<ServiceKey[]> {
  const db = client ?? prisma;
  const now = new Date();

  const verifications = await db.fleetPartnerServiceVerification.findMany({
    where: { fleetPartnerId, status: VerificationStatus.APPROVED },
  });

  const enabledServices = verifications
    .filter((row) => row.expiresAt === null || row.expiresAt > now)
    .map((row) => row.serviceType);

  await db.fleetPartner.update({
    where: { id: fleetPartnerId },
    data: { enabledServices },
  });

  return enabledServices;
}

/**
 * Whether a partner may take work in a vertical. Cheap enough to call on every
 * offer acceptance, and the honest answer rather than a UI assumption.
 */
export async function isApprovedForService(
  fleetPartnerId: string,
  serviceType: ServiceKey,
): Promise<boolean> {
  const partner = await prisma.fleetPartner.findUnique({
    where: { id: fleetPartnerId },
    select: { enabledServices: true, isSuspended: true },
  });
  if (!partner || partner.isSuspended) {
    return false;
  }
  return partner.enabledServices.includes(serviceType);
}
