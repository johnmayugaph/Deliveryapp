/**
 * Every customer screen, and what a visitor needs to open it.
 *
 * This exists because four screens disagreed with the other ten about what to
 * do when there is no signed-in user, and the four that disagreed did it by
 * rendering a **falsehood**: `/credits` showed a ₱0.00 balance, `/orders` said
 * "No orders yet", `/addresses` showed an empty address book, and
 * `/orders/[orderId]` answered `notFound()` about the customer's own order.
 *
 * None of that is a rare path. `middleware.ts` checks only that a session
 * cookie is PRESENT — it runs on the edge runtime and cannot reach the
 * database — so the cookie is still in the browser in all four of the ways
 * `loadSession` then refuses it:
 *
 *   1. `expiresAt` has passed. Sessions expire by design.
 *   2. `revokedAt` is set. This is the one that matters: "sign out everywhere"
 *      on `/profile` revokes the customer's OTHER sessions, so the reward for
 *      securing your account is the other phone in your pocket reporting that
 *      your credits are zero and your order history is empty.
 *   3. The account was blocked.
 *   4. It is a demo account and this is production.
 *
 * A screen that cannot tell "you have nothing" from "I could not look" must
 * say the second one. Zero is a number a customer will act on.
 *
 * So the decision is made once, here, over a closed set of screens — adding a
 * customer screen without deciding what it needs is a compile error, the same
 * arrangement `BACK_OFFICE_AREAS` uses for the merchant back office.
 *
 * Pure: imports nothing. `./access.ts` is the impure sibling that reads the
 * session and performs the redirect.
 */

/** What a visitor must be for a screen to render honestly. */
export type ScreenAccess =
  /** Renders for a stranger. Nothing on it is about a person. */
  | 'PUBLIC'
  /** Needs a live session. Without one the screen can only guess. */
  | 'SIGNED_IN'
  /**
   * Needs a live session AND a finished account. Placing an order needs
   * somebody to hand the food to; an invite code needs a name on it.
   */
  | 'ONBOARDED';

/**
 * The screens, keyed by a stable name.
 *
 * Keys are not paths: `/orders/[orderId]` is `orderDetail`, and the path
 * carries the segment placeholder so `loginPathFor` can be given the real id.
 */
export type CustomerScreen =
  | 'home'
  | 'search'
  | 'services'
  | 'store'
  | 'help'
  | 'login'
  | 'recover'
  | 'welcome'
  | 'checkout'
  | 'orders'
  | 'orderDetail'
  | 'credits'
  | 'points'
  | 'plus'
  | 'invite'
  | 'addresses'
  | 'profile'
  | 'notifications'
  | 'helpContact'
  | 'tickets'
  | 'ticketDetail';

export interface CustomerScreenFacts {
  /** Path, with `:id` where a segment is substituted. */
  path: string;
  needs: ScreenAccess;
  /**
   * What the screen would have to invent if it rendered without a user.
   *
   * Recorded for the SIGNED_IN and ONBOARDED screens because it is the whole
   * argument for the gate, and a gate whose reason is not written down is a
   * gate somebody removes. Null on public screens, which invent nothing.
   */
  wouldInvent: string | null;
}

export const CUSTOMER_SCREENS: Readonly<
  Record<CustomerScreen, CustomerScreenFacts>
> = {
  /* ---- public: about products, never about a person ------------------- */
  home: { path: '/', needs: 'PUBLIC', wouldInvent: null },
  search: { path: '/search', needs: 'PUBLIC', wouldInvent: null },
  services: { path: '/services/:id', needs: 'PUBLIC', wouldInvent: null },
  store: { path: '/stores/:id', needs: 'PUBLIC', wouldInvent: null },
  help: { path: '/help', needs: 'PUBLIC', wouldInvent: null },
  /* The premise of both is that the visitor is not signed in. */
  login: { path: '/login', needs: 'PUBLIC', wouldInvent: null },
  recover: { path: '/recover', needs: 'PUBLIC', wouldInvent: null },

  /* ---- a session, but not a finished account -------------------------- */
  /* Where an account is finished. Requiring ONBOARDED here would be a loop. */
  welcome: {
    path: '/welcome',
    needs: 'SIGNED_IN',
    wouldInvent: 'whose account is being set up',
  },
  orders: {
    path: '/orders',
    needs: 'SIGNED_IN',
    wouldInvent: 'that the customer has never ordered anything',
  },
  orderDetail: {
    path: '/orders/:id',
    needs: 'SIGNED_IN',
    wouldInvent: 'that the order does not exist',
  },
  credits: {
    path: '/credits',
    needs: 'SIGNED_IN',
    wouldInvent: 'a balance of zero',
  },
  /* ONBOARDED because that is the gate it already had, not because points
     need a name on the account. Tightening or loosening a gate is its own
     decision and not one this refactor gets to make quietly. */
  points: {
    path: '/points',
    needs: 'ONBOARDED',
    wouldInvent: 'a points balance of zero, and no status',
  },
  plus: {
    path: '/plus',
    needs: 'SIGNED_IN',
    wouldInvent: 'that the customer is not subscribed',
  },
  addresses: {
    path: '/addresses',
    needs: 'SIGNED_IN',
    wouldInvent: 'that no address has ever been saved',
  },
  profile: {
    path: '/profile',
    needs: 'SIGNED_IN',
    wouldInvent: 'an account with no name, no phone and no devices',
  },
  notifications: {
    path: '/notifications',
    needs: 'SIGNED_IN',
    wouldInvent: 'an empty inbox',
  },
  helpContact: {
    path: '/help/contact',
    needs: 'SIGNED_IN',
    wouldInvent: 'a ticket from nobody, about none of their orders',
  },
  tickets: {
    path: '/help/tickets',
    needs: 'SIGNED_IN',
    wouldInvent: 'that the customer has never asked for help',
  },
  ticketDetail: {
    path: '/help/tickets/:id',
    needs: 'SIGNED_IN',
    wouldInvent: 'that the conversation does not exist',
  },

  /* ---- a finished account -------------------------------------------- */
  checkout: {
    path: '/checkout',
    needs: 'ONBOARDED',
    wouldInvent: 'an order with nobody to hand the food to',
  },
  invite: {
    path: '/invite',
    needs: 'ONBOARDED',
    wouldInvent: 'an invite code belonging to no one',
  },
};

/** Whether a screen renders for a stranger. */
export function isPublic(screen: CustomerScreen): boolean {
  return CUSTOMER_SCREENS[screen].needs === 'PUBLIC';
}

/**
 * The concrete path for a screen, with `:id` filled in.
 *
 * Throws when a screen that takes an id is asked for without one, rather than
 * quietly producing a path with a literal `:id` in it — that path 404s, and it
 * would do so as a redirect target, which is the hardest kind to trace back.
 */
export function pathFor(screen: CustomerScreen, id?: string): string {
  const { path } = CUSTOMER_SCREENS[screen];
  if (!path.includes(':id')) return path;
  if (id === undefined) {
    throw new Error(`pathFor: ${screen} needs an id`);
  }
  return path.replace(':id', encodeURIComponent(id));
}

/**
 * Where to send somebody who needs to sign in, so that signing in brings them
 * back to what they were looking at.
 *
 * One implementation of the encoding. It was previously spelled out at each of
 * ten call sites, five of them encoded (`%2Fplus`) and five of them raw
 * (`/help/tickets`) — and a raw `next` is a bug waiting for the first path
 * with a query string in it, which then arrives at `/login` as a separate
 * parameter and is dropped.
 */
export function loginPathFor(screen: CustomerScreen, id?: string): string {
  return `/login?next=${encodeURIComponent(pathFor(screen, id))}`;
}
