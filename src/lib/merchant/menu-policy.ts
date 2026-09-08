/**
 * What a menu may look like, decided in one pure place.
 *
 * The gap this closes: until now nothing in the application could create a
 * menu item. A shop could be created at `/admin/stores`, its staff invited,
 * its prices edited — and the dishes themselves only ever came from the seed
 * file, so a real shop's menu meant a hand-written SQL INSERT. The console
 * even refuses to make a shop visible until it has a menu, and told the owner
 * to "add items first", which was advice nobody could act on.
 *
 * Everything here is a pure function over rows, so the rules that decide what
 * a name, a price and an order may be are testable without a database — and
 * so the same rules can be applied in the form and again in the action,
 * because a disabled button is not a validation check.
 *
 * ## The ordering model
 *
 * A store's menu is ONE ordered list. `sortOrder` is a position in it, dense
 * from zero, and a category is a contiguous run inside that list; the order of
 * the categories is the order their first item appears. There is no separate
 * category table and no per-category rank column.
 *
 * That is a deliberate choice over the two alternatives. Ordering categories
 * alphabetically — which is what this screen did before — puts "Add-ons" above
 * "Rice meals" in every carinderia in the country, and no shop wants their
 * extra rice listed first. A `MenuCategory` model with its own `sortOrder`
 * would be the textbook answer, but it turns a category rename into a
 * migration of live rows and gives two places (the model and the item's
 * string) that can disagree about what a category is called.
 *
 * The cost of the run model is that every reorder resequences the whole
 * store's list rather than writing one row. A menu is tens of items, edited by
 * hand, so that is a rounding error — and in exchange the invariant is
 * checkable in one pass, which `resequencePlan` is.
 */

/** Limits, all of them "long enough for a real menu, short enough to render". */
export const MAX_ITEM_NAME_LENGTH = 80;
export const MAX_CATEGORY_LENGTH = 40;
export const MAX_DESCRIPTION_LENGTH = 280;

/**
 * The same bounds the price-only editor used, moved here so that one module
 * decides what a price may be. ₱1 because a free item is a promotion rather
 * than a menu line; ₱10,000 because a lechon is about ₱8,000 and anything
 * above it is a typo with a rider's whole float attached.
 */
export const MIN_PRICE_CENTAVOS = 100;
export const MAX_PRICE_CENTAVOS = 10_000_00;

/**
 * A ceiling on one store's menu.
 *
 * Not a business rule — a bound on a form that authenticated staff can post to
 * in a loop. The largest real menu in the demo data is four items; three
 * hundred is far past any carinderia and still nothing to render.
 */
export const MAX_ITEMS_PER_STORE = 300;

/** What the schema defaults to, so an item with no category is not an error. */
export const DEFAULT_CATEGORY = 'Main';

export class ItemNameRequiredError extends Error {
  constructor() {
    super('Give the item a name.');
    this.name = 'ItemNameRequiredError';
  }
}

export class PriceNotUnderstoodError extends Error {
  constructor(readonly input: string) {
    super('Write the price in pesos, like 120 or 120.50.');
    this.name = 'PriceNotUnderstoodError';
  }
}

export class PriceOutOfRangeError extends Error {
  constructor(readonly centavos: number) {
    super('A price has to be between ₱1 and ₱10,000.');
    this.name = 'PriceOutOfRangeError';
  }
}

export class DuplicateItemNameError extends Error {
  // `itemName`, not `name`: `Error.name` is the error's own class name and is
  // what the monitoring fingerprint groups on.
  constructor(readonly itemName: string, readonly category: string) {
    super(`"${itemName}" is already under ${category}.`);
    this.name = 'DuplicateItemNameError';
  }
}

export class MenuFullError extends Error {
  constructor() {
    super(
      `A menu can hold ${MAX_ITEMS_PER_STORE} items. Remove something you no ` +
        'longer sell, or ask support to raise it.',
    );
    this.name = 'MenuFullError';
  }
}

export class MenuItemNotFoundError extends Error {
  constructor() {
    super('That item is not on your menu.');
    this.name = 'MenuItemNotFoundError';
  }
}

/**
 * The row is not the one the screen was showing.
 *
 * A phone left open on the menu screen in a kitchen is a stale view, and the
 * destructive control on it is delete. Checking the name the merchant was
 * looking at against the row about to be deleted turns "somebody else
 * reordered the menu ten minutes ago" from a deleted wrong dish into a
 * message asking them to reload.
 */
export class MenuItemChangedError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(
      `This screen is out of date: that row is "${actual}", not "${expected}". ` +
        'Reload the menu and try again.',
    );
    this.name = 'MenuItemChangedError';
  }
}

export class CategoryNotFoundError extends Error {
  constructor(readonly category: string) {
    super(`There is no "${category}" on your menu.`);
    this.name = 'CategoryNotFoundError';
  }
}

/** One space between words, nothing at the ends. What people paste is worse. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A name, or a refusal. Truncation rather than rejection on length: a long
 *  name is a mistake worth fixing quietly, an empty one cannot be saved. */
export function normaliseItemName(raw: string): string {
  const name = collapse(raw).slice(0, MAX_ITEM_NAME_LENGTH);
  if (name.length === 0) throw new ItemNameRequiredError();
  return name;
}

export function normaliseDescription(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const description = collapse(raw).slice(0, MAX_DESCRIPTION_LENGTH);
  return description.length === 0 ? null : description;
}

/**
 * A category, snapped to the spelling already on the menu.
 *
 * Case-insensitive matching against the existing categories is the whole point:
 * a manager typing "add-ons" when the menu says "Add-ons" would otherwise
 * create a second run with the same name in a different case, and the fix
 * after the fact is renaming rows one at a time. Their capitalisation wins
 * only when the category is genuinely new.
 */
export function normaliseCategory(raw: string, existing: readonly string[] = []): string {
  const category = collapse(raw).slice(0, MAX_CATEGORY_LENGTH);
  if (category.length === 0) return DEFAULT_CATEGORY;
  const match = existing.find((known) => sameText(known, category));
  return match ?? category;
}

/** Case- and space-insensitive comparison, for "is this the same thing". */
export function sameText(left: string, right: string): boolean {
  return collapse(left).toLowerCase() === collapse(right).toLowerCase();
}

/** Centavos, or a refusal naming which of the two things went wrong. */
export function parsePrice(raw: string, toCentavos: (input: string) => number | null): number {
  const centavos = toCentavos(raw);
  if (centavos === null) throw new PriceNotUnderstoodError(raw);
  if (centavos < MIN_PRICE_CENTAVOS || centavos > MAX_PRICE_CENTAVOS) {
    throw new PriceOutOfRangeError(centavos);
  }
  return centavos;
}

/** Just the fields the ordering rules read. */
export interface MenuRowLike {
  id: string;
  name: string;
  category: string;
}

export interface MenuGroup<Row extends MenuRowLike> {
  category: string;
  items: Row[];
}

/**
 * Groups a menu into its category runs, in the order they appear.
 *
 * Insertion order does the work, so this reflects whatever order the caller
 * read the rows in — which is why the queries order by `sortOrder` and not by
 * category. An item that appears after its category's run has already been
 * passed still joins that run rather than starting a second one with the same
 * name; that only happens on data that has never been resequenced, and the
 * next edit fixes it for good.
 */
export function groupByCategory<Row extends MenuRowLike>(
  items: readonly Row[],
): MenuGroup<Row>[] {
  const groups = new Map<string, MenuGroup<Row>>();
  for (const item of items) {
    const key = collapse(item.category).toLowerCase();
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { category: item.category, items: [item] });
  }
  return [...groups.values()];
}

/** The categories on a menu, in run order. For "snap to existing spelling". */
export function categoriesOf(items: readonly MenuRowLike[]): string[] {
  return groupByCategory(items).map((group) => group.category);
}

/**
 * The `sortOrder` each row should have for the list to be dense, contiguous
 * runs — returning ONLY the rows whose value would change.
 *
 * Every mutation ends with this, which is what makes the invariant true rather
 * than hoped for: an item added to a category in the middle of the menu is
 * placed at the end of that category's run, not at the end of the menu, and
 * the rows after it shift down by one.
 */
export function resequencePlan(
  items: readonly MenuRowLike[],
  current: ReadonlyMap<string, number>,
): { id: string; sortOrder: number }[] {
  const changes: { id: string; sortOrder: number }[] = [];
  let position = 0;
  for (const group of groupByCategory(items)) {
    for (const item of group.items) {
      if (current.get(item.id) !== position) {
        changes.push({ id: item.id, sortOrder: position });
      }
      position += 1;
    }
  }
  return changes;
}

export type Direction = 'UP' | 'DOWN';

/**
 * The list with one item swapped with its neighbour INSIDE its own category.
 *
 * Moving an item past the edge of its run would silently recategorise it,
 * which is not what "up" means to somebody looking at a grouped list — so at
 * the top or bottom of a run this returns the list unchanged, and the caller
 * reports that there was nothing to do.
 */
export function withItemMoved<Row extends MenuRowLike>(
  items: readonly Row[],
  itemId: string,
  direction: Direction,
): Row[] {
  const groups = groupByCategory(items);
  const group = groups.find((candidate) =>
    candidate.items.some((item) => item.id === itemId),
  );
  if (!group) throw new MenuItemNotFoundError();

  const index = group.items.findIndex((item) => item.id === itemId);
  const target = direction === 'UP' ? index - 1 : index + 1;
  if (target < 0 || target >= group.items.length) {
    return groups.flatMap((candidate) => candidate.items);
  }

  const reordered = [...group.items];
  const moved = reordered[index]!;
  reordered[index] = reordered[target]!;
  reordered[target] = moved;

  return groups.flatMap((candidate) =>
    candidate === group ? reordered : candidate.items,
  );
}

/** The list with one whole category run swapped with the run beside it. */
export function withCategoryMoved<Row extends MenuRowLike>(
  items: readonly Row[],
  category: string,
  direction: Direction,
): Row[] {
  const groups = groupByCategory(items);
  const index = groups.findIndex((group) => sameText(group.category, category));
  if (index === -1) throw new CategoryNotFoundError(category);

  const target = direction === 'UP' ? index - 1 : index + 1;
  if (target < 0 || target >= groups.length) {
    return groups.flatMap((group) => group.items);
  }

  const reordered = [...groups];
  const moved = reordered[index]!;
  reordered[index] = reordered[target]!;
  reordered[target] = moved;
  return reordered.flatMap((group) => group.items);
}

/**
 * Whether a name is already taken in the category it is going into.
 *
 * Scoped to the category on purpose: "Extra Rice" as an add-on and "Extra
 * Rice" as a rice meal are two sellable things, and a shop that wants both
 * should not be argued with. Two of the same name in the SAME run is a
 * double-tap, and the kitchen printout cannot tell them apart.
 */
export function findDuplicate<Row extends MenuRowLike>(
  items: readonly Row[],
  candidate: { name: string; category: string; exceptId?: string | undefined },
): Row | null {
  return (
    items.find(
      (item) =>
        item.id !== candidate.exceptId &&
        sameText(item.name, candidate.name) &&
        sameText(item.category, candidate.category),
    ) ?? null
  );
}

/** A summary line the merchant screen shows above the list. */
export function describeMenu(counts: { items: number; unavailable: number }): string {
  if (counts.items === 0) return 'Nothing on the menu yet';
  const items = `${counts.items} item${counts.items === 1 ? '' : 's'}`;
  return counts.unavailable > 0 ? `${items} · ${counts.unavailable} out of stock` : items;
}
