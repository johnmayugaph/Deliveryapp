import type { ServiceKey } from '@prisma/client';

/**
 * Whether a customer can order from this shop right now — and if not, what is
 * stopping it and who can clear it.
 *
 * This exists because the shop's own app never told them. Every customer path
 * filters stores on `isVisible`, and `quoteCheckout` refuses outright when it
 * is false — but nothing on the merchant side reads it. A shop whose
 * visibility had been withdrawn from the console saw an emerald "Bukas" in its
 * own header, an open kitchen, and no orders, with nothing anywhere in their
 * app to explain it. The console has had `readyForCustomers` since the day it
 * could create a store; the shop had no equivalent at all.
 *
 * Pure: takes facts, imports the enum and nothing else. The gathering is
 * `./storefront.ts`, which is where the queries live.
 *
 * NOTE on what is deliberately NOT a blocker here: `City.isActive`. It is read
 * by the surge sweep and the console's service screen and by nothing on the
 * ordering path, so a store in an inactive city still takes orders today.
 * Listing it would be inventing a gate, and this module's whole value is that
 * every entry is one the customer path actually applies.
 */

/** Every reason the customer path refuses a store. */
export type StorefrontBlocker =
  | 'HIDDEN_BY_TARA'
  | 'NO_SERVICE_ASSIGNED'
  | 'SERVICE_NOT_LIVE_HERE'
  | 'NO_DELIVERY_PRICING'
  | 'NOTHING_ON_THE_MENU'
  | 'CLOSED_BY_THE_SHOP';

/**
 * Where the fix is.
 *
 * The half that makes this panel worth reading, and a union rather than a flag
 * because the four answers are not the same shape. "No dishes are available"
 * is a screen away; "you are closed" is the switch already on screen; "TARA
 * has hidden your shop" is a phone call; "your city has not launched" is
 * nobody's job at all.
 *
 * Seen in a browser: with `clearedBy: 'THE_SHOP'` as the only distinction, a
 * shop that had closed for the night was shown a chip reading "Yours to fix"
 * and a button reading "Open the menu" — a fault it had not committed, and a
 * screen that was not the answer.
 */
export type BlockerFix =
  | { kind: 'SUPPORT' }
  /** Nothing to do. It resolves when TARA launches, and not before. */
  | { kind: 'WAIT' }
  /** The Bukas/Sarado switch, in the header of every merchant screen. */
  | { kind: 'SWITCH' }
  | { kind: 'SCREEN'; tab: string; path: string };

/**
 * Who can actually do something about it.
 *
 * DERIVED from where the fix is, rather than stated alongside it: two fields
 * that had to agree is two fields that could disagree, and the one that would
 * have been wrong is the one telling a shop to ring support about its own
 * switch.
 */
export type ClearedBy = 'THE_SHOP' | 'TARA';

export function clearedBy(blocker: StorefrontBlocker): ClearedBy {
  const { kind } = STOREFRONT_BLOCKERS[blocker].fix;
  return kind === 'SWITCH' || kind === 'SCREEN' ? 'THE_SHOP' : 'TARA';
}

export interface BlockerCopy {
  /** What is wrong, in the words a shop would use. */
  title: string;
  /** What to do about it. Names the control, or names support. */
  detail: string;
  fix: BlockerFix;
  /**
   * True when this keeps the shop out of the listings and the search results
   * altogether, rather than letting a customer arrive and fail.
   *
   * Worth distinguishing: "nobody can find you" and "they find you and cannot
   * finish" look identical from behind the counter — an empty queue — and lead
   * to completely different conversations.
   */
  hidesTheShop: boolean;
}

/**
 * Compile-enforced over the union, so a seventh refusal added to the ordering
 * path cannot be added here without deciding both of those things about it.
 */
export const STOREFRONT_BLOCKERS: Readonly<Record<StorefrontBlocker, BlockerCopy>> = {
  HIDDEN_BY_TARA: {
    title: 'TARA has taken the shop off the app',
    detail:
      'Customers cannot find you and cannot order. This is not something the shop can switch back on — message support to ask why.',
    fix: { kind: 'SUPPORT' },
    hidesTheShop: true,
  },
  NO_SERVICE_ASSIGNED: {
    title: 'The shop is not attached to any service',
    detail:
      'Nothing has been set for the shop to be listed under, so it appears nowhere. Message support.',
    fix: { kind: 'SUPPORT' },
    hidesTheShop: true,
  },
  SERVICE_NOT_LIVE_HERE: {
    title: 'TARA has not launched your service in your city yet',
    detail:
      'The shop is set up, but TARA has not launched this service where you are. Nothing to fix — you will be listed the day it opens.',
    fix: { kind: 'WAIT' },
    hidesTheShop: true,
  },
  NO_DELIVERY_PRICING: {
    title: 'Delivery is not priced for your city',
    detail:
      'Customers can see the shop, but checkout stops because there is no delivery fee to quote them. Message support.',
    fix: { kind: 'SUPPORT' },
    hidesTheShop: false,
  },
  NOTHING_ON_THE_MENU: {
    title: 'Nothing on the menu is available',
    detail:
      'Customers can open the shop and find nothing to order. Put a dish back on from the Menu tab.',
    fix: { kind: 'SCREEN', tab: 'Menu', path: 'menu' },
    hidesTheShop: false,
  },
  CLOSED_BY_THE_SHOP: {
    title: 'The shop is closed',
    detail:
      'Your own switch, and nothing else is wrong. Tap Bukas at the top of the screen when you are ready for orders.',
    fix: { kind: 'SWITCH' },
    hidesTheShop: false,
  },
};

/** One service key the store is attached to, as the gates see it. */
export interface StorefrontServiceFacts {
  key: ServiceKey;
  /** From the registry, so a renamed service is not restated here. */
  displayName: string;
  /** The registry's global flag: live for TARA at all. */
  isActive: boolean;
  /**
   * `isOrderableIn(service, store.cityId)`. NOT the same as `isActive`, which
   * is the bug this replaced on the settings screen: the section rendered the
   * global flag, so a Manila shop was told MART was "Live" while MART was live
   * only in Cebu — a green badge on a service that would never bring an order.
   */
  liveInThisCity: boolean;
  /** A delivery fee rule exists for this service in the store's city. */
  hasDeliveryPricing: boolean;
}

export interface StorefrontFacts {
  isVisible: boolean;
  isOpen: boolean;
  /** Named, because every sentence about a city gate has to say which city. */
  cityName: string;
  services: readonly StorefrontServiceFacts[];
  /** Menu items with `isAvailable`, which is what the customer's menu shows. */
  availableMenuItems: number;
}

/** A service as the shop should read it, city and pricing included. */
export interface StorefrontServiceView extends StorefrontServiceFacts {
  /** Whether an order could actually arrive through this service. */
  bringsOrders: boolean;
  /** The badge: three states, not two. */
  standing: 'ORDERABLE' | 'NOT_HERE_YET' | 'COMING_SOON' | 'NO_PRICING';
}

export interface StorefrontState {
  /**
   * The store's city, by name.
   *
   * Carried on the state rather than baked into the copy above, because the
   * only sentences that need it are the two about where the shop is — "not in
   * Baguio yet" — and a map of copy that had to be built per city could not be
   * a constant the tests walk exhaustively.
   */
  cityName: string;
  /** A customer can complete an order right now. */
  orderable: boolean;
  /**
   * Everything except the shop's own open/closed switch is clear.
   *
   * The reading that matters, and the reason `CLOSED_BY_THE_SHOP` is not
   * treated as a fault: a kitchen that closed at 10pm on purpose does not need
   * a red panel telling it customers cannot order. "You are closed, and that
   * is the only thing stopping you" is a completely different message from
   * "you are open and still getting nothing".
   */
  readyWhenOpen: boolean;
  /** The shop appears in the listings and the search results. */
  listed: boolean;
  /** Most decisive first, so the top line is the one worth acting on. */
  blockers: StorefrontBlocker[];
  services: StorefrontServiceView[];
}

/**
 * The order they are reported in: what makes the shop invisible before what
 * makes it fail at checkout, and the shop's own switch last, because it is the
 * one thing on the list that is not a fault.
 */
const REPORT_ORDER: readonly StorefrontBlocker[] = [
  'HIDDEN_BY_TARA',
  'NO_SERVICE_ASSIGNED',
  'SERVICE_NOT_LIVE_HERE',
  'NO_DELIVERY_PRICING',
  'NOTHING_ON_THE_MENU',
  'CLOSED_BY_THE_SHOP',
];

function serviceStanding(
  service: StorefrontServiceFacts,
): StorefrontServiceView['standing'] {
  if (!service.isActive) return 'COMING_SOON';
  if (!service.liveInThisCity) return 'NOT_HERE_YET';
  if (!service.hasDeliveryPricing) return 'NO_PRICING';
  return 'ORDERABLE';
}

export function storefrontState(facts: StorefrontFacts): StorefrontState {
  const services: StorefrontServiceView[] = facts.services.map((service) => {
    const standing = serviceStanding(service);
    return { ...service, standing, bringsOrders: standing === 'ORDERABLE' };
  });

  const found = new Set<StorefrontBlocker>();

  if (!facts.isVisible) found.add('HIDDEN_BY_TARA');
  if (services.length === 0) {
    found.add('NO_SERVICE_ASSIGNED');
  } else if (!services.some((service) => service.liveInThisCity)) {
    // Reported once for the shop, not once per key: "your service is not open
    // here" is one fact about where the shop is, however many keys it holds.
    found.add('SERVICE_NOT_LIVE_HERE');
  } else if (!services.some((service) => service.bringsOrders)) {
    // Something is live here and none of the live ones can be priced. Only
    // reachable past the branch above, so it never fires as a second, more
    // confusing way of saying the service has not launched.
    found.add('NO_DELIVERY_PRICING');
  }
  if (facts.availableMenuItems === 0) found.add('NOTHING_ON_THE_MENU');
  if (!facts.isOpen) found.add('CLOSED_BY_THE_SHOP');

  const blockers = REPORT_ORDER.filter((blocker) => found.has(blocker));

  return {
    cityName: facts.cityName,
    orderable: blockers.length === 0,
    readyWhenOpen: blockers.every((blocker) => blocker === 'CLOSED_BY_THE_SHOP'),
    listed: !blockers.some((blocker) => STOREFRONT_BLOCKERS[blocker].hidesTheShop),
    blockers,
    services,
  };
}

/** The blockers this shop can do something about, in the reported order. */
export function blockersTheShopCanClear(
  state: StorefrontState,
): StorefrontBlocker[] {
  return state.blockers.filter((blocker) => clearedBy(blocker) === 'THE_SHOP');
}

/** The blockers only TARA can clear — the ones worth a message to support. */
export function blockersOnlyTaraCanClear(
  state: StorefrontState,
): StorefrontBlocker[] {
  return state.blockers.filter((blocker) => clearedBy(blocker) === 'TARA');
}

/**
 * The one screen worth offering, if any of the reported blockers has one.
 *
 * At most one link, rather than a button per row: two of the six fixes are not
 * screens at all, and a row-by-row list of buttons on a shop that is merely
 * closed reads as five things being wrong.
 */
export function screenToOpen(
  state: StorefrontState,
): { tab: string; path: string } | null {
  for (const blocker of state.blockers) {
    const { fix } = STOREFRONT_BLOCKERS[blocker];
    if (fix.kind === 'SCREEN') return { tab: fix.tab, path: fix.path };
  }
  return null;
}

/** True when at least one reported blocker needs a message to support. */
export function needsSupport(state: StorefrontState): boolean {
  return state.blockers.some(
    (blocker) => STOREFRONT_BLOCKERS[blocker].fix.kind === 'SUPPORT',
  );
}

/**
 * The one line worth interrupting every merchant screen with, or null.
 *
 * The Bukas/Sarado pill in the shell is emerald whenever the shop's own switch
 * is on, whatever the customer path would actually do — so a shop taken off
 * the app read "open" on six screens out of seven and had to go looking in
 * Settings to find out otherwise. This is what the shell says instead, and it
 * is deliberately NOT the panel's headline: on the settings screen the two
 * would otherwise sit one above the other saying the same words.
 *
 * Silent in two cases. A shop that is fine needs no banner, and neither does
 * one that simply closed for the night — the pill already reads Sarado, and a
 * warning strip about a switch somebody just tapped is noise.
 */
export function shellAlert(state: StorefrontState): string | null {
  if (state.orderable || state.readyWhenOpen) return null;
  return state.listed
    ? 'Orders cannot be completed right now.'
    : 'Nobody can find your shop right now.';
}
