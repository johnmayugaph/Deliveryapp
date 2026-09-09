import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ServiceKey } from '@prisma/client';
import { BACK_OFFICE_AREAS } from '@/lib/merchant/roles';
import {
  STOREFRONT_BLOCKERS,
  blockersOnlyTaraCanClear,
  blockersTheShopCanClear,
  clearedBy,
  needsSupport,
  screenToOpen,
  shellAlert,
  storefrontState,
  type StorefrontBlocker,
  type StorefrontFacts,
  type StorefrontServiceFacts,
} from '@/lib/merchant/storefront-policy';

/**
 * Whether a customer can order from this shop, and what is stopping it.
 *
 * The tests worth having are the ones that stop this panel lying in either
 * direction: telling a shop it is fine when the ordering path refuses it, and
 * telling a shop something is broken when it simply closed for the night.
 */

const LIVE_FOOD: StorefrontServiceFacts = {
  key: ServiceKey.FOOD,
  displayName: 'Food',
  isActive: true,
  liveInThisCity: true,
  hasDeliveryPricing: true,
};

function facts(overrides: Partial<StorefrontFacts> = {}): StorefrontFacts {
  return {
    isVisible: true,
    isOpen: true,
    cityName: 'Baguio',
    services: [LIVE_FOOD],
    sellableMenuItems: 12,
    ...overrides,
  };
}

const ALL_BLOCKERS = Object.keys(STOREFRONT_BLOCKERS) as StorefrontBlocker[];

describe('the blocker map', () => {
  it('says something actionable for every reason', () => {
    for (const blocker of ALL_BLOCKERS) {
      const copy = STOREFRONT_BLOCKERS[blocker];
      expect(copy.title.trim().length, blocker).toBeGreaterThan(10);
      expect(copy.detail.trim(), blocker).toMatch(/\.$/);
      expect(['THE_SHOP', 'TARA'], blocker).toContain(clearedBy(blocker));
    }
  });

  it('points at support for exactly the ones the shop cannot clear', () => {
    /**
     * The half of this that matters. A shop told to "put a dish back on" can
     * fix it in two taps; a shop told the same about its visibility being
     * withdrawn would tap around for an hour and find nothing, because there
     * is no merchant control for it and there should not be.
     */
    for (const blocker of ALL_BLOCKERS) {
      const copy = STOREFRONT_BLOCKERS[blocker];
      if (clearedBy(blocker) === 'TARA') {
        expect(copy.detail, blocker).toMatch(/support|will be listed/i);
        // And never names a control the shop does not have.
        expect(copy.detail, blocker).not.toMatch(/^Tap /);
      } else {
        // Names a control or a tab the shop actually has, rather than a fix.
        expect(copy.detail, blocker).toMatch(/Tap|Menu tab/);
        expect(copy.detail, blocker).not.toMatch(/support/i);
      }
    }
  });

  it('derives who clears it from where the fix is, not a second field', () => {
    // Two fields that had to agree is two fields that could disagree, and the
    // one that would have been wrong is the one sending a shop to support
    // about its own switch.
    for (const blocker of ALL_BLOCKERS) {
      const { fix } = STOREFRONT_BLOCKERS[blocker];
      const expected =
        fix.kind === 'SWITCH' || fix.kind === 'SCREEN' ? 'THE_SHOP' : 'TARA';
      expect(clearedBy(blocker), blocker).toBe(expected);
    }
  });

  it('points a screen fix at a screen that exists, by its tab name', () => {
    for (const blocker of ALL_BLOCKERS) {
      const { fix } = STOREFRONT_BLOCKERS[blocker];
      if (fix.kind !== 'SCREEN') continue;
      expect(
        existsSync(
          path.join(process.cwd(), 'src/app/merchant/[storeId]', fix.path, 'page.tsx'),
        ),
        `${blocker} points at /${fix.path}, which has no page`,
      ).toBe(true);
      // The button reads "Open <tab>", so the tab name has to be the one on
      // the tab bar rather than a second name for the same screen.
      expect(BACK_OFFICE_AREAS.map((area) => area.tab), blocker).toContain(fix.tab);
    }
  });

  it('marks as hiding the shop only the reasons the listings filter on', () => {
    // `isVisible` and the city gate drop the store out of every listing and
    // out of search. The rest let a customer arrive and then fail, which is a
    // different conversation with support and a different one with a regular.
    const hides = ALL_BLOCKERS.filter((b) => STOREFRONT_BLOCKERS[b].hidesTheShop);
    expect(hides.sort()).toEqual([
      'HIDDEN_BY_TARA',
      'NO_SERVICE_ASSIGNED',
      'SERVICE_NOT_LIVE_HERE',
    ]);
  });
});

describe('a shop that is fine', () => {
  it('is orderable, listed, and has nothing to report', () => {
    const state = storefrontState(facts());
    expect(state.orderable).toBe(true);
    expect(state.readyWhenOpen).toBe(true);
    expect(state.listed).toBe(true);
    expect(state.blockers).toEqual([]);
    expect(state.cityName).toBe('Baguio');
  });

  it('reports its one service as bringing orders', () => {
    const [service] = storefrontState(facts()).services;
    expect(service!.standing).toBe('ORDERABLE');
    expect(service!.bringsOrders).toBe(true);
  });
});

describe('closed is not broken', () => {
  it('is not orderable, but is ready the moment it opens', () => {
    /**
     * The distinction the whole panel turns on. A kitchen that closed at 10pm
     * on purpose must not be shown a fault, and a kitchen that is open and
     * still getting nothing must not be shown reassurance.
     */
    const state = storefrontState(facts({ isOpen: false }));
    expect(state.orderable).toBe(false);
    expect(state.readyWhenOpen).toBe(true);
    expect(state.listed).toBe(true);
    expect(state.blockers).toEqual(['CLOSED_BY_THE_SHOP']);
  });

  it('offers no screen and no support for a shop that merely closed', () => {
    /**
     * Both found in a browser. With "the shop can clear this" as the only
     * distinction, a shop closed for the night was given a chip reading
     * "Yours to fix" — a fault it had not committed — and a button reading
     * "Open the menu", which is not where the switch is. The switch is in the
     * header of this very screen, so the right number of links is none.
     */
    const state = storefrontState(facts({ isOpen: false }));
    expect(screenToOpen(state)).toBeNull();
    expect(needsSupport(state)).toBe(false);
    expect(STOREFRONT_BLOCKERS.CLOSED_BY_THE_SHOP.fix.kind).toBe('SWITCH');
    // And it is still the shop's own doing, not TARA's.
    expect(blockersTheShopCanClear(state)).toEqual(['CLOSED_BY_THE_SHOP']);
  });

  it('is not ready-when-open once something else is wrong too', () => {
    const state = storefrontState(facts({ isOpen: false, sellableMenuItems: 0 }));
    expect(state.readyWhenOpen).toBe(false);
    expect(state.blockers).toEqual(['NOTHING_ON_THE_MENU', 'CLOSED_BY_THE_SHOP']);
  });
});

describe('hidden by TARA', () => {
  it('is reported first, and as something only TARA can undo', () => {
    // The case that started this: emerald "Bukas" in the header, an open
    // kitchen, no orders, and nothing anywhere in the shop's app about it.
    const state = storefrontState(facts({ isVisible: false }));
    expect(state.blockers[0]).toBe('HIDDEN_BY_TARA');
    expect(state.listed).toBe(false);
    expect(state.orderable).toBe(false);
    expect(state.readyWhenOpen).toBe(false);
    expect(blockersTheShopCanClear(state)).toEqual([]);
    expect(blockersOnlyTaraCanClear(state)).toEqual(['HIDDEN_BY_TARA']);
  });

  it('is reported even while the shop is also closed and empty', () => {
    // Whichever the shop fixes, it still will not be found. Reporting only the
    // shop's own faults here would send them round in circles.
    const state = storefrontState(
      facts({ isVisible: false, isOpen: false, sellableMenuItems: 0 }),
    );
    expect(state.blockers).toEqual([
      'HIDDEN_BY_TARA',
      'NOTHING_ON_THE_MENU',
      'CLOSED_BY_THE_SHOP',
    ]);
  });
});

describe('the service gates', () => {
  it('reports no service at all as TARA’s to fix', () => {
    const state = storefrontState(facts({ services: [] }));
    expect(state.blockers).toContain('NO_SERVICE_ASSIGNED');
    expect(state.listed).toBe(false);
    expect(blockersTheShopCanClear(state)).toEqual([]);
  });

  it('separates “not live anywhere” from “not live here”', () => {
    /**
     * `isActive` and orderable-in-this-city are different questions, and the
     * settings screen used to render the first while implying the second: a
     * Manila shop was told MART was "Live" when MART was live only in Cebu.
     */
    const comingSoon = storefrontState(
      facts({
        services: [{ ...LIVE_FOOD, isActive: false, liveInThisCity: false }],
      }),
    );
    expect(comingSoon.services[0]!.standing).toBe('COMING_SOON');

    const elsewhere = storefrontState(
      facts({ services: [{ ...LIVE_FOOD, liveInThisCity: false }] }),
    );
    expect(elsewhere.services[0]!.standing).toBe('NOT_HERE_YET');

    // Both are the same blocker for the shop — it is not listed — but the
    // badge on the service says which, because "coming soon" is a promise to
    // everybody and "not here yet" is a promise to them.
    for (const state of [comingSoon, elsewhere]) {
      expect(state.blockers).toContain('SERVICE_NOT_LIVE_HERE');
      expect(state.services[0]!.bringsOrders).toBe(false);
    }
  });

  it('reports missing delivery pricing only once the service is live here', () => {
    const notHere = storefrontState(
      facts({
        services: [
          { ...LIVE_FOOD, liveInThisCity: false, hasDeliveryPricing: false },
        ],
      }),
    );
    // One clear sentence, not two: an unlaunched service has no reason to be
    // priced yet, and saying both would read as two separate problems.
    expect(notHere.blockers).toEqual(['SERVICE_NOT_LIVE_HERE']);

    const unpriced = storefrontState(
      facts({ services: [{ ...LIVE_FOOD, hasDeliveryPricing: false }] }),
    );
    expect(unpriced.blockers).toEqual(['NO_DELIVERY_PRICING']);
    expect(unpriced.services[0]!.standing).toBe('NO_PRICING');
    // Customers can still find the shop, which is why they turn up confused.
    expect(unpriced.listed).toBe(true);
  });

  it('is satisfied by one working service out of several', () => {
    const state = storefrontState(
      facts({
        services: [
          { ...LIVE_FOOD, key: ServiceKey.MART, liveInThisCity: false },
          LIVE_FOOD,
        ],
      }),
    );
    expect(state.blockers).toEqual([]);
    expect(state.orderable).toBe(true);
    // And the one that brings nothing still says so on its own row.
    expect(state.services.map((s) => s.bringsOrders)).toEqual([false, true]);
  });
});

describe('an empty menu', () => {
  it('is the shop’s own to clear, and does not hide them', () => {
    const state = storefrontState(facts({ sellableMenuItems: 0 }));
    expect(state.blockers).toEqual(['NOTHING_ON_THE_MENU']);
    expect(state.listed).toBe(true);
    expect(blockersTheShopCanClear(state)).toEqual(['NOTHING_ON_THE_MENU']);
    expect(blockersOnlyTaraCanClear(state)).toEqual([]);
  });
});

describe('every blocker is reachable, and reported in one order', () => {
  it('can be produced by some real combination of facts', () => {
    // A reason that no facts can produce is dead copy, and dead copy is what
    // rots into a false promise the day the gate around it moves.
    const seen = new Set<StorefrontBlocker>();
    const cases: StorefrontFacts[] = [
      facts({ isVisible: false }),
      facts({ services: [] }),
      facts({ services: [{ ...LIVE_FOOD, liveInThisCity: false }] }),
      facts({ services: [{ ...LIVE_FOOD, hasDeliveryPricing: false }] }),
      facts({ sellableMenuItems: 0 }),
      facts({ isOpen: false }),
    ];
    for (const input of cases) {
      for (const blocker of storefrontState(input).blockers) seen.add(blocker);
    }
    expect([...seen].sort()).toEqual([...ALL_BLOCKERS].sort());
  });

  it('never reports the same reason twice, and always in the fixed order', () => {
    const state = storefrontState(
      facts({ isVisible: false, isOpen: false, sellableMenuItems: 0, services: [] }),
    );
    expect(new Set(state.blockers).size).toBe(state.blockers.length);
    // Invisible-making reasons before checkout-breaking ones, and the shop's
    // own switch last: the top line is the one worth acting on.
    const hides = state.blockers.map((b) => STOREFRONT_BLOCKERS[b].hidesTheShop);
    expect(hides).toEqual([...hides].sort((a, b) => Number(b) - Number(a)));
    expect(state.blockers.at(-1)).toBe('CLOSED_BY_THE_SHOP');
  });

  it('offers the menu and support together when both apply', () => {
    const state = storefrontState(facts({ isVisible: false, sellableMenuItems: 0 }));
    expect(screenToOpen(state)).toEqual({ tab: 'Menu', path: 'menu' });
    expect(needsSupport(state)).toBe(true);
  });

  it('offers nothing at all when only TARA’s own launch is pending', () => {
    // Nobody's job. A "message support" button here would generate a ticket
    // whose answer is "yes, we know, we have not launched there".
    const state = storefrontState(
      facts({ services: [{ ...LIVE_FOOD, liveInThisCity: false }] }),
    );
    expect(screenToOpen(state)).toBeNull();
    expect(needsSupport(state)).toBe(false);
    expect(STOREFRONT_BLOCKERS.SERVICE_NOT_LIVE_HERE.fix.kind).toBe('WAIT');
  });

  it('splits every reported blocker between the shop and TARA, losing none', () => {
    const state = storefrontState(
      facts({ isVisible: false, isOpen: false, sellableMenuItems: 0 }),
    );
    expect(
      [...blockersOnlyTaraCanClear(state), ...blockersTheShopCanClear(state)].sort(),
    ).toEqual([...state.blockers].sort());
  });
});

// --- The gates this claims to mirror -------------------------------------

describe('it mirrors the gates the customer path actually applies', () => {
  const read = (file: string) =>
    readFileSync(path.join(process.cwd(), file), 'utf8');

  it('covers every store field checkout refuses on', () => {
    /**
     * `quoteCheckout` is the last word on whether an order can be placed. If it
     * grows a seventh refusal about the store, this panel goes quiet about it
     * — so the refusals are counted here against the map.
     */
    const checkout = read('src/lib/orders/place-order.ts');
    // Line by line rather than one clever pattern: the first draft used a
    // `[^)]*` run and matched two refusals out of four by wandering across
    // lines, which would have quietly weakened this into a check that could
    // not fail.
    const refusals = checkout
      .split('\n')
      .filter((line) => line.includes('throw new StoreUnavailableError('));
    expect(refusals.length).toBeGreaterThanOrEqual(4);
    // Each phrase in that guard has a blocker here. `no such store` is the
    // exception and cannot have one: a shop reading its own settings screen
    // exists by construction.
    expect(checkout).toMatch(/'not visible'/);
    expect(checkout).toMatch(/'closed'/);
    expect(checkout).toMatch(/does not serve/);
  });

  it('reads the city gate from the registry rather than restating it', () => {
    const loader = read('src/lib/merchant/storefront.ts');
    expect(loader).toMatch(/isOrderableIn\(service, store\.cityId\)/);
    expect(loader).toMatch(/findDeliveryFeeRule/);
    // Never the global flag on its own, which is the bug this replaced.
    expect(loader).not.toMatch(/service\.isActive \?/);
  });

  it('is not a hardcoded list of services', () => {
    const loader = read('src/lib/merchant/storefront.ts');
    expect(loader).toMatch(/getAllServices/);
    expect(loader).not.toMatch(/ServiceKey\.FOOD/);
  });
});

describe('what the panel actually renders', () => {
  const panel = readFileSync(
    path.join(process.cwd(), 'src/components/merchant/StorefrontPanel.tsx'),
    'utf8',
  );

  it('labels each chip from the fix union rather than a yes/no', () => {
    expect(panel).toMatch(/Record<BlockerFix\['kind'\]/);
    expect(panel).toMatch(/CHIP\[copy\.fix\.kind\]/);
    // The ternary that produced "Yours to fix" for a shop that had closed.
    expect(panel).not.toMatch(/clearedBy === 'THE_SHOP'/);
  });

  it('takes the screen and the support link from the rule, not its own guess', () => {
    expect(panel).toMatch(/screenToOpen\(state\)/);
    expect(panel).toMatch(/needsSupport\(state\)/);
    // No hardcoded menu path: the link comes from the blocker that needs it.
    expect(panel).not.toMatch(/\/menu`/);
  });
});

// --- The shell, which used to say the opposite ----------------------------

describe('what the merchant shell says', () => {
  it('says nothing on a shop that is fine', () => {
    expect(shellAlert(storefrontState(facts()))).toBeNull();
  });

  it('says nothing on a shop that merely closed for the night', () => {
    // The pill already reads Sarado. A warning strip about a switch somebody
    // just tapped is noise, and noise is what gets ignored when it matters.
    expect(shellAlert(storefrontState(facts({ isOpen: false })))).toBeNull();
  });

  it('says nobody can find the shop when the listings filter it out', () => {
    /**
     * The case this exists for. The pill was emerald whenever the shop's own
     * switch was on, so a shop TARA had taken off the app read "open" on six
     * screens out of seven, and the only screen that knew better was the one
     * nobody opens when orders are simply not arriving.
     */
    const line = shellAlert(storefrontState(facts({ isVisible: false })));
    expect(line).toMatch(/find your shop/i);
  });

  it('distinguishes not-found from found-but-cannot-finish', () => {
    const unpriced = shellAlert(
      storefrontState(facts({ services: [{ ...LIVE_FOOD, hasDeliveryPricing: false }] })),
    );
    expect(unpriced).toMatch(/cannot be completed/i);
    expect(unpriced).not.toMatch(/find your shop/i);
  });

  it('speaks up even while the shop is also closed', () => {
    // Otherwise closing for the night would hide the real fault until morning.
    const line = shellAlert(
      storefrontState(facts({ isVisible: false, isOpen: false })),
    );
    expect(line).toMatch(/find your shop/i);
  });

  it('never repeats the panel’s own headline word for word', () => {
    /**
     * The settings screen renders both, one above the other. Two identical
     * sentences stacked reads as a rendering bug rather than as emphasis.
     */
    const panel = readFileSync(
      path.join(process.cwd(), 'src/components/merchant/StorefrontPanel.tsx'),
      'utf8',
    );
    for (const input of [
      facts({ isVisible: false }),
      facts({ services: [{ ...LIVE_FOOD, hasDeliveryPricing: false }] }),
    ]) {
      const line = shellAlert(storefrontState(input));
      expect(line).not.toBeNull();
      expect(panel, line!).not.toContain(line!);
    }
  });
});

describe('the shell reads the rule rather than the switch', () => {
  const layout = readFileSync(
    path.join(process.cwd(), 'src/app/merchant/[storeId]/layout.tsx'),
    'utf8',
  );
  const toggle = readFileSync(
    path.join(process.cwd(), 'src/components/merchant/StoreOpenToggle.tsx'),
    'utf8',
  );

  it('hands the toggle whether opening would change anything', () => {
    expect(layout).toMatch(/opensToOrders=\{storefront\.readyWhenOpen\}/);
    expect(toggle).toMatch(/opensToOrders/);
  });

  it('keeps the switch usable rather than disabling it on a hidden shop', () => {
    // It is the shop's own control, and the most urgent one they have. A
    // kitchen that has run out of rice must still be able to stop orders even
    // while something else is wrong.
    expect(toggle).not.toMatch(/disabled=\{[^}]*opensToOrders/);
    expect(toggle).toMatch(/disabled=\{isPending\}/);
  });

  it('does not offer a tap to the screen it is already on', () => {
    /**
     * Seen in a browser. On the settings screen the strip sat directly above
     * the panel that explains it, still offering "Bakit? →" as a link to the
     * page you were standing on. The line stays — every merchant screen should
     * agree on it — and the dead link does not.
     */
    const alert = readFileSync(
      path.join(process.cwd(), 'src/components/merchant/StorefrontAlert.tsx'),
      'utf8',
    );
    expect(alert).toMatch(/usePathname\(\)/);
    expect(alert).toMatch(/pathname === settings/);
  });

  it('shares the query with the page inside it', () => {
    // The layout wraps seven screens; paying for these queries twice on the
    // one screen that renders both would be a needless round trip on it.
    const loader = readFileSync(
      path.join(process.cwd(), 'src/lib/merchant/storefront.ts'),
      'utf8',
    );
    expect(loader).toMatch(/cache\(async function loadStorefront/);
    // Keyed on the id: `requireStoreAccess` is not cached, so two Store row
    // objects for the same shop would have missed the cache entirely.
    expect(loader).toMatch(/storeId: string/);
    expect(layout).toMatch(/loadStorefront\(access\.store\.id\)/);
  });
});
