import { StoreRole, type ServiceKey, type Store, type User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { inviteIsLive } from '@/lib/merchant/staff-policy';

/**
 * The console's view of partner stores.
 *
 * This exists because of a gap that made the shop-side staff screen unusable
 * for the case it was built for: a NEW partner. There was no way to create a
 * store outside the seed, so onboarding one meant writing rows by hand — and
 * once you are in the database writing a `Store`, adding its owner is one more
 * INSERT, which is exactly the workflow the invite screen was meant to end.
 *
 * So the console can create a store and name its first owner. Everything after
 * that — the menu, the prep time, the rest of the staff — belongs to the shop.
 */

export interface ConsoleStoreRow {
  id: string;
  name: string;
  slug: string;
  cityName: string;
  isVisible: boolean;
  isOpen: boolean;
  serviceKeys: ServiceKey[];
  menuItems: number;
  members: number;
  owners: number;
  pendingInvites: number;
  /** The one number that says whether this store can actually take an order. */
  readyForCustomers: boolean;
}

/**
 * Every store, whether or not customers can see it.
 *
 * Ordered with the not-yet-live ones first: a store that has been created and
 * left half-finished is the thing somebody needs to be reminded of, and one
 * that is running needs no attention.
 */
export async function listConsoleStores(
  now: Date = new Date(),
): Promise<ConsoleStoreRow[]> {
  const stores = await prisma.store.findMany({
    include: {
      city: { select: { name: true } },
      _count: { select: { menuItems: true, members: true } },
      members: { select: { role: true } },
      invites: {
        select: { acceptedAt: true, revokedAt: true, expiresAt: true },
      },
    },
    orderBy: { name: 'asc' },
  });

  return stores
    .map((store) => {
      const owners = store.members.filter((m) => m.role === StoreRole.OWNER).length;
      const menuItems = store._count.menuItems;
      return {
        id: store.id,
        name: store.name,
        slug: store.slug,
        cityName: store.city.name,
        isVisible: store.isVisible,
        isOpen: store.isOpen,
        serviceKeys: store.serviceKeys,
        menuItems,
        members: store._count.members,
        owners,
        pendingInvites: store.invites.filter((invite) => inviteIsLive(invite, now))
          .length,
        // All three, because any one missing means a customer either cannot
        // find it or finds an empty shop.
        readyForCustomers: store.isVisible && menuItems > 0 && owners > 0,
      };
    })
    .sort((left, right) => {
      if (left.readyForCustomers !== right.readyForCustomers) {
        return left.readyForCustomers ? 1 : -1;
      }
      return left.name.localeCompare(right.name);
    });
}

export type ConsoleStoreDetail = Store & {
  city: { id: string; name: string };
  members: {
    id: string;
    role: StoreRole;
    createdAt: Date;
    user: Pick<User, 'id' | 'fullName' | 'displayName' | 'phone'>;
  }[];
  invites: {
    id: string;
    phone: string;
    role: StoreRole;
    expiresAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
  }[];
  /** Orders reference a store through the vertical `details` container rather
   *  than a foreign key — the unified order model — so there is no relation to
   *  count here. Menu items are the number that says whether a shop is ready. */
  _count: { menuItems: number };
};

export async function consoleStoreDetail(
  storeId: string,
): Promise<ConsoleStoreDetail | null> {
  return prisma.store.findUnique({
    where: { id: storeId },
    include: {
      city: { select: { id: true, name: true } },
      members: {
        select: {
          id: true,
          role: true,
          createdAt: true,
          user: { select: { id: true, fullName: true, displayName: true, phone: true } },
        },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      },
      invites: {
        select: {
          id: true,
          phone: true,
          role: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      },
      _count: { select: { menuItems: true } },
    },
  });
}

/**
 * A URL-safe slug from a shop's name.
 *
 * Handles the two things that actually turn up in Philippine shop names —
 * apostrophes ("Kuya Ben's Grill") and ampersands ("Rice & Sisig") — and
 * strips accents rather than percent-encoding them, so the URL stays
 * typeable.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * A slug nothing else is using.
 *
 * Two shops with the same name in different cities is normal — there is a
 * Jollibee on most corners — so a collision is expected rather than an error,
 * and gets a numeric suffix instead of a rejected form.
 */
export async function uniqueStoreSlug(name: string): Promise<string> {
  const base = slugify(name) || 'store';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await prisma.store.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  // Fifty shops with one name is not a real case; a timestamp beats throwing.
  return `${base}-${Date.now().toString(36)}`;
}
