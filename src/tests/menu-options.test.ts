import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DuplicateOptionNameError,
  GroupNameRequiredError,
  ImpossibleGroupError,
  MAX_OPTION_DELTA_CENTAVOS,
  OptionDeltaNotUnderstoodError,
  OptionDeltaOutOfRangeError,
  OptionNameRequiredError,
  OptionNotOnItemError,
  OptionUnavailableError,
  TooFewChoicesError,
  TooManyChoicesError,
  describeChoices,
  describeGroupRule,
  groupIsSatisfiable,
  normaliseChoiceBounds,
  normaliseGroupName,
  normaliseOptionName,
  parseOptionDelta,
  resolveChoices,
  sameOptionText,
  unitPriceWithChoices,
  unsatisfiableGroups,
  type GroupLike,
} from '@/lib/merchant/option-policy';
import { cartLineId, countOfItem, EMPTY_CART, type Cart } from '@/lib/cart/types';
import { centavosFromPesoInput } from '@/lib/money';

/**
 * Add-ons.
 *
 * The order side of this has existed since the first schema —
 * `FoodItemSnapshot.options` stores a chosen option's name and its price at
 * order time — and there was no way for a shop to say what the choices ARE, so
 * the field could only ever be empty.
 *
 * What these tests are mostly about is the one thing that must not be wrong:
 * **the price the customer sees is the price they are charged, and neither
 * comes from their browser.** `resolveChoices` takes ids and returns prices,
 * which is why the arithmetic on the store page cannot be argued with.
 */

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function codeOnly(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
}

const SIZE: GroupLike = {
  id: 'g_size',
  name: 'Size',
  minChoices: 1,
  maxChoices: 1,
  options: [
    { id: 'o_regular', name: 'Regular', priceDeltaCentavos: 0, isAvailable: true },
    { id: 'o_large', name: 'Large', priceDeltaCentavos: 3_000, isAvailable: true },
  ],
};

const EXTRAS: GroupLike = {
  id: 'g_extras',
  name: 'Add-ons',
  minChoices: 0,
  maxChoices: 3,
  options: [
    { id: 'o_rice', name: 'Extra rice', priceDeltaCentavos: 1_500, isAvailable: true },
    { id: 'o_egg', name: 'Extra egg', priceDeltaCentavos: 2_000, isAvailable: true },
    { id: 'o_atchara', name: 'Atchara', priceDeltaCentavos: 0, isAvailable: false },
  ],
};

const MENU = [SIZE, EXTRAS];

describe('what a choice may be called and cost', () => {
  it('collapses whitespace and refuses an empty name', () => {
    expect(normaliseGroupName('  Sawsawan  ')).toBe('Sawsawan');
    expect(normaliseOptionName(' Extra   rice ')).toBe('Extra rice');
    expect(() => normaliseGroupName('   ')).toThrow(GroupNameRequiredError);
    expect(() => normaliseOptionName('')).toThrow(OptionNameRequiredError);
  });

  it('treats an empty price as adding nothing', () => {
    // The common case: a size that is simply the default.
    expect(parseOptionDelta('', centavosFromPesoInput)).toBe(0);
    expect(parseOptionDelta('   ', centavosFromPesoInput)).toBe(0);
  });

  it('reads what a shop types', () => {
    expect(parseOptionDelta('15', centavosFromPesoInput)).toBe(1_500);
    expect(parseOptionDelta('₱15.50', centavosFromPesoInput)).toBe(1_550);
    expect(parseOptionDelta('0', centavosFromPesoInput)).toBe(0);
  });

  it('refuses a price it cannot read', () => {
    expect(() => parseOptionDelta('free', centavosFromPesoInput)).toThrow(
      OptionDeltaNotUnderstoodError,
    );
  });

  it('refuses a negative price, and says what to do instead', () => {
    // "Without rice, ten pesos less" is a different dish at a different price,
    // and a shop can now add that dish in three taps. Keeping the money
    // one-directional means a line total cannot be argued down by a choice.
    try {
      parseOptionDelta('-10', centavosFromPesoInput);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OptionDeltaOutOfRangeError);
      expect((error as Error).message).toMatch(/second item/);
    }
  });

  it('refuses the same answer twice in one group', () => {
    // Two identical answers under one question are indistinguishable on a
    // kitchen printout, which is the same reason two identical dish names in
    // one section are refused.
    expect(sameOptionText(' extra   RICE ', 'Extra rice')).toBe(true);
    expect(sameOptionText('Extra rice', 'Extra egg')).toBe(false);
    expect(new DuplicateOptionNameError('Extra rice').message).toContain('Extra rice');
    // Thrown where the answers of a group are known.
    expect(codeOnly('src/lib/merchant/options.ts')).toMatch(/DuplicateOptionNameError/);
  });

  it('caps a single choice, so a typo is refused rather than charged', () => {
    expect(parseOptionDelta('2000', centavosFromPesoInput)).toBe(MAX_OPTION_DELTA_CENTAVOS);
    expect(() => parseOptionDelta('2000.01', centavosFromPesoInput)).toThrow(
      OptionDeltaOutOfRangeError,
    );
  });
});

describe('the choice bounds', () => {
  it('accepts the two shapes every real menu needs', () => {
    expect(normaliseChoiceBounds({ minChoices: 1, maxChoices: 1 })).toEqual({
      minChoices: 1,
      maxChoices: 1,
    });
    expect(normaliseChoiceBounds({ minChoices: 0, maxChoices: 5 })).toEqual({
      minChoices: 0,
      maxChoices: 5,
    });
  });

  it('allows "choose two of five", which is legal and occasionally useful', () => {
    expect(normaliseChoiceBounds({ minChoices: 2, maxChoices: 3 })).toMatchObject({
      minChoices: 2,
    });
  });

  it('refuses a group nobody could satisfy', () => {
    for (const bounds of [
      { minChoices: 2, maxChoices: 1 },
      { minChoices: -1, maxChoices: 1 },
      { minChoices: 0, maxChoices: 0 },
      { minChoices: 0, maxChoices: 99 },
      { minChoices: 1.5, maxChoices: 2 },
    ]) {
      expect(() => normaliseChoiceBounds(bounds), JSON.stringify(bounds)).toThrow(
        ImpossibleGroupError,
      );
    }
  });

  it('says what it asks for, in words', () => {
    expect(describeGroupRule({ minChoices: 1, maxChoices: 1 })).toBe('Choose one');
    expect(describeGroupRule({ minChoices: 0, maxChoices: 1 })).toBe('Choose one, or none');
    expect(describeGroupRule({ minChoices: 0, maxChoices: 3 })).toBe('Choose up to 3');
    expect(describeGroupRule({ minChoices: 2, maxChoices: 2 })).toBe('Choose 2');
    expect(describeGroupRule({ minChoices: 1, maxChoices: 3 })).toBe('Choose 1 to 3');
  });
});

describe('resolving what a customer chose', () => {
  it('prices a valid selection from the rows, in the shop’s order', () => {
    const choices = resolveChoices(MENU, ['o_egg', 'o_large', 'o_rice']);
    // Clicked in a different order; comes back in the order the shop arranged,
    // so two customers who chose the same things get identical snapshots.
    expect(choices.map((choice) => choice.name)).toEqual([
      'Large',
      'Extra rice',
      'Extra egg',
    ]);
    expect(unitPriceWithChoices(12_000, choices)).toBe(12_000 + 3_000 + 1_500 + 2_000);
  });

  it('insists on a required choice', () => {
    try {
      resolveChoices(MENU, []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TooFewChoicesError);
      expect((error as Error).message).toBe('Choose a size.');
    }
  });

  it('refuses two answers where one was asked for', () => {
    expect(() => resolveChoices(MENU, ['o_regular', 'o_large'])).toThrow(TooManyChoicesError);
  });

  it('refuses more than the group allows', () => {
    const twoOfThree: GroupLike = { ...EXTRAS, maxChoices: 1 };
    expect(() => resolveChoices([twoOfThree], ['o_rice', 'o_egg'])).toThrow(TooManyChoicesError);
  });

  it('refuses an id that is not on this dish', () => {
    // A stale page, or somebody trying another shop's option id.
    expect(() => resolveChoices(MENU, ['o_regular', 'o_from_another_shop'])).toThrow(
      OptionNotOnItemError,
    );
  });

  it('refuses an answer that has run out, by name', () => {
    try {
      resolveChoices(MENU, ['o_regular', 'o_atchara']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OptionUnavailableError);
      expect((error as Error).message).toContain('Atchara');
    }
  });

  it('ignores a repeated id rather than charging twice for it', () => {
    const choices = resolveChoices(MENU, ['o_large', 'o_large', 'o_rice']);
    expect(choices.filter((choice) => choice.name === 'Large')).toHaveLength(1);
    expect(unitPriceWithChoices(10_000, choices)).toBe(10_000 + 3_000 + 1_500);
  });

  it('adds nothing for a dish that asks nothing', () => {
    expect(unitPriceWithChoices(9_900, resolveChoices([], []))).toBe(9_900);
  });

  it('lists the choices by name for a receipt', () => {
    const choices = resolveChoices(MENU, ['o_large', 'o_rice']);
    expect(describeChoices(choices)).toBe('Large, Extra rice');
  });
});

describe('a dish nobody can order', () => {
  it('spots a required group whose answers have all run out', () => {
    const stuck: GroupLike = {
      ...SIZE,
      options: SIZE.options.map((option) => ({ ...option, isAvailable: false })),
    };
    expect(groupIsSatisfiable(stuck)).toBe(false);
    expect(unsatisfiableGroups([stuck, EXTRAS])).toHaveLength(1);
  });

  it('does not complain about an optional group that is empty', () => {
    expect(groupIsSatisfiable({ ...EXTRAS, options: [] })).toBe(true);
  });

  it('is surfaced on the shop’s own screen', () => {
    // The one mistake here that a customer meets as a dead end.
    const page = source('src/app/merchant/[storeId]/menu/[itemId]/options/page.tsx');
    expect(page).toContain('unsatisfiableGroups');
    expect(page).toMatch(/Nobody can order this/);
  });
});

describe('the cart', () => {
  it('makes a line out of the dish and its choices', () => {
    expect(cartLineId('item_1', ['b', 'a'])).toBe('item_1|a|b');
  });

  it('is the same line whatever order the choices were clicked', () => {
    expect(cartLineId('item_1', ['a', 'b'])).toBe(cartLineId('item_1', ['b', 'a']));
  });

  it('is a different line for different choices', () => {
    expect(cartLineId('item_1', ['a'])).not.toBe(cartLineId('item_1', ['b']));
    expect(cartLineId('item_1', [])).not.toBe(cartLineId('item_1', ['a']));
  });

  it('counts one dish across every set of choices', () => {
    const cart: Cart = {
      ...EMPTY_CART,
      storeId: 'store_1',
      lines: [
        { lineId: cartLineId('item_1', ['a']), menuItemId: 'item_1', optionIds: ['a'], quantity: 2 },
        { lineId: cartLineId('item_1', ['b']), menuItemId: 'item_1', optionIds: ['b'], quantity: 1 },
        { lineId: cartLineId('item_2', []), menuItemId: 'item_2', optionIds: [], quantity: 5 },
      ],
    };
    expect(countOfItem(cart, 'item_1')).toBe(3);
    expect(countOfItem(cart, 'item_2')).toBe(5);
    expect(countOfItem(cart, 'item_3')).toBe(0);
  });

  it('keeps a cart stored before dishes had choices', () => {
    // Emptying somebody's basket to ship a schema change is not a trade worth
    // making, and those lines meant exactly "no choices".
    const provider = codeOnly('src/components/cart/CartProvider.tsx');
    expect(provider).toMatch(/Array\.isArray\(line\.optionIds\)/);
    expect(provider).toMatch(/cartLineId\(line\.menuItemId, optionIds\)/);
  });

  it('carries no prices, only ids', () => {
    const types = codeOnly('src/lib/cart/types.ts');
    expect(types).not.toMatch(/[Pp]riceCentavos/);
    expect(types).not.toMatch(/priceDelta/);
  });

  it('brands a line id, so it cannot be confused with a dish id', () => {
    // Both are strings: `setQuantity(menuItemId, 2)` — which is what every one
    // of these controls did before dishes had choices — compiles perfectly and
    // moves the wrong line. The brand turns that into a compile error.
    const types = source('src/lib/cart/types.ts');
    expect(types).toMatch(/export type CartLineId/);
    const provider = codeOnly('src/components/cart/CartProvider.tsx');
    expect(provider).toMatch(/setQuantity: \(lineId: CartLineId/);
  });
});

describe('the price is decided on the server', () => {
  const placement = codeOnly('src/lib/orders/place-order.ts');

  it('takes ids from the client and never a price', () => {
    const input = placement.slice(
      placement.indexOf('export interface CartLineInput'),
      placement.indexOf('export interface CheckoutInput'),
    );
    expect(input).toMatch(/optionIds\?: readonly string\[\]/);
    expect(input).not.toMatch(/[Cc]entavos/);
  });

  it('resolves every choice against the dish’s own rows', () => {
    expect(placement).toMatch(/resolveChoices\(item\.optionGroups/);
    expect(placement).toMatch(/unitPriceWithChoices\(item\.priceCentavos/);
  });

  it('reads the options through the menu item, not by id', () => {
    // An option id belonging to another dish — or another shop — is simply not
    // in the result, so it is refused rather than priced.
    const query = placement.slice(placement.indexOf('const menuItems ='));
    expect(query.slice(0, 500)).toMatch(/storeId: store\.id/);
    expect(query.slice(0, 500)).toMatch(/optionGroups/);
  });

  it('multiplies the whole unit price, choices included', () => {
    expect(placement).toMatch(/lineTotalCentavos: unitPriceCentavos \* quantity/);
  });

  it('snapshots the names and the deltas onto the order', () => {
    // A receipt has to survive the shop renaming or repricing the option
    // tomorrow, which is what the snapshot is for.
    expect(placement).toMatch(/options: choices\.map/);
    expect(placement).toMatch(/priceDeltaCentavos: choice\.priceDeltaCentavos/);
  });
});

describe('who may declare a choice', () => {
  const actions = codeOnly('src/lib/actions/option-actions.ts');

  function body(name: string): string {
    const start = actions.indexOf(`export async function ${name}`);
    expect(start, name).toBeGreaterThan(-1);
    const next = actions.indexOf('export async function', start + 1);
    return actions.slice(start, next === -1 ? undefined : next);
  }

  it('needs a manager for everything that changes what is sold', () => {
    for (const name of [
      'addOptionGroupAction',
      'editOptionGroupAction',
      'removeOptionGroupAction',
      'moveOptionGroupAction',
      'addOptionAction',
      'editOptionAction',
      'removeOptionAction',
      'moveOptionAction',
    ]) {
      expect(body(name), name).toContain('StoreRole.MANAGER');
    }
  });

  it('leaves "we have run out of that" to staff', () => {
    // The sauce running out at eight is the same kind of decision as the pork
    // running out at lunch.
    expect(body('setOptionAvailabilityAction')).toContain('StoreRole.STAFF');
  });

  it('authorises through the store on every action', () => {
    const exported = [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(exported.length).toBeGreaterThanOrEqual(9);
    for (const name of exported) {
      expect(body(name), name).toContain('requireStoreAccess(');
    }
  });

  it('rethrows anything that is not a refusal', () => {
    const explain = actions.slice(actions.indexOf('function explain'));
    expect(explain).toMatch(/throw error;/);
  });

  it('scopes every lookup through the store, never by bare id', () => {
    const data = codeOnly('src/lib/merchant/options.ts');
    // A group or option id from another shop has to resolve to nothing.
    expect(data).toMatch(/menuItem: \{ storeId/);
    expect(data).toMatch(/group: \{ menuItem: \{ storeId/);
  });
});

describe('the screens', () => {
  it('keeps one-tap Add for a dish that asks nothing', () => {
    // Most of a carinderia menu. It should not get slower because some other
    // dish has sizes.
    const controls = source('src/components/cart/AddToCartControls.tsx');
    expect(controls).toMatch(/groups\.length > 0/);
  });

  it('uses a radio for one answer and a checkbox for several', () => {
    const controls = codeOnly('src/components/cart/AddToCartControls.tsx');
    expect(controls).toMatch(/group\.maxChoices === 1 \? 'radio' : 'checkbox'/);
  });

  it('will not add a selection the rules refuse', () => {
    const controls = codeOnly('src/components/cart/AddToCartControls.tsx');
    expect(controls).toMatch(/disabled=\{problem !== null\}/);
  });

  it('shows the customer what they chose at checkout', () => {
    expect(source('src/components/cart/CheckoutForm.tsx')).toMatch(/describeChoices\(item\.options\)/);
  });

  it('links to the choices from the menu row, with a count', () => {
    expect(source('src/components/merchant/MenuRow.tsx')).toMatch(/options`}/);
    expect(source('src/components/merchant/MenuRow.tsx')).toMatch(/Choices \(\$\{/);
  });
});
