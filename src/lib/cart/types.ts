/**
 * Cart shape shared by the client cart and the server actions.
 *
 * Note what a cart line carries: ids, a quantity, and a note. NOT a price —
 * not for the dish and not for the choices on it. The display price is looked
 * up from the store the page already loaded, and the charged price is re-read
 * from the database by `quoteCheckout()`. A cart that carried prices would be
 * a cart the client could edit.
 */
export interface CartLine {
  /**
   * What makes this line itself: the dish plus exactly the options chosen on
   * it. Two lines of the same dish with different choices are two lines,
   * because they are two different things to cook and to charge for — and
   * because a stepper that added "large" to your "regular" would be a bug
   * somebody discovers at the door.
   */
  lineId: CartLineId;
  menuItemId: string;
  /** Chosen `MenuItemOption` ids. Empty for a dish that asks nothing. */
  optionIds: string[];
  quantity: number;
  notes?: string;
}

/**
 * A line's identity, distinct from a dish's id at the type level.
 *
 * Branded on purpose. Both are strings, so `setQuantity(menuItemId, 2)` — the
 * call every one of these controls made before dishes had choices — compiles
 * perfectly and moves the wrong line, or none. The brand turns that into the
 * error it should be. It costs a cast in one function and catches the mistake
 * everywhere else.
 */
export type CartLineId = string & { readonly __cartLineId: unique symbol };

/**
 * The identity of a line, from the dish and its choices.
 *
 * Sorted, so the same choices made in a different order are the same line
 * rather than a second one. Derived rather than random for the same reason:
 * adding "Large, extra rice" twice has to find the line that is already
 * there.
 */
export function cartLineId(menuItemId: string, optionIds: readonly string[]): CartLineId {
  return [menuItemId, ...[...optionIds].sort()].join('|') as CartLineId;
}

export interface Cart {
  /** A food cart belongs to exactly one store. */
  storeId: string | null;
  storeName: string | null;
  storeSlug: string | null;
  lines: CartLine[];
}

export const EMPTY_CART: Cart = {
  storeId: null,
  storeName: null,
  storeSlug: null,
  lines: [],
};

export function cartItemCount(cart: Cart): number {
  return cart.lines.reduce((total, line) => total + line.quantity, 0);
}

export function isCartEmpty(cart: Cart): boolean {
  return cart.lines.length === 0;
}

/** How many of one dish are in the cart, across every set of choices. */
export function countOfItem(cart: Cart, menuItemId: string): number {
  return cart.lines
    .filter((line) => line.menuItemId === menuItemId)
    .reduce((total, line) => total + line.quantity, 0);
}
