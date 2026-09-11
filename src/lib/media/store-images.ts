import { StoreImageKind, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isStoreImageHref, readImageFacts, storeImageHref, type ImageFacts } from '@/lib/media/image-bytes';

/**
 * Where a shop's logo and banner are kept.
 *
 * The same seam as `menu-images.ts`: everything above it knows a picture by
 * the string in `Store.logoUrl` / `Store.coverUrl`, and only this file and the
 * route handler know the bytes are in Postgres.
 *
 * THE TWO COLUMNS STAY THE SOURCE OF TRUTH. An upload writes
 * `/store-images/<id>` into one of them; a hosted `https://…` link written by
 * hand or by the seed is left exactly as it is. That is why the storefront
 * needed no change when this arrived — it was already rendering whatever those
 * columns held.
 *
 * Which means the row and the column can disagree, and only one of them is on
 * a customer's screen. So every write here moves both in one transaction, and
 * `pruneOrphanStoreImages` exists for the other door — the address form, which
 * can overwrite a column that pointed at bytes we are then still storing.
 */

/** Which column a kind of picture is written to. One map, so nothing has to
 *  remember that a banner lives in a column called `coverUrl`. */
const COLUMN: Record<StoreImageKind, 'logoUrl' | 'coverUrl'> = {
  [StoreImageKind.LOGO]: 'logoUrl',
  [StoreImageKind.BANNER]: 'coverUrl',
};

/** What an operator calls it. Used in the messages the action returns. */
export const STORE_IMAGE_LABEL: Record<StoreImageKind, string> = {
  [StoreImageKind.LOGO]: 'logo',
  [StoreImageKind.BANNER]: 'banner',
};

export class StoreNotFoundError extends Error {
  constructor() {
    super('No such store.');
    this.name = 'StoreNotFoundError';
  }
}

/** Reads `kind` off a form without trusting it. */
export function parseStoreImageKind(raw: unknown): StoreImageKind {
  const value = String(raw ?? '');
  if (value === StoreImageKind.LOGO || value === StoreImageKind.BANNER) return value;
  throw new StoreImageKindUnknownError();
}

export class StoreImageKindUnknownError extends Error {
  constructor() {
    super('That is neither a logo nor a banner.');
    this.name = 'StoreImageKindUnknownError';
  }
}

/**
 * Stores a picture against a shop and points the shop at it.
 *
 * Replaced, not versioned — and the replacement is a DELETE plus a CREATE
 * rather than an update, so the new picture gets a new id. The old URL was
 * served with a year-long immutable cache; reusing the id would leave every
 * browser that had seen the shop holding the previous logo forever.
 */
export async function putStoreImage(input: {
  storeId: string;
  kind: StoreImageKind;
  bytes: Uint8Array;
  uploadedByUserId: string;
}): Promise<ImageFacts & { imageId: string; href: string; storeSlug: string }> {
  const facts = readImageFacts(input.bytes);

  return prisma.$transaction(async (tx) => {
    const store = await tx.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, slug: true },
    });
    if (!store) throw new StoreNotFoundError();

    await tx.storeImage.deleteMany({ where: { storeId: store.id, kind: input.kind } });
    const created = await tx.storeImage.create({
      data: {
        storeId: store.id,
        kind: input.kind,
        bytes: Buffer.from(input.bytes),
        contentType: facts.contentType,
        byteSize: facts.byteSize,
        width: facts.width,
        height: facts.height,
        uploadedByUserId: input.uploadedByUserId,
      },
      select: { id: true },
    });

    const href = storeImageHref(created.id);
    await tx.store.update({
      where: { id: store.id },
      data: { [COLUMN[input.kind]]: href },
    });

    return { ...facts, imageId: created.id, href, storeSlug: store.slug };
  });
}

/**
 * Takes a picture off a shop.
 *
 * Clears the column whatever it held — a hosted link is removed the same way —
 * and deletes our bytes if that is what it was pointing at.
 */
export async function removeStoreImage(input: {
  storeId: string;
  kind: StoreImageKind;
}): Promise<{ removed: boolean; storeSlug: string }> {
  return prisma.$transaction(async (tx) => {
    const store = await tx.store.findUnique({
      where: { id: input.storeId },
      select: { id: true, slug: true, logoUrl: true, coverUrl: true },
    });
    if (!store) throw new StoreNotFoundError();

    const column = COLUMN[input.kind];
    const current = store[column];
    if (current === null) return { removed: false, storeSlug: store.slug };

    await tx.storeImage.deleteMany({ where: { storeId: store.id, kind: input.kind } });
    // `null`, not `undefined`: undefined means "leave this column" to Prisma.
    await tx.store.update({ where: { id: store.id }, data: { [column]: null } });
    return { removed: true, storeSlug: store.slug };
  });
}

/**
 * Which stored pictures nothing points at any more.
 *
 * Pure, and separate from the delete, because this is the rule that is easy
 * to get subtly wrong: it compares against BOTH columns rather than against
 * the one whose kind matches, so moving a picture from the banner slot to the
 * logo slot does not delete the bytes still in use.
 */
export function orphanImageIds(
  rows: readonly { id: string }[],
  columns: { logoUrl: string | null; coverUrl: string | null },
): string[] {
  const stillUsed = new Set(
    [columns.logoUrl, columns.coverUrl].filter(isStoreImageHref) as string[],
  );
  return rows.filter((row) => !stillUsed.has(storeImageHref(row.id))).map((row) => row.id);
}

/**
 * Deletes stored bytes no column points at any more.
 *
 * The address form can write over a column that held `/store-images/<id>`, at
 * which point those bytes are unreachable from every page and nothing would
 * ever remove them. Called from that form's action, inside its transaction.
 */
export async function pruneOrphanStoreImages(
  storeId: string,
  columns: { logoUrl: string | null; coverUrl: string | null },
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  const rows = await tx.storeImage.findMany({ where: { storeId }, select: { id: true } });
  const orphans = orphanImageIds(rows, columns);
  if (orphans.length > 0) {
    await tx.storeImage.deleteMany({ where: { id: { in: orphans } } });
  }
}

/**
 * The bytes, for the route handler and nobody else.
 *
 * Public on purpose, like a menu photograph: a shop's logo is on a page
 * anybody can open, and putting it behind a session would break the storefront
 * that exists to be browsed without an account.
 */
export function readStoreImage(imageId: string): Promise<{
  bytes: Uint8Array;
  contentType: string;
  updatedAt: Date;
} | null> {
  return prisma.storeImage
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

/** How much of the database the shop pictures are using, for `/admin/health`. */
export async function storeImageFootprint(): Promise<{ count: number; bytes: number }> {
  const result = await prisma.storeImage.aggregate({
    _count: { _all: true },
    _sum: { byteSize: true },
  });
  return { count: result._count._all, bytes: result._sum.byteSize ?? 0 };
}
