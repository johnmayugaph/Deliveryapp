import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORGOTTEN_AFTER_DAYS,
  UNSELLABLE_REASONS,
  daysOut,
  describeStock,
  itemStock,
  menuStock,
  outFor,
  outForPhrase,
  stockWarnings,
  type StockItemLike,
  type UnsellableReason,
} from '@/lib/merchant/menu-stock';

/**
 * What on a menu a customer cannot order, and for how long.
 *
 * The tests that matter are the ones that stop this screen calling a dish
 * sellable when checkout would refuse it, and the ones that keep the shop's own
 * deliberate switch from being reported as a fault.
 */

const NOW = new Date('2026-09-09T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function item(overrides: Partial<StockItemLike> = {}): StockItemLike {
  return {
    id: 'i1',
    name: 'Adobong Manok',
    isAvailable: true,
    outOfStockSince: null,
    unsatisfiableGroupNames: [],
    ...overrides,
  };
}

const ALL_REASONS = Object.keys(UNSELLABLE_REASONS) as UnsellableReason[];

describe('the reason map', () => {
  it('says something on the row and something in the summary, for each', () => {
    for (const reason of ALL_REASONS) {
      const copy = UNSELLABLE_REASONS[reason];
      expect(copy.badge.trim().length, reason).toBeGreaterThan(3);
      expect(copy.detail.trim().length, reason).toBeGreaterThan(10);
    }
  });

  it('marks the shop’s own switch as theirs, and the choice failure as not', () => {
    // The distinction the whole screen turns on: one is a decision somebody
    // made at eight in the evening, the other is a surprise.
    expect(UNSELLABLE_REASONS.MARKED_OUT.isTheShopsChoice).toBe(true);
    expect(UNSELLABLE_REASONS.CHOICES_RUN_OUT.isTheShopsChoice).toBe(false);
  });
});

describe('a dish that is fine', () => {
  it('is sellable, with nothing to report', () => {
    const state = itemStock(item(), NOW);
    expect(state.sellable).toBe(true);
    expect(state.reason).toBeNull();
    expect(state.phrase).toBeNull();
    expect(state.blockedByGroups).toEqual([]);
  });
});

describe('a dish the shop marked out', () => {
  it('is not sellable, and says since when', () => {
    const state = itemStock(
      item({ isAvailable: false, outOfStockSince: ago(3 * day) }),
      NOW,
    );
    expect(state.sellable).toBe(false);
    expect(state.reason).toBe('MARKED_OUT');
    expect(state.outFor).toBe('DAYS');
    expect(state.phrase).toBe('3 days');
  });

  it('says “since today” on the night it happened', () => {
    const state = itemStock(
      item({ isAvailable: false, outOfStockSince: ago(4 * 60 * 60 * 1000) }),
      NOW,
    );
    expect(state.outFor).toBe('TONIGHT');
    expect(state.phrase).toBe('since today');
  });

  it('admits it does not know when, rather than guessing “just now”', () => {
    /**
     * Rows that were already out of stock when the column was added have no
     * honest answer. The migration deliberately does not backfill `now()`,
     * which would have claimed every one of them went out at deploy time.
     */
    const state = itemStock(item({ isAvailable: false, outOfStockSince: null }), NOW);
    expect(state.outFor).toBe('UNKNOWN');
    expect(state.phrase).toBeNull();
    expect(state.sellable).toBe(false);
  });

  it('reads as forgotten past a fortnight, in weeks rather than days', () => {
    // Nobody decides to stop selling adobo for three weeks. Past a point this
    // is not stock, it is a menu that needs editing.
    const state = itemStock(
      item({ isAvailable: false, outOfStockSince: ago(21 * day) }),
      NOW,
    );
    expect(state.outFor).toBe('FORGOTTEN');
    expect(state.phrase).toBe('3 weeks');
  });

  it('crosses each boundary exactly where it says it does', () => {
    const since = (days: number) => ago(days * day);
    expect(outFor(ago(23 * 60 * 60 * 1000), NOW)).toBe('TONIGHT');
    expect(outFor(since(1), NOW)).toBe('DAYS');
    expect(outFor(since(FORGOTTEN_AFTER_DAYS - 1), NOW)).toBe('DAYS');
    expect(outFor(since(FORGOTTEN_AFTER_DAYS), NOW)).toBe('FORGOTTEN');
  });

  it('never counts a day that has not passed', () => {
    // A clock that has drifted backwards must not produce "-1 days".
    expect(daysOut(new Date(NOW.getTime() + day), NOW)).toBe(0);
    expect(outForPhrase(new Date(NOW.getTime() + day), NOW)).toBe('since today');
  });
});

describe('a dish in stock that cannot be ordered', () => {
  it('is not sellable, and names the choice that ran out', () => {
    /**
     * The silent one. `groupIsSatisfiable` has always known this, and it was
     * rendered only on the per-dish options sub-page — one tap deeper than the
     * list, behind a link a shop opens on purpose. On the list the dish read
     * "In stock" in emerald.
     */
    const state = itemStock(item({ unsatisfiableGroupNames: ['Size'] }), NOW);
    expect(state.sellable).toBe(false);
    expect(state.reason).toBe('CHOICES_RUN_OUT');
    expect(state.blockedByGroups).toEqual(['Size']);
  });

  it('names them rather than counting them', () => {
    // "Size has run out" is actionable; "1 choice has run out" is a puzzle.
    const state = itemStock(
      item({ unsatisfiableGroupNames: ['Size', 'Sawsawan'] }),
      NOW,
    );
    expect(state.blockedByGroups).toEqual(['Size', 'Sawsawan']);
  });
});

describe('when both apply', () => {
  it('reports the shop’s own switch, not the add-on problem', () => {
    // The switch is the fact they acted on and will act on again. Telling them
    // a dish they deliberately took off also has an add-on problem is noise
    // until they put it back.
    const state = itemStock(
      item({
        isAvailable: false,
        outOfStockSince: ago(2 * day),
        unsatisfiableGroupNames: ['Size'],
      }),
      NOW,
    );
    expect(state.reason).toBe('MARKED_OUT');
    expect(state.blockedByGroups).toEqual([]);
  });
});

describe('the menu as a whole', () => {
  const menu: StockItemLike[] = [
    item({ id: 'ok1' }),
    item({ id: 'ok2', name: 'Sinigang' }),
    item({ id: 'out', name: 'Lechon', isAvailable: false, outOfStockSince: ago(2 * day) }),
    item({
      id: 'old',
      name: 'Pancit',
      isAvailable: false,
      outOfStockSince: ago(30 * day),
    }),
    item({ id: 'stuck', name: 'Halo-halo', unsatisfiableGroupNames: ['Size'] }),
  ];

  it('counts what a customer could order, not how many rows exist', () => {
    const stock = menuStock(menu, NOW);
    expect(stock.sellable).toBe(2);
    expect(stock.markedOut).toBe(2);
    expect(stock.forgotten).toBe(1);
    expect(stock.choicesRunOut).toBe(1);
    // Every row is accounted for exactly once.
    expect(stock.sellable + stock.markedOut + stock.choicesRunOut).toBe(menu.length);
  });

  it('leads the summary with orderable rather than with a row count', () => {
    /**
     * The old line read "11 items · 4 out of stock". It counted rows and said
     * nothing at all about a dish that was in stock and unorderable, which is
     * the case that costs the shop an order without looking like anything.
     */
    const line = describeStock(menuStock(menu, NOW), menu.length);
    expect(line).toBe('2 of 5 orderable · 2 out of stock · 1 blocked by a missing choice');
  });

  it('says nothing but the count when everything is sellable', () => {
    const fine = [item({ id: 'a' }), item({ id: 'b' })];
    expect(describeStock(menuStock(fine, NOW), 2)).toBe('2 of 2 orderable');
  });

  it('handles an empty menu without inventing a number', () => {
    expect(describeStock(menuStock([], NOW), 0)).toBe('Nothing on the menu yet');
  });

  it('pluralises the blocked count without saying “a choices”', () => {
    // The first draft did exactly that.
    const two = [
      item({ id: 'x', unsatisfiableGroupNames: ['Size'] }),
      item({ id: 'y', unsatisfiableGroupNames: ['Sawsawan'] }),
    ];
    const line = describeStock(menuStock(two, NOW), 2);
    expect(line).toContain('2 blocked by missing choices');
    expect(line).not.toContain('a choices');
  });
});

describe('what is worth warning about', () => {
  it('says nothing about an ordinary busy night', () => {
    /**
     * A kitchen knows what it marked out an hour ago. A warning strip about it
     * is noise, and noise is what gets ignored on the night something else is
     * wrong.
     */
    const tonight = [
      item({ id: 'a' }),
      item({ id: 'b', isAvailable: false, outOfStockSince: ago(2 * 60 * 60 * 1000) }),
    ];
    expect(stockWarnings(menuStock(tonight, NOW))).toEqual([]);
  });

  it('warns about a dish nobody can order, first', () => {
    const menu = [
      item({ id: 'stuck', unsatisfiableGroupNames: ['Size'] }),
      item({ id: 'old', isAvailable: false, outOfStockSince: ago(40 * day) }),
    ];
    const warnings = stockWarnings(menuStock(menu, NOW));
    expect(warnings.map((w) => w.reason)).toEqual(['CHOICES_RUN_OUT', 'MARKED_OUT']);
    expect(warnings[0]!.line).toMatch(/cannot be ordered/);
  });

  it('warns about a dish out for a fortnight, and says what to do', () => {
    const menu = [item({ id: 'old', isAvailable: false, outOfStockSince: ago(20 * day) })];
    const [warning] = stockWarnings(menuStock(menu, NOW));
    expect(warning!.reason).toBe('MARKED_OUT');
    expect(warning!.line).toMatch(/Put it back, or take it off the menu/);
    expect(warning!.line).toContain(String(FORGOTTEN_AFTER_DAYS));
  });

  it('counts in words for one and in numbers for several', () => {
    const one = [item({ id: 'a', unsatisfiableGroupNames: ['Size'] })];
    expect(stockWarnings(menuStock(one, NOW))[0]!.line).toMatch(/^One dish/);
    const two = [
      item({ id: 'a', unsatisfiableGroupNames: ['Size'] }),
      item({ id: 'b', unsatisfiableGroupNames: ['Size'] }),
    ];
    expect(stockWarnings(menuStock(two, NOW))[0]!.line).toMatch(/^2 dishes/);
  });

  it('never warns about a state no facts can produce', () => {
    // Dead copy is what rots into a false claim once the rule around it moves.
    const reasons = new Set<UnsellableReason>();
    const cases: StockItemLike[][] = [
      [item({ id: 'a', unsatisfiableGroupNames: ['Size'] })],
      [item({ id: 'b', isAvailable: false, outOfStockSince: ago(40 * day) })],
    ];
    for (const menu of cases) {
      for (const warning of stockWarnings(menuStock(menu, NOW))) {
        reasons.add(warning.reason);
      }
    }
    expect([...reasons].sort()).toEqual([...ALL_REASONS].sort());
  });
});

// --- The rules this claims to mirror ------------------------------------

describe('it mirrors what checkout actually refuses', () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
  /**
   * Comments come out first.
   *
   * The first version of the next test matched the whole file and passed
   * against a mutant that had deleted the import and inlined the comparison —
   * because the doc comment beside it still contains the word
   * `unsatisfiableGroups`, explaining why the call is there. A check that
   * matches its own prose cannot fail.
   */
  const codeOnly = (file: string) =>
    read(file)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

  it('uses the writer’s own satisfiability rule rather than restating it', () => {
    /**
     * The count of available options against `minChoices` lives in
     * `option-policy.ts` and is what checkout applies. A second copy of that
     * comparison anywhere is a second thing that can disagree with the
     * refusal, and the copy on this screen is the one nobody would notice was
     * wrong.
     */
    // The rule module never sees the number at all.
    expect(codeOnly('src/lib/merchant/menu-stock.ts')).not.toMatch(/minChoices/);
    // The loader has to SELECT it — `GroupLike` needs it — but must never be
    // the thing that compares against it. That is the mutant that survived.
    const loader = codeOnly('src/lib/merchant/menu.ts');
    expect(loader).toMatch(/unsatisfiableGroups\(item\.optionGroups\)/);
    expect(loader).not.toMatch(/[<>=]=?\s*group\.minChoices/);
    expect(loader).not.toMatch(/group\.minChoices\s*[<>=]/);
  });

  it('clears the timestamp when a dish comes back, rather than leaving it', () => {
    /**
     * `undefined` in a Prisma `data` block means "do not change this column",
     * so writing it here would leave a stale `outOfStockSince` on an available
     * dish — and the next time that dish went out it would read as weeks old.
     * A mutant that made exactly that swap survived every other check here.
     * The live-database round proves the behaviour; this pins the shape.
     */
    const code = codeOnly('src/lib/merchant/menu.ts');
    expect(code).toMatch(/outOfStockSince: input\.isAvailable \? null : now/);
    expect(code).not.toMatch(/outOfStockSince: input\.isAvailable \? undefined/);
    // And the bulk restore clears it too, or one tap would strand every row.
    expect(code).toMatch(/isAvailable: true, outOfStockSince: null/);
  });

  it('leaves the row write to menu.ts rather than doing it in the action', () => {
    /**
     * The reason the timestamp can be trusted at all: one writer, so there is
     * one place that can forget it. The action used to `updateMany` the flag
     * itself, which was harmless while there was no timestamp beside it.
     *
     * Scoped to `prisma.menuItem` writes rather than to the word
     * `isAvailable`, because the first version of this swept for the word and
     * failed on the loader's own SELECT — a check that flagged reading a
     * column as writing it.
     */
    const action = codeOnly('src/lib/actions/merchant-actions.ts');
    expect(action).toMatch(/setItemStock\(\{/);
    expect(action).not.toMatch(/prisma\.menuItem\.(update|updateMany|create)/);
  });

  it('is what the storefront panel counts, so it cannot overstate', () => {
    /**
     * That panel said "Customers can order now" for a shop whose every dish
     * was blocked by a missing choice, because it counted `isAvailable`. The
     * live-database round proves the count; this stops the sellable figure
     * quietly having the blocked ones added back to it.
     */
    const loader = codeOnly('src/lib/merchant/storefront.ts');
    expect(loader).toMatch(/sellableMenuItems: menu\.stock\.sellable,/);
    expect(loader).not.toMatch(/isAvailable/);
  });
});

describe('what the row actually renders', () => {
  const row = readFileSync(
    path.join(process.cwd(), 'src/components/merchant/MenuRow.tsx'),
    'utf8',
  );
  const code = row.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  it('takes the badge from the rule rather than reading the flag', () => {
    expect(code).toMatch(/UNSELLABLE_REASONS\[item\.stock\.reason\]/);
    // The line it replaced was `item.isAvailable ? null : <span>Wala ngayon`,
    // which could say nothing about a dish that was in stock and unorderable.
    expect(code).not.toMatch(/Wala ngayon/);
  });

  it('offers the route to the fix without a manager’s access', () => {
    /**
     * Found in a browser. A staff member saw "Cannot be ordered · Size has run
     * out", is allowed to put an option back — `setOptionAvailabilityAction`
     * takes STAFF, like the switch on this row — and had no way to reach the
     * screen: the only link to it sat inside the manager-only block. The
     * obvious thing to tap instead was the green "In stock" button, which
     * would have marked the whole dish out.
     */
    const options = readFileSync(
      path.join(process.cwd(), 'src/lib/actions/option-actions.ts'),
      'utf8',
    );
    // The claim rests on staff really being able to clear it.
    expect(options).toMatch(
      /setOptionAvailabilityAction[\s\S]{0,600}StoreRole\.STAFF/,
    );
    const blocked = code.slice(code.indexOf('blockedByGroups.length > 0'));
    const upToManagerBlock = blocked.slice(0, blocked.indexOf('canEdit'));
    expect(upToManagerBlock).toMatch(/menu\/\$\{item\.id\}\/options/);
  });
});
