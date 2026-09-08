import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CategoryNotFoundError,
  DEFAULT_CATEGORY,
  ItemNameRequiredError,
  MAX_ITEM_NAME_LENGTH,
  MAX_PRICE_CENTAVOS,
  MIN_PRICE_CENTAVOS,
  MenuItemNotFoundError,
  PriceNotUnderstoodError,
  PriceOutOfRangeError,
  categoriesOf,
  describeMenu,
  findDuplicate,
  groupByCategory,
  normaliseCategory,
  normaliseDescription,
  normaliseItemName,
  parsePrice,
  resequencePlan,
  sameText,
  withCategoryMoved,
  withItemMoved,
} from '@/lib/merchant/menu-policy';
import { centavosFromPesoInput } from '@/lib/money';

/**
 * Menu editing.
 *
 * The feature exists because nothing in the application could create a menu
 * item: a real shop's dishes meant an SQL INSERT, and the console refused to
 * publish a shop without a menu while telling its owner to add one.
 *
 * Most of what is asserted here is the ORDERING model, because it is the part
 * with an invariant worth pinning: a store's menu is one dense list and a
 * section is a contiguous run inside it. Every mutation resequences, so if
 * these rules are wrong the damage is a shop's menu shuffling itself.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

/** Source with comments blanked, line numbering preserved — the docstrings in
 *  these modules quote the very patterns some of these tests forbid. */
function codeOnly(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

interface Row {
  id: string;
  name: string;
  category: string;
  sortOrder: number;
}

/** A menu in list order, positions dense, exactly as the database holds one. */
function menu(...rows: [name: string, category: string][]): Row[] {
  return rows.map(([name, category], index) => ({
    id: `item_${index + 1}`,
    name,
    category,
    sortOrder: index,
  }));
}

const CARINDERIA = menu(
  ['Adobong Manok', 'Rice meals'],
  ['Sinigang na Baboy', 'Rice meals'],
  ['Pancit Bihon', 'Party trays'],
  ['Extra Rice', 'Add-ons'],
  ['Softdrinks', 'Add-ons'],
);

function positions(rows: readonly Row[]): Map<string, number> {
  return new Map(rows.map((row) => [row.id, row.sortOrder]));
}

/** Applies a plan, returning the rows as the database would then hold them. */
function applied(rows: readonly Row[], order: readonly Row[]): Row[] {
  const plan = new Map(resequencePlan(order, positions(rows)).map((c) => [c.id, c.sortOrder]));
  return order
    .map((row) => ({ ...row, sortOrder: plan.get(row.id) ?? row.sortOrder }))
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

/** The invariant, checked directly: dense from zero, one run per section. */
function assertWellOrdered(rows: readonly Row[]): void {
  const inOrder = [...rows].sort((left, right) => left.sortOrder - right.sortOrder);
  inOrder.forEach((row, index) => {
    expect(row.sortOrder, `${row.name} sits at ${row.sortOrder}, expected ${index}`).toBe(index);
  });

  const runs: string[] = [];
  for (const row of inOrder) {
    if (runs.length === 0 || !sameText(runs[runs.length - 1]!, row.category)) {
      runs.push(row.category);
    }
  }
  const distinct = new Set(runs.map((name) => name.toLowerCase()));
  expect(runs.length, `a section is split into two runs: ${runs.join(' / ')}`).toBe(
    distinct.size,
  );
}

// -----------------------------------------------------------------------------
// What a dish may be called, and cost
// -----------------------------------------------------------------------------

describe('names, sections and descriptions', () => {
  it('collapses the whitespace a phone keyboard produces', () => {
    expect(normaliseItemName('  Adobong   Manok  ')).toBe('Adobong Manok');
  });

  it('refuses an empty name rather than saving a blank row', () => {
    for (const input of ['', '   ', '\n\t']) {
      expect(() => normaliseItemName(input)).toThrow(ItemNameRequiredError);
    }
  });

  it('truncates a very long name instead of refusing it', () => {
    // A pasted paragraph is a mistake worth fixing quietly; an empty name
    // cannot be saved at all. The two deserve different answers.
    const long = normaliseItemName('a'.repeat(300));
    expect(long).toHaveLength(MAX_ITEM_NAME_LENGTH);
  });

  it('treats a blank description as no description', () => {
    expect(normaliseDescription('   ')).toBeNull();
    expect(normaliseDescription(null)).toBeNull();
    expect(normaliseDescription(' may kanin  at itlog ')).toBe('may kanin at itlog');
  });

  it('defaults a missing section rather than refusing the dish', () => {
    expect(normaliseCategory('')).toBe(DEFAULT_CATEGORY);
  });

  it('snaps a section to the spelling already on the menu', () => {
    // Typing "add-ons" when the menu says "Add-ons" must not create a second
    // section beside the first; that mess can only be undone row by row.
    const existing = categoriesOf(CARINDERIA);
    expect(normaliseCategory('add-ons', existing)).toBe('Add-ons');
    expect(normaliseCategory('  RICE   MEALS ', existing)).toBe('Rice meals');
  });

  it('keeps the shop’s own capitalisation for a genuinely new section', () => {
    expect(normaliseCategory('Merienda', categoriesOf(CARINDERIA))).toBe('Merienda');
  });
});

describe('reading a price somebody typed', () => {
  const parse = (input: string) => parsePrice(input, centavosFromPesoInput);

  it('takes what a shop owner actually writes', () => {
    expect(parse('120')).toBe(12_000);
    expect(parse('120.50')).toBe(12_050);
    expect(parse('₱1,250')).toBe(125_000);
    expect(parse(' 99.9 ')).toBe(9_990);
  });

  it('does not lose a centavo to binary floating point', () => {
    // 19.99 * 100 is 1998.9999999999998, and a price that arrives one centavo
    // short is the kind of bug nobody finds by looking.
    expect(centavosFromPesoInput('19.99')).toBe(1_999);
    expect(centavosFromPesoInput('0.07')).toBe(7);
  });

  it('refuses a third decimal place rather than rounding it away', () => {
    expect(() => parse('12.345')).toThrow(PriceNotUnderstoodError);
  });

  it('refuses anything that is not a number', () => {
    for (const input of ['', 'free', '12-', '1.2.3', '--5', '1e3']) {
      expect(() => parse(input), input).toThrow(PriceNotUnderstoodError);
    }
  });

  it('holds the range at ₱1 to ₱10,000', () => {
    expect(() => parse('0')).toThrow(PriceOutOfRangeError);
    expect(() => parse('0.99')).toThrow(PriceOutOfRangeError);
    expect(() => parse('10000.01')).toThrow(PriceOutOfRangeError);
    expect(parse('1')).toBe(MIN_PRICE_CENTAVOS);
    expect(parse('10000')).toBe(MAX_PRICE_CENTAVOS);
  });
});

// -----------------------------------------------------------------------------
// Sections as runs
// -----------------------------------------------------------------------------

describe('grouping a menu into sections', () => {
  it('keeps the shop’s order, not the alphabet', () => {
    // The bug this whole ordering model exists to kill: alphabetical sections
    // put "Add-ons" above "Rice meals" on every carinderia menu.
    expect(groupByCategory(CARINDERIA).map((group) => group.category)).toEqual([
      'Rice meals',
      'Party trays',
      'Add-ons',
    ]);
  });

  it('folds a differently-capitalised section into one run', () => {
    const rows = menu(['Extra Rice', 'Add-ons'], ['Softdrinks', 'add-ons']);
    const groups = groupByCategory(rows);
    expect(groups).toHaveLength(1);
    // The spelling shown is the first one seen, so the display does not flicker
    // between two capitalisations of the same word.
    expect(groups[0]!.category).toBe('Add-ons');
    expect(groups[0]!.items).toHaveLength(2);
  });

  it('gathers a stray item into its section rather than starting a second', () => {
    // Legacy data that has never been resequenced: an item sitting outside its
    // run. It must still appear once, under its own heading.
    const rows = menu(
      ['Adobong Manok', 'Rice meals'],
      ['Extra Rice', 'Add-ons'],
      ['Sinigang', 'Rice meals'],
    );
    const groups = groupByCategory(rows);
    expect(groups.map((group) => group.category)).toEqual(['Rice meals', 'Add-ons']);
    expect(groups[0]!.items.map((item) => item.name)).toEqual([
      'Adobong Manok',
      'Sinigang',
    ]);
  });
});

describe('resequencing', () => {
  it('reports nothing to do for a menu already in order', () => {
    expect(resequencePlan(CARINDERIA, positions(CARINDERIA))).toEqual([]);
  });

  it('returns only the rows whose position actually changes', () => {
    const rows = menu(['A', 'One'], ['B', 'One'], ['C', 'Two']);
    const swapped = withItemMoved(rows, 'item_2', 'UP');
    const plan = resequencePlan(swapped, positions(rows));
    expect(plan.map((change) => change.id).sort()).toEqual(['item_1', 'item_2']);
  });

  it('pulls a legacy menu with every row at zero into a dense list', () => {
    const flat = CARINDERIA.map((row) => ({ ...row, sortOrder: 0 }));
    const plan = resequencePlan(flat, positions(flat));
    // Row one is already at position zero; the other four move.
    expect(plan).toHaveLength(4);
    assertWellOrdered(applied(flat, flat));
  });

  it('makes a split section contiguous', () => {
    const rows = menu(
      ['Adobong Manok', 'Rice meals'],
      ['Extra Rice', 'Add-ons'],
      ['Sinigang', 'Rice meals'],
    );
    const result = applied(rows, rows);
    expect(result.map((row) => row.name)).toEqual([
      'Adobong Manok',
      'Sinigang',
      'Extra Rice',
    ]);
    assertWellOrdered(result);
  });
});

describe('moving one dish', () => {
  it('swaps it with the dish above', () => {
    const result = applied(CARINDERIA, withItemMoved(CARINDERIA, 'item_2', 'UP'));
    expect(result.map((row) => row.name).slice(0, 2)).toEqual([
      'Sinigang na Baboy',
      'Adobong Manok',
    ]);
    assertWellOrdered(result);
  });

  it('never carries it into the section below', () => {
    // "Down" from the bottom of a section would silently recategorise the
    // dish, which is not what anybody looking at a grouped list means by it.
    const result = applied(CARINDERIA, withItemMoved(CARINDERIA, 'item_2', 'DOWN'));
    expect(result.map((row) => row.name)).toEqual(CARINDERIA.map((row) => row.name));
    expect(result.find((row) => row.id === 'item_2')!.category).toBe('Rice meals');
  });

  it('does nothing at the top of a section', () => {
    const result = applied(CARINDERIA, withItemMoved(CARINDERIA, 'item_1', 'UP'));
    expect(result.map((row) => row.id)).toEqual(CARINDERIA.map((row) => row.id));
  });

  it('refuses an id that is not on this menu', () => {
    expect(() => withItemMoved(CARINDERIA, 'item_from_another_shop', 'UP')).toThrow(
      MenuItemNotFoundError,
    );
  });
});

describe('moving a whole section', () => {
  it('takes its dishes with it', () => {
    const result = applied(CARINDERIA, withCategoryMoved(CARINDERIA, 'Add-ons', 'UP'));
    expect(groupByCategory(result).map((group) => group.category)).toEqual([
      'Rice meals',
      'Add-ons',
      'Party trays',
    ]);
    expect(
      groupByCategory(result)
        .find((group) => group.category === 'Add-ons')!
        .items.map((item) => item.name),
    ).toEqual(['Extra Rice', 'Softdrinks']);
    assertWellOrdered(result);
  });

  it('is case-insensitive about which section it was asked to move', () => {
    const result = applied(CARINDERIA, withCategoryMoved(CARINDERIA, 'add-ons', 'UP'));
    expect(groupByCategory(result)[1]!.category).toBe('Add-ons');
  });

  it('does nothing at the ends of the menu', () => {
    for (const [category, direction] of [
      ['Rice meals', 'UP'],
      ['Add-ons', 'DOWN'],
    ] as const) {
      const result = applied(CARINDERIA, withCategoryMoved(CARINDERIA, category, direction));
      expect(result.map((row) => row.id)).toEqual(CARINDERIA.map((row) => row.id));
    }
  });

  it('refuses a section that does not exist', () => {
    expect(() => withCategoryMoved(CARINDERIA, 'Lechon', 'UP')).toThrow(
      CategoryNotFoundError,
    );
  });

  it('survives being shuffled repeatedly', () => {
    // The property that matters over a real shop's afternoon of edits: every
    // reorder leaves the list dense and every section in one piece.
    let rows = CARINDERIA;
    const moves = [
      ['Add-ons', 'UP'],
      ['Rice meals', 'DOWN'],
      ['Party trays', 'UP'],
      ['Add-ons', 'DOWN'],
      ['Rice meals', 'UP'],
    ] as const;
    for (const [category, direction] of moves) {
      rows = applied(rows, withCategoryMoved(rows, category, direction));
      assertWellOrdered(rows);
      expect(rows).toHaveLength(CARINDERIA.length);
    }
  });
});

// -----------------------------------------------------------------------------
// Duplicates
// -----------------------------------------------------------------------------

describe('the same name twice', () => {
  it('refuses a repeat inside one section, however it was typed', () => {
    expect(
      findDuplicate(CARINDERIA, { name: '  extra   rice ', category: 'Add-ons' }),
    ).not.toBeNull();
  });

  it('allows the same name in two different sections', () => {
    // "Extra Rice" as an add-on and as a rice meal are two sellable things,
    // and a shop that wants both should not be argued with.
    expect(
      findDuplicate(CARINDERIA, { name: 'Extra Rice', category: 'Rice meals' }),
    ).toBeNull();
  });

  it('does not count the row being edited as its own duplicate', () => {
    expect(
      findDuplicate(CARINDERIA, {
        name: 'Extra Rice',
        category: 'Add-ons',
        exceptId: 'item_4',
      }),
    ).toBeNull();
  });
});

describe('the line above the list', () => {
  it('says something honest about an empty menu', () => {
    expect(describeMenu({ items: 0, unavailable: 0 })).toMatch(/nothing/i);
  });

  it('counts one item without the plural', () => {
    expect(describeMenu({ items: 1, unavailable: 0 })).toBe('1 item');
  });

  it('mentions what is out of stock, and only when something is', () => {
    expect(describeMenu({ items: 4, unavailable: 0 })).toBe('4 items');
    expect(describeMenu({ items: 4, unavailable: 2 })).toContain('2 out of stock');
  });
});

// -----------------------------------------------------------------------------
// The rules the screens have to keep
// -----------------------------------------------------------------------------

describe('who may edit a menu', () => {
  const actions = codeOnly('src/lib/actions/menu-actions.ts');

  it('checks a manager’s access in every single action', () => {
    const exported = [...actions.matchAll(/export async function (\w+)/g)].map(
      (match) => match[1]!,
    );
    expect(exported.length).toBeGreaterThanOrEqual(6);

    for (const name of exported) {
      const start = actions.indexOf(`export async function ${name}`);
      const next = actions.indexOf('export async function', start + 1);
      const body = actions.slice(start, next === -1 ? undefined : next);
      expect(body, `${name} does not authorise`).toContain('requireStoreAccess(');
      expect(body, `${name} does not require MANAGER`).toContain('StoreRole.MANAGER');
    }
  });

  it('leaves marking something out of stock at STAFF, where a shift needs it', () => {
    const merchant = codeOnly('src/lib/actions/merchant-actions.ts');
    const start = merchant.indexOf('export async function setItemAvailabilityAction');
    expect(start).toBeGreaterThan(-1);
    const body = merchant.slice(start, start + 900);
    expect(body).toContain('StoreRole.STAFF');
  });

  it('has only one place that can write a price', () => {
    const merchant = codeOnly('src/lib/actions/merchant-actions.ts');
    expect(merchant).not.toContain('priceCentavos');
  });

  it('rethrows anything that is not a refusal, so a bug is not swallowed', () => {
    const explain = actions.slice(actions.indexOf('function explain'));
    expect(explain).toMatch(/throw error;/);
  });
});

describe('the policy module stays usable from the browser', () => {
  it('imports nothing at all', () => {
    // The client components read the field limits from it. One `next/headers`
    // import behind this — which has happened twice in this codebase — pulls
    // the server session into the browser bundle.
    expect(codeOnly('src/lib/merchant/menu-policy.ts')).not.toMatch(/^\s*import /m);
  });
});

describe('both screens show the shop’s order', () => {
  it('never orders a menu by category name', () => {
    // This is the regression that would quietly bring alphabetical sections
    // back, and it would look like nothing but a reordered page.
    for (const file of [
      'src/app/stores/[slug]/page.tsx',
      'src/lib/merchant/menu.ts',
    ]) {
      const code = codeOnly(file);
      expect(code, file).not.toMatch(/orderBy:\s*\[\s*\{\s*category:/);
      expect(code, file).toMatch(/sortOrder:\s*'asc'/);
    }
  });

  it('groups the customer’s page with the same function as the merchant’s', () => {
    for (const file of [
      'src/app/stores/[slug]/page.tsx',
      'src/app/merchant/[storeId]/menu/page.tsx',
    ]) {
      expect(source(file), file).toContain('groupByCategory');
    }
  });
});

describe('the screens themselves', () => {
  it('asks before deleting a dish', () => {
    expect(source('src/components/merchant/MenuRow.tsx')).toContain('CONFIRM_DELETE');
  });

  it('sends the name it was showing, so a stale screen deletes nothing', () => {
    const menuModule = source('src/lib/merchant/menu.ts');
    expect(menuModule).toContain('expectedName');
    expect(menuModule).toContain('MenuItemChangedError');
  });

  it('waits for hydration before the add form can be submitted', () => {
    // A form posted before hydration runs with no request scope, so
    // `cookies()` throws and the action fails for a reason no shop owner
    // could guess from the screen.
    const form = source('src/components/merchant/MenuItemForm.tsx');
    expect(form).toContain('!hydrated');
    expect(form).toContain('<noscript>');
  });
});
