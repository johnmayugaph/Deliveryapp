import { StoreRole, type ServiceKey, type Store, type User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { inviteIsLive } from '@/lib/merchant/staff-policy';
import { STORE_IMAGE_PATH } from '@/lib/media/image-bytes';

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
  cityId: string;
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

  /** What the shop looks like on the storefront, so the list can show it. */
  logoUrl: string | null;
  coverUrl: string | null;
  addressLine: string;
  contactPhone: string | null;
  /** Whoever is named OWNER, for the column that says who to ring. */
  owner: { name: string; phone: string } | null;
  /** Orders ever placed at this shop, in any state. */
  orders: number;
}

/** What the console's store list can be narrowed by. */
export interface ConsoleStoreFilter {
  /** Name, slug, phone or owner — one box, because an operator has one string. */
  search?: string | undefined;
  /** 'open' | 'closed' */
  status?: string | undefined;
  /** 'live' | 'hidden' */
  visibility?: string | undefined;
  /** A city id. */
  cityId?: string | undefined;
}

/**
 * Orders per store, counted once for the whole list.
 *
 * `storeId` lives inside the vertical's own details container rather than in a
 * column, so this reads every order's `details` and groups in memory — the
 * same shape `admin/series.ts` uses. One pass for the page rather than one
 * query per row, which is what a count inside the table loop would have been.
 */
async function orderCountsByStore(): Promise<Map<string, number>> {
  const orders = await prisma.order.findMany({ select: { details: true } });
  const counts = new Map<string, number>();
  for (const order of orders) {
    const details = order.details;
    if (details === null || typeof details !== 'object' || Array.isArray(details)) continue;
    const storeId = (details as Record<string, unknown>).storeId;
    if (typeof storeId !== 'string' || storeId === '') continue;
    counts.set(storeId, (counts.get(storeId) ?? 0) + 1);
  }
  return counts;
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
  const [stores, orderCounts] = await Promise.all([
    prisma.store.findMany({
      include: {
        city: { select: { name: true } },
        _count: { select: { menuItems: true, members: true } },
        members: {
          select: {
            role: true,
            user: { select: { fullName: true, displayName: true, phone: true } },
          },
        },
        invites: {
          select: { acceptedAt: true, revokedAt: true, expiresAt: true },
        },
      },
      orderBy: { name: 'asc' },
    }),
    orderCountsByStore(),
  ]);

  return stores
    .map((store) => {
      const ownerRows = store.members.filter((m) => m.role === StoreRole.OWNER);
      const owners = ownerRows.length;
      const menuItems = store._count.menuItems;
      const firstOwner = ownerRows[0];
      return {
        id: store.id,
        name: store.name,
        slug: store.slug,
        cityId: store.cityId,
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
        logoUrl: store.logoUrl,
        coverUrl: store.coverUrl,
        addressLine: store.addressLine,
        contactPhone: store.contactPhone,
        owner: firstOwner
          ? {
              name:
                firstOwner.user.displayName ?? firstOwner.user.fullName ?? 'Unnamed',
              phone: firstOwner.user.phone,
            }
          : null,
        orders: orderCounts.get(store.id) ?? 0,
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

export class ImageUrlNotUnderstoodError extends Error {
  constructor() {
    super(
      'That does not look like an image address. Use a link starting https:// ' +
        '(or a data:image/… you pasted from an upload tool).',
    );
    this.name = 'ImageUrlNotUnderstoodError';
  }
}

/** How long a pasted data URL may be, to keep a row from becoming a file store. */
export const MAX_IMAGE_URL_LENGTH = 512_000;

export class ImageUrlTooLongError extends Error {
  constructor(readonly length: number) {
    super(
      `That address is ${Math.round(length / 1024)} KB. Paste a link instead of ` +
        'the whole image, or upload it somewhere and use the link.',
    );
    this.name = 'ImageUrlTooLongError';
  }
}

/**
 * A logo or banner address a shop may be given, or null to clear it.
 *
 * WHAT IS ALLOWED AND WHY. `https:` because that is where a hosted image
 * lives; `data:image/...` because the seed writes one and an operator with an
 * inline image from a resize tool should be able to paste it. Everything else
 * is refused — most usefully `http:`, which a browser on an HTTPS page blocks
 * as mixed content, so a shop's logo would simply fail to appear with no
 * message anywhere.
 *
 * This is NOT primarily an injection guard: a browser does not execute
 * `javascript:` in an `<img src>`. It is a typo guard, for a field whose
 * failure mode is a broken image on a customer's screen that nobody in the
 * office ever sees.
 *
 * AND `/store-images/<id>`, which is what an upload writes. Without that case
 * this form refused the value it had just shown you: once a shop had an
 * uploaded logo, opening the address panel to fix the BANNER failed on the
 * logo box, with a message about https:// that made no sense next to a path
 * this application had put there itself. Found in the browser, not by a test.
 */
export function parseImageUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > MAX_IMAGE_URL_LENGTH) throw new ImageUrlTooLongError(value.length);

  if (value.startsWith('data:image/')) return value;
  if (STORE_IMAGE_PATH.test(value)) return value;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ImageUrlNotUnderstoodError();
  }
  if (parsed.protocol !== 'https:') throw new ImageUrlNotUnderstoodError();
  return parsed.toString();
}

/**
 * Narrow the console's store list.
 *
 * Filtering in memory rather than in SQL, deliberately: `listConsoleStores`
 * already reads every store to work out which are ready, and one of the
 * filters — the search box — has to match the OWNER'S name and number, which
 * live on a joined user rather than on the store. Doing half in SQL and half
 * here would be two places to look when a row does not appear.
 *
 * An unrecognised value is ignored rather than matching nothing. These come
 * from a query string somebody may have edited or bookmarked, and an empty
 * table is a worse answer to a stale link than an unfiltered one.
 */
export function filterConsoleStores(
  rows: readonly ConsoleStoreRow[],
  filter: ConsoleStoreFilter,
): ConsoleStoreRow[] {
  const needle = (filter.search ?? '').trim().toLowerCase();

  return rows.filter((row) => {
    if (filter.status === 'open' && !row.isOpen) return false;
    if (filter.status === 'closed' && row.isOpen) return false;
    if (filter.visibility === 'live' && !row.isVisible) return false;
    if (filter.visibility === 'hidden' && row.isVisible) return false;
    if (filter.cityId !== undefined && filter.cityId !== '' && row.cityId !== filter.cityId) {
      return false;
    }
    if (needle !== '') {
      const haystack = [
        row.name,
        row.slug,
        row.contactPhone ?? '',
        row.addressLine,
        row.owner?.name ?? '',
        row.owner?.phone ?? '',
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}
