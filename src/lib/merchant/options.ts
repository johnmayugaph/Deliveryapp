import type { MenuItemOption, MenuItemOptionGroup } from '@prisma/client';
import { prisma, type PrismaTransactionClient } from '@/lib/prisma';
import { MenuItemNotFoundError } from '@/lib/merchant/menu-policy';
import {
  DuplicateOptionNameError,
  MAX_GROUPS_PER_ITEM,
  MAX_OPTIONS_PER_GROUP,
  normaliseChoiceBounds,
  normaliseGroupName,
  normaliseOptionName,
  sameOptionText,
} from '@/lib/merchant/option-policy';
import type { Direction } from '@/lib/merchant/menu-policy';

/**
 * A shop writing down the choices on a dish.
 *
 * Reads and writes only; the rules are in `option-policy.ts` and the
 * authorisation is done by `requireStoreAccess` before anything here runs.
 *
 * Two properties, the same two the menu itself keeps:
 *
 *  - **Everything is scoped through the store.** A group id or an option id
 *    from another shop resolves to nothing, because every lookup joins back
 *    up to `storeId` rather than trusting the id it was handed.
 *  - **Order is dense and explicit.** Groups are positions on a dish and
 *    options are positions in a group, resequenced after each change, so
 *    "Regular, Large" cannot silently become "Large, Regular" — which on a
 *    menu is the difference between the default being cheap and being
 *    expensive.
 */

export class OptionGroupNotFoundError extends Error {
  constructor() {
    super('That choice is not on this dish.');
    this.name = 'OptionGroupNotFoundError';
  }
}

export class OptionNotFoundError extends Error {
  constructor() {
    super('That answer is not on this dish.');
    this.name = 'OptionNotFoundError';
  }
}

export class TooManyGroupsError extends Error {
  constructor() {
    super(`A dish can ask ${MAX_GROUPS_PER_ITEM} questions. That is already a lot.`);
    this.name = 'TooManyGroupsError';
  }
}

export class TooManyOptionsError extends Error {
  constructor() {
    super(`A choice can have ${MAX_OPTIONS_PER_GROUP} answers.`);
    this.name = 'TooManyOptionsError';
  }
}

export type GroupWithOptions = MenuItemOptionGroup & { options: MenuItemOption[] };

const GROUPS_WITH_OPTIONS = {
  orderBy: { sortOrder: 'asc' },
  include: { options: { orderBy: { sortOrder: 'asc' } } },
} as const;

/** Every choice on one dish, in the shop's order. */
export async function itemOptionGroups(input: {
  storeId: string;
  menuItemId: string;
}): Promise<GroupWithOptions[]> {
  const item = await prisma.menuItem.findFirst({
    where: { id: input.menuItemId, storeId: input.storeId },
    select: { id: true },
  });
  if (!item) throw new MenuItemNotFoundError();

  return prisma.menuItemOptionGroup.findMany({
    where: { menuItemId: item.id },
    ...GROUPS_WITH_OPTIONS,
  });
}

/** How many choices each dish on a menu has, for the list screen. */
export async function optionCountsByItem(storeId: string): Promise<Map<string, number>> {
  const groups = await prisma.menuItemOptionGroup.groupBy({
    by: ['menuItemId'],
    where: { menuItem: { storeId } },
    _count: { _all: true },
  });
  return new Map(groups.map((row) => [row.menuItemId, row._count._all]));
}

async function requireItem(storeId: string, menuItemId: string): Promise<string> {
  const item = await prisma.menuItem.findFirst({
    where: { id: menuItemId, storeId },
    select: { id: true },
  });
  if (!item) throw new MenuItemNotFoundError();
  return item.id;
}

/** Resolves a group id, but only through the store that owns it. */
async function requireGroup(storeId: string, groupId: string): Promise<GroupWithOptions> {
  const group = await prisma.menuItemOptionGroup.findFirst({
    where: { id: groupId, menuItem: { storeId } },
    include: { options: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!group) throw new OptionGroupNotFoundError();
  return group;
}

export async function addOptionGroup(input: {
  storeId: string;
  menuItemId: string;
  name: string;
  minChoices: number;
  maxChoices: number;
}): Promise<MenuItemOptionGroup> {
  const menuItemId = await requireItem(input.storeId, input.menuItemId);
  const name = normaliseGroupName(input.name);
  const bounds = normaliseChoiceBounds(input);

  const existing = await prisma.menuItemOptionGroup.count({ where: { menuItemId } });
  if (existing >= MAX_GROUPS_PER_ITEM) throw new TooManyGroupsError();

  return prisma.menuItemOptionGroup.create({
    data: { menuItemId, name, ...bounds, sortOrder: existing },
  });
}

export async function editOptionGroup(input: {
  storeId: string;
  groupId: string;
  name: string;
  minChoices: number;
  maxChoices: number;
}): Promise<MenuItemOptionGroup> {
  const group = await requireGroup(input.storeId, input.groupId);
  const name = normaliseGroupName(input.name);
  const bounds = normaliseChoiceBounds(input);

  return prisma.menuItemOptionGroup.update({
    where: { id: group.id },
    data: { name, ...bounds },
  });
}

/** Removes a choice and every answer under it. */
export async function removeOptionGroup(input: {
  storeId: string;
  groupId: string;
}): Promise<{ name: string }> {
  const group = await requireGroup(input.storeId, input.groupId);
  return prisma.$transaction(async (tx) => {
    await tx.menuItemOptionGroup.delete({ where: { id: group.id } });
    const remaining = await tx.menuItemOptionGroup.findMany({
      where: { menuItemId: group.menuItemId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    });
    await resequence(tx, 'group', remaining.map((row) => row.id));
    return { name: group.name };
  });
}

export async function moveOptionGroup(input: {
  storeId: string;
  groupId: string;
  direction: Direction;
}): Promise<{ moved: boolean }> {
  const group = await requireGroup(input.storeId, input.groupId);
  return prisma.$transaction(async (tx) => {
    const siblings = await tx.menuItemOptionGroup.findMany({
      where: { menuItemId: group.menuItemId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    });
    const order = swapped(siblings.map((row) => row.id), group.id, input.direction);
    if (!order) return { moved: false };
    await resequence(tx, 'group', order);
    return { moved: true };
  });
}

export async function addOption(input: {
  storeId: string;
  groupId: string;
  name: string;
  priceDeltaCentavos: number;
}): Promise<MenuItemOption> {
  const group = await requireGroup(input.storeId, input.groupId);
  const name = normaliseOptionName(input.name);

  if (group.options.length >= MAX_OPTIONS_PER_GROUP) throw new TooManyOptionsError();
  if (group.options.some((option) => sameOptionText(option.name, name))) {
    throw new DuplicateOptionNameError(name);
  }

  return prisma.menuItemOption.create({
    data: {
      groupId: group.id,
      name,
      priceDeltaCentavos: input.priceDeltaCentavos,
      sortOrder: group.options.length,
    },
  });
}

export async function editOption(input: {
  storeId: string;
  optionId: string;
  name: string;
  priceDeltaCentavos: number;
}): Promise<MenuItemOption> {
  const option = await prisma.menuItemOption.findFirst({
    where: { id: input.optionId, group: { menuItem: { storeId: input.storeId } } },
    include: { group: { include: { options: true } } },
  });
  if (!option) throw new OptionNotFoundError();

  const name = normaliseOptionName(input.name);
  const clash = option.group.options.some(
    (sibling) => sibling.id !== option.id && sameOptionText(sibling.name, name),
  );
  if (clash) throw new DuplicateOptionNameError(name);

  return prisma.menuItemOption.update({
    where: { id: option.id },
    data: { name, priceDeltaCentavos: input.priceDeltaCentavos },
  });
}

/** Out of stock, or back. The one control a shop uses during a shift. */
export async function setOptionAvailability(input: {
  storeId: string;
  optionId: string;
  isAvailable: boolean;
}): Promise<{ name: string; isAvailable: boolean }> {
  const { count } = await prisma.menuItemOption.updateMany({
    where: { id: input.optionId, group: { menuItem: { storeId: input.storeId } } },
    data: { isAvailable: input.isAvailable },
  });
  if (count === 0) throw new OptionNotFoundError();
  const option = await prisma.menuItemOption.findUniqueOrThrow({
    where: { id: input.optionId },
    select: { name: true, isAvailable: true },
  });
  return option;
}

export async function removeOption(input: {
  storeId: string;
  optionId: string;
}): Promise<{ name: string }> {
  const option = await prisma.menuItemOption.findFirst({
    where: { id: input.optionId, group: { menuItem: { storeId: input.storeId } } },
    select: { id: true, name: true, groupId: true },
  });
  if (!option) throw new OptionNotFoundError();

  return prisma.$transaction(async (tx) => {
    await tx.menuItemOption.delete({ where: { id: option.id } });
    const remaining = await tx.menuItemOption.findMany({
      where: { groupId: option.groupId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    });
    await resequence(tx, 'option', remaining.map((row) => row.id));
    return { name: option.name };
  });
}

export async function moveOption(input: {
  storeId: string;
  optionId: string;
  direction: Direction;
}): Promise<{ moved: boolean }> {
  const option = await prisma.menuItemOption.findFirst({
    where: { id: input.optionId, group: { menuItem: { storeId: input.storeId } } },
    select: { id: true, groupId: true },
  });
  if (!option) throw new OptionNotFoundError();

  return prisma.$transaction(async (tx) => {
    const siblings = await tx.menuItemOption.findMany({
      where: { groupId: option.groupId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    });
    const order = swapped(siblings.map((row) => row.id), option.id, input.direction);
    if (!order) return { moved: false };
    await resequence(tx, 'option', order);
    return { moved: true };
  });
}

/**
 * The list with one id swapped with its neighbour, or null at the edge.
 *
 * Null rather than the unchanged list, so a caller reports "already first"
 * instead of claiming to have moved something.
 */
function swapped(ids: string[], id: string, direction: Direction): string[] | null {
  const index = ids.indexOf(id);
  const target = direction === 'UP' ? index - 1 : index + 1;
  if (index === -1 || target < 0 || target >= ids.length) return null;
  const next = [...ids];
  next[index] = ids[target]!;
  next[target] = id;
  return next;
}

/** Writes 0..n-1 over a list of ids. Dense, so the next move is unambiguous. */
async function resequence(
  tx: PrismaTransactionClient,
  kind: 'group' | 'option',
  ids: readonly string[],
): Promise<void> {
  for (const [index, id] of ids.entries()) {
    if (kind === 'group') {
      await tx.menuItemOptionGroup.update({ where: { id }, data: { sortOrder: index } });
    } else {
      await tx.menuItemOption.update({ where: { id }, data: { sortOrder: index } });
    }
  }
}
