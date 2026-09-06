/**
 * Cart shape shared by the client cart and the server actions.
 *
 * Note what a cart line carries: an id, a quantity, and a note. NOT a price.
 * The display price is looked up from the store the page already loaded, and
 * the charged price is re-read from the database by `quoteCheckout()`. A cart
 * that carried prices would be a cart the client could edit.
 */
export interface CartLine {
  menuItemId: string;
  quantity: number;
  notes?: string;
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
