import type { Address, FulfilmentAddressRole, Prisma } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';

/**
 * The shared address book.
 *
 * One book per person, used by every vertical. An address saved while ordering
 * food is immediately available as a parcel pickup — that is the whole reason
 * these are not per-service tables.
 */

export interface AddressBookQuery {
  userId: string;
  /** Only addresses usable as an origin. */
  pickupCapableOnly?: boolean;
  limit?: number;
}

/**
 * The address book, ordered by real behaviour: most-recently-used first, then
 * most-used. Creation date is a poor proxy for what someone wants to pick.
 */
export async function listAddressBook(query: AddressBookQuery): Promise<Address[]> {
  return prisma.address.findMany({
    where: {
      userId: query.userId,
      archivedAt: null,
      ...(query.pickupCapableOnly ? { isPickupCapable: true } : {}),
    },
    orderBy: [
      { isDefault: 'desc' },
      { lastUsedAt: { sort: 'desc', nulls: 'last' } },
      { usageCount: 'desc' },
      { createdAt: 'desc' },
    ],
    ...(query.limit ? { take: query.limit } : {}),
  });
}

/**
 * Records that an address was actually used. Called once per order placement,
 * per role, so `usageCount` reflects orders rather than screen visits.
 */
export async function bumpAddressUsage(
  addressId: string,
  client?: PrismaTransactionClient,
): Promise<void> {
  const db = client ?? prisma;
  await db.address.update({
    where: { id: addressId },
    data: {
      usageCount: { increment: 1 },
      lastUsedAt: new Date(),
    },
  });
}

/**
 * Copies a book entry into the immutable snapshot an order carries. The
 * snapshot is deliberately denormalised: an order must stay readable years
 * later even if the source address is edited or deleted.
 */
export function toOrderAddressSnapshot(
  address: Address & { city: { name: string } },
  role: FulfilmentAddressRole,
): Prisma.OrderAddressCreateWithoutOrderInput {
  return {
    role,
    sourceAddressId: address.id,
    label: address.label,
    line1: address.line1,
    line2: address.line2,
    barangay: address.barangay,
    cityId: address.cityId,
    cityName: address.city.name,
    province: address.province,
    postalCode: address.postalCode,
    landmark: address.landmark,
    deliveryNotes: address.deliveryNotes,
    latitude: address.latitude,
    longitude: address.longitude,
    contactName: address.contactName,
    contactPhone: address.contactPhone,
  };
}

/** Single-line rendering, used by the location header and the order list. */
export function formatAddressLine(address: {
  line1: string;
  barangay?: string | null;
  cityName?: string | null;
  city?: { name: string } | null;
}): string {
  const cityName = address.cityName ?? address.city?.name ?? null;
  return [address.line1, address.barangay, cityName].filter(Boolean).join(', ');
}
