import type { MenuItem } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { IMAGE_SUMMARY_SELECT, type MenuImageSummary } from '@/lib/media/menu-images';
import {
  CategoryNotFoundError,
  DEFAULT_CATEGORY,
  DuplicateItemNameError,
  MAX_ITEMS_PER_STORE,
  MenuFullError,
  MenuItemChangedError,
  MenuItemNotFoundError,
  categoriesOf,
  findDuplicate,
  groupByCategory,
  normaliseCategory,
  normaliseDescription,
  normaliseItemName,
  resequencePlan,
  sameText,
  withCategoryMoved,
  withItemMoved,
  type Direction,
  type MenuRowLike,
} from '@/lib/merchant/menu-policy';

/**
 * A shop writing down what it sells.
 *
 * Reads and writes only; every rule about what is allowed lives in
 * `menu-policy.ts`, and every question about who is allowed is answered by
 * `requireStoreAccess` before anything here is called. Nothing in this file
 * looks at a session.
 *
 * Two properties hold across all of it:
 *
 *  - **Every write is scoped to the store.** An item id from another shop
 *    matches nothing rather than being edited, which is why each mutation
 *    starts by reading the store's own rows and finds the target in that list
 *    instead of fetching it by id.
 *  - **Every write ends with the list resequenced**, inside the same
 *    transaction. The ordering invariant — dense positions, categories as
 *    contiguous runs — is therefore true after each edit rather than
 *    maintained by every caller remembering to.
 *
 * Deleting an item is a real delete, not an archive, and that is safe for one
 * specific reason: an order snapshots the name and the price it charged into
 * its own `details`, and nothing anywhere holds a foreign key to `MenuItem`.
 * Removing yesterday's dish cannot rewrite yesterday's receipt.
 */

/** A dish with what a page needs to render its photograph. */
export type MenuItemWithImage = MenuItem & { image: MenuImageSummary | null };

/** Just the columns the ordering rules need. */
type OrderingRow = MenuRowLike & { sortOrder: number };

const ORDERING_SELECT = { id: true, name: true, category: true, sortOrder: true } as const;

/**
 * The store's menu in list order.
 *
 * `sortOrder` first, then a deterministic tiebreak. The tiebreak is not
 * decoration: a store seeded or migrated before this feature can have every
 * row at the same position, and Postgres is free to return equal rows in any
 * order — so without it the same menu could render in a different order on
 * each request. The first edit resequences the store for good.
 */
export function storeMenu(storeId: string): Promise<MenuItemWithImage[]> {
  return prisma.menuItem.findMany({
    where: { storeId },
    // The photo's id and shape, never its bytes — see the note on
    // `MenuItemImage`. `include: { image: true }` here would read every
    // photograph on the menu out of the database to render a list.
    include: { image: { select: IMAGE_SUMMARY_SELECT } },
    orderBy: [{ sortOrder: 'asc' }, { category: 'asc' }, { name: 'asc' }],
  });
}

/** The same order, for the customer's store page, available items only. */
export function visibleStoreMenu(storeId: string): Promise<MenuItemWithImage[]> {
  return prisma.menuItem.findMany({
    where: { storeId, isAvailable: true },
    include: { image: { select: IMAGE_SUMMARY_SELECT } },
    orderBy: [{ sortOrder: 'asc' }, { category: 'asc' }, { name: 'asc' }],
  });
}

function readOrderingRows(
  tx: PrismaTransactionClient,
  storeId: string,
): Promise<OrderingRow[]> {
  return tx.menuItem.findMany({
    where: { storeId },
    select: ORDERING_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { category: 'asc' }, { name: 'asc' }],
  });
}

/**
 * Writes the positions that changed.
 *
 * One `update` per moved row rather than a single clever statement: a menu is
 * tens of rows, this runs inside a transaction, and the readable version is
 * the one somebody can check against `resequencePlan`.
 */
async function applyOrder(
  tx: PrismaTransactionClient,
  storeId: string,
  order: readonly MenuRowLike[],
  current: readonly OrderingRow[],
): Promise<number> {
  const positions = new Map(current.map((row) => [row.id, row.sortOrder]));
  const changes = resequencePlan(order, positions);
  for (const change of changes) {
    await tx.menuItem.updateMany({
      where: { id: change.id, storeId },
      data: { sortOrder: change.sortOrder },
    });
  }
  return changes.length;
}

export interface MenuItemInput {
  storeId: string;
  name: string;
  category: string;
  priceCentavos: number;
  description?: string | null | undefined;
}

/**
 * Adds a dish.
 *
 * Placed at the END of its own category's run rather than at the end of the
 * menu, because "add another rice meal" means it belongs with the rice meals.
 * A category nobody has used yet becomes a new run at the bottom, which is
 * where a new section should start.
 */
export async function addMenuItem(input: MenuItemInput): Promise<MenuItem> {
  const name = normaliseItemName(input.name);
  const description = normaliseDescription(input.description);

  return prisma.$transaction(async (tx) => {
    const rows = await readOrderingRows(tx, input.storeId);
    if (rows.length >= MAX_ITEMS_PER_STORE) throw new MenuFullError();

    const category = normaliseCategory(input.category, categoriesOf(rows));
    const clash = findDuplicate(rows, { name, category });
    if (clash) throw new DuplicateItemNameError(name, category);

    const created = await tx.menuItem.create({
      data: {
        storeId: input.storeId,
        name,
        category,
        description,
        priceCentavos: input.priceCentavos,
        // Beyond every existing row, so it lands at the end of its run once
        // the resequence below groups it with its category.
        sortOrder: rows.length,
      },
    });

    await applyOrder(
      tx,
      input.storeId,
      [...rows, { id: created.id, name, category }],
      rows,
    );
    return created;
  });
}

export interface MenuItemEdit extends MenuItemInput {
  itemId: string;
}

/**
 * Changes a dish.
 *
 * Recategorising is the interesting case: the item leaves one run and joins
 * the end of another, and both runs stay contiguous because the whole list is
 * resequenced afterwards. A price change is safe for the same reason a delete
 * is — every order kept its own copy of what it charged.
 */
export async function editMenuItem(input: MenuItemEdit): Promise<MenuItem> {
  const name = normaliseItemName(input.name);
  const description = normaliseDescription(input.description);

  return prisma.$transaction(async (tx) => {
    const rows = await readOrderingRows(tx, input.storeId);
    const existing = rows.find((row) => row.id === input.itemId);
    if (!existing) throw new MenuItemNotFoundError();

    const category = normaliseCategory(input.category, categoriesOf(rows));
    const clash = findDuplicate(rows, { name, category, exceptId: existing.id });
    if (clash) throw new DuplicateItemNameError(name, category);

    const updated = await tx.menuItem.update({
      where: { id: existing.id },
      data: { name, category, description, priceCentavos: input.priceCentavos },
    });

    const moved = sameText(existing.category, category)
      ? rows.map((row) => (row.id === existing.id ? { ...row, name, category } : row))
      : [
          ...rows.filter((row) => row.id !== existing.id),
          { id: existing.id, name, category },
        ];

    await applyOrder(tx, input.storeId, moved, rows);
    return updated;
  });
}

/**
 * Takes a dish off the menu for good. See the note about receipts above.
 *
 * `expectedName` is what the screen was showing. It is checked against the row
 * before anything is deleted, because the only destructive control here is
 * this one and the screen it sits on is a phone somebody left open.
 */
export async function removeMenuItem(input: {
  storeId: string;
  itemId: string;
  expectedName?: string | undefined;
}): Promise<{ name: string }> {
  return prisma.$transaction(async (tx) => {
    const rows = await readOrderingRows(tx, input.storeId);
    const existing = rows.find((row) => row.id === input.itemId);
    if (!existing) throw new MenuItemNotFoundError();
    if (input.expectedName !== undefined && !sameText(existing.name, input.expectedName)) {
      throw new MenuItemChangedError(input.expectedName, existing.name);
    }

    await tx.menuItem.deleteMany({ where: { id: existing.id, storeId: input.storeId } });
    await applyOrder(
      tx,
      input.storeId,
      rows.filter((row) => row.id !== existing.id),
      rows,
    );
    return { name: existing.name };
  });
}

/** Moves one dish within its own section. */
export async function moveMenuItem(input: {
  storeId: string;
  itemId: string;
  direction: Direction;
}): Promise<{ moved: boolean }> {
  return prisma.$transaction(async (tx) => {
    const rows = await readOrderingRows(tx, input.storeId);
    const order = withItemMoved(rows, input.itemId, input.direction);
    const written = await applyOrder(tx, input.storeId, order, rows);
    // Nothing written means it was already at the edge of its section — a
    // no-op the screen reports rather than a lie about having moved it.
    return { moved: written > 0 };
  });
}

/** Moves a whole section, dishes and all. This is the one that answers
 *  "why is Add-ons at the top of my menu". */
export async function moveCategory(input: {
  storeId: string;
  category: string;
  direction: Direction;
}): Promise<{ moved: boolean }> {
  return prisma.$transaction(async (tx) => {
    const rows = await readOrderingRows(tx, input.storeId);
    const order = withCategoryMoved(rows, input.category, input.direction);
    const written = await applyOrder(tx, input.storeId, order, rows);
    return { moved: written > 0 };
  });
}

/**
 * Renames a section.
 *
 * Renaming onto a section that already exists MERGES the two, which is the
 * useful reading of "call these Extras as well" — except when the merge would
 * leave two identically named dishes in one run, which the kitchen printout
 * could not tell apart. That is refused, naming the collision.
 */
export async function renameCategory(input: {
  storeId: string;
  category: string;
  name: string;
}): Promise<{ category: string; items: number }> {
  return prisma.$transaction(async (tx) => {
    const rows = await readOrderingRows(tx, input.storeId);
    const groups = groupByCategory(rows);
    const group = groups.find((candidate) => sameText(candidate.category, input.category));
    if (!group) throw new CategoryNotFoundError(input.category);

    const others = groups.filter((candidate) => candidate !== group).map((c) => c.category);
    const category = normaliseCategory(input.name, others);

    if (sameText(category, group.category)) {
      // Same word, different capitalisation: worth writing, nothing to check.
      await tx.menuItem.updateMany({
        where: { storeId: input.storeId, category: group.category },
        data: { category },
      });
      return { category, items: group.items.length };
    }

    for (const item of group.items) {
      const clash = rows.find(
        (row) =>
          row.id !== item.id &&
          sameText(row.name, item.name) &&
          sameText(row.category, category),
      );
      if (clash) throw new DuplicateItemNameError(item.name, category);
    }

    await tx.menuItem.updateMany({
      where: { storeId: input.storeId, category: group.category },
      data: { category },
    });

    const renamed = rows.map((row) =>
      sameText(row.category, group.category) ? { ...row, category } : row,
    );
    await applyOrder(tx, input.storeId, renamed, rows);
    return { category, items: group.items.length };
  });
}

export { DEFAULT_CATEGORY };
