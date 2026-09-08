import type { MenuItemImage } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { readImageFacts, type ImageFacts } from '@/lib/media/image-bytes';

/**
 * Where a dish's photograph is kept.
 *
 * This is the seam. Everything above it — the form, the action, the `<img>` —
 * knows an image by its id and asks for it at `/menu-images/<id>`; only this
 * file and the route handler know that the bytes are in Postgres. Moving them
 * to object storage later means writing `put`/`read` against a bucket and
 * having the route redirect, with no change to the schema those callers see.
 *
 * Bytes in the database, and the reasoning is the same as choosing not to use
 * Sentry for error reports: it works on the first deploy, with no bucket to
 * create, no credentials to rotate and nothing handed to a third party. A menu
 * is tens of photographs, served with a year-long immutable cache header, so
 * what is given up — a CDN edge — is not yet a cost. What IS a cost is the
 * database backup getting bigger, which is worth knowing before it surprises
 * somebody: at 400 KB a photo and three hundred dishes, a full menu is about
 * 120 MB.
 *
 * **One photo per dish, replaced rather than versioned.** A shop does not want
 * a history of its adobo pictures, and a new upload deletes the old row in the
 * same transaction — so nothing accumulates that nobody can see or delete.
 */

/** Everything except the bytes. This is what every page reads. */
export type MenuImageSummary = Pick<MenuItemImage, 'id' | 'width' | 'height' | 'byteSize'>;

export const IMAGE_SUMMARY_SELECT = {
  id: true,
  width: true,
  height: true,
  byteSize: true,
} as const;

export class MenuItemNotInStoreError extends Error {
  constructor() {
    super('That item is not on your menu.');
    this.name = 'MenuItemNotInStoreError';
  }
}

/**
 * Stores a photo against a dish, validating the bytes first.
 *
 * Scoped to the store: the item id is looked up WITH the store id, so a photo
 * cannot be attached to a neighbour's dish by editing a form field. The facts
 * come from `readImageFacts`, which reads the header rather than believing the
 * upload — so the `contentType` written here is one this application decided.
 */
export async function putMenuItemImage(input: {
  storeId: string;
  menuItemId: string;
  bytes: Uint8Array;
  uploadedByUserId: string;
}): Promise<ImageFacts & { imageId: string }> {
  const facts = readImageFacts(input.bytes);

  return prisma.$transaction(async (tx) => {
    const item = await tx.menuItem.findFirst({
      where: { id: input.menuItemId, storeId: input.storeId },
      select: { id: true },
    });
    if (!item) throw new MenuItemNotInStoreError();

    // Replaced, not versioned: the unique constraint on `menuItemId` would
    // refuse a second row anyway, and an upsert keeps the id stable, which
    // would leave every browser holding the OLD photo under a URL marked
    // immutable. A new row means a new URL, which is the whole reason that
    // cache header is safe.
    await tx.menuItemImage.deleteMany({ where: { menuItemId: item.id } });
    const created = await tx.menuItemImage.create({
      data: {
        menuItemId: item.id,
        bytes: Buffer.from(input.bytes),
        contentType: facts.contentType,
        byteSize: facts.byteSize,
        width: facts.width,
        height: facts.height,
        uploadedByUserId: input.uploadedByUserId,
      },
      select: { id: true },
    });

    return { ...facts, imageId: created.id };
  });
}

/** Takes the photo off a dish. The dish keeps its name and price. */
export async function removeMenuItemImage(input: {
  storeId: string;
  menuItemId: string;
}): Promise<{ removed: boolean }> {
  const item = await prisma.menuItem.findFirst({
    where: { id: input.menuItemId, storeId: input.storeId },
    select: { id: true },
  });
  if (!item) throw new MenuItemNotInStoreError();

  const { count } = await prisma.menuItemImage.deleteMany({ where: { menuItemId: item.id } });
  return { removed: count > 0 };
}

/**
 * The bytes, for the route handler and nobody else.
 *
 * Public on purpose — a menu photograph is on a page anybody can open, and
 * putting it behind a session would break the storefront that exists to be
 * browsed without an account. The id is a cuid, so it is not guessable, and
 * the row carries nothing but a picture of food.
 */
export function readMenuItemImage(imageId: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
  updatedAt: Date;
} | null> {
  return prisma.menuItemImage
    .findUnique({
      where: { id: imageId },
      select: { bytes: true, contentType: true, updatedAt: true },
    })
    .then((row) =>
      row === null
        ? null
        : { bytes: row.bytes, contentType: row.contentType, updatedAt: row.updatedAt },
    );
}

/** How much of the database the photographs are using. For `/admin/health`,
 *  because "the backup got big" should be answerable before it is a surprise. */
export async function menuImageFootprint(): Promise<{ count: number; bytes: number }> {
  const result = await prisma.menuItemImage.aggregate({
    _count: { _all: true },
    _sum: { byteSize: true },
  });
  return { count: result._count._all, bytes: result._sum.byteSize ?? 0 };
}
