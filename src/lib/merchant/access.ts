import { cache } from 'react';
import { StoreRole, type Store, type StoreMember, type User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireCurrentUser } from '@/lib/auth/session';
import { roleSatisfies } from '@/lib/merchant/roles';

/**
 * Store access.
 *
 * `User.roles` carrying MERCHANT_OWNER says what kind of person someone is.
 * This module answers the question every merchant action actually has to ask:
 * may THIS person touch THIS store? The answer comes from `StoreMember` and
 * nowhere else.
 *
 * The rule that matters: authorisation is resolved from the session and the
 * ORDER's own store, never from a store id the client supplied alongside it.
 * Otherwise a merchant could accept a neighbour's order by editing a form field.
 */

export class NoStoreAccessError extends Error {
  constructor(readonly storeId: string) {
    super(`You do not have access to store "${storeId}"`);
    this.name = 'NoStoreAccessError';
  }
}

export class InsufficientStoreRoleError extends Error {
  constructor(readonly required: StoreRole, readonly actual: StoreRole) {
    super(`This needs ${required} access; you have ${actual}`);
    this.name = 'InsufficientStoreRoleError';
  }
}

/**
 * The ladder lives in `./roles.ts`, which imports nothing but the enum, and is
 * re-exported here so every existing caller is unaffected. The split exists
 * because the tab bar is a client component and this module is not safe to
 * import from one.
 */
export { roleSatisfies };

export interface StoreAccess {
  user: User;
  store: Store;
  role: StoreRole;
}

/**
 * Stores the signed-in person may work, newest membership last.
 *
 * Cached per request: the merchant layout, the store picker and the page body
 * all want this and none should each cost a query.
 */
export const getAccessibleStores = cache(
  async (): Promise<(StoreMember & { store: Store })[]> => {
    const user = await requireCurrentUser();
    return prisma.storeMember.findMany({
      where: { userId: user.id },
      include: { store: true },
      orderBy: [{ role: 'asc' }, { store: { name: 'asc' } }],
    });
  },
);

/**
 * Asserts the signed-in person may work this store, optionally at a minimum
 * role. Throws rather than returning null, so a caller cannot forget to check.
 */
export async function requireStoreAccess(
  storeId: string,
  minimumRole: StoreRole = StoreRole.STAFF,
): Promise<StoreAccess> {
  const user = await requireCurrentUser();

  const membership = await prisma.storeMember.findUnique({
    where: { storeId_userId: { storeId, userId: user.id } },
    include: { store: true },
  });

  if (!membership) {
    // Deliberately the same error whether the store does not exist or is simply
    // not theirs: a merchant should not be able to probe for other stores' ids.
    throw new NoStoreAccessError(storeId);
  }
  if (!roleSatisfies(membership.role, minimumRole)) {
    throw new InsufficientStoreRoleError(minimumRole, membership.role);
  }

  return { user, store: membership.store, role: membership.role };
}

/**
 * Asserts access to the store an ORDER belongs to.
 *
 * The store is read from the order's own `details`, not from anything the
 * caller passed. This is the function that stops one merchant accepting
 * another's orders.
 */
export async function requireOrderStoreAccess(
  orderId: string,
  minimumRole: StoreRole = StoreRole.STAFF,
): Promise<StoreAccess & { orderId: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, details: true },
  });
  if (!order) {
    throw new NoStoreAccessError('(unknown order)');
  }

  const storeId = storeIdFromDetails(order.details);
  if (!storeId) {
    // An order in a vertical with no merchant leg has no store to authorise
    // against, so there is nothing a merchant could legitimately do to it.
    throw new NoStoreAccessError('(order has no store)');
  }

  const access = await requireStoreAccess(storeId, minimumRole);
  return { ...access, orderId: order.id };
}

/**
 * Reads `storeId` out of the vertical-specific details container.
 *
 * Defensive on purpose: not every vertical has a store, and this must not
 * assume the shape of one it has never seen.
 */
export function storeIdFromDetails(details: unknown): string | null {
  if (details === null || typeof details !== 'object') {
    return null;
  }
  const storeId = (details as Record<string, unknown>).storeId;
  return typeof storeId === 'string' && storeId.length > 0 ? storeId : null;
}

/** Whether the signed-in person has any store at all, for the profile link. */
export async function hasAnyStoreAccess(userId: string): Promise<boolean> {
  const count = await prisma.storeMember.count({ where: { userId } });
  return count > 0;
}

/** Role labels used to live here; they moved to `staff-policy.ts`, which is
 *  pure. This module reaches for the session, and a client component importing
 *  a label from here would pull `next/headers` into the browser bundle. */
