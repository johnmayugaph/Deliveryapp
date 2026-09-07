'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { EMPTY_CART, type Cart, type CartLine } from '@/lib/cart/types';

/**
 * The cart lives in the browser, persisted to localStorage.
 *
 * Deliberately not a DRAFT `Order` row: a quantity stepper should not write to
 * Postgres on every tap. The order is created once, at placement, and the
 * lifecycle's DRAFT state exists for that single transaction rather than for
 * the minutes someone spends browsing.
 *
 * A food cart holds one store. Adding from a different store replaces it, after
 * asking — silently discarding someone's basket is worse than an extra tap.
 */

const STORAGE_KEY = 'tara.cart.v1';

interface CartContextValue {
  cart: Cart;
  isLoaded: boolean;
  addItem: (input: {
    store: { id: string; name: string; slug: string };
    menuItemId: string;
    quantity?: number;
  }) => { replacedStore: string | null };
  setQuantity: (menuItemId: string, quantity: number) => void;
  setNotes: (menuItemId: string, notes: string) => void;
  clear: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

function readStoredCart(): Cart {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_CART;
    const parsed = JSON.parse(raw) as Cart;
    // Defend against a stale or hand-edited value.
    if (!Array.isArray(parsed?.lines)) return EMPTY_CART;
    return {
      storeId: typeof parsed.storeId === 'string' ? parsed.storeId : null,
      storeName: typeof parsed.storeName === 'string' ? parsed.storeName : null,
      storeSlug: typeof parsed.storeSlug === 'string' ? parsed.storeSlug : null,
      lines: parsed.lines.flatMap((line): CartLine[] =>
        typeof line?.menuItemId === 'string' && Number.isFinite(line?.quantity) && line.quantity > 0
          ? [{ menuItemId: line.menuItemId, quantity: Math.floor(line.quantity), notes: line.notes }]
          : [],
      ),
    };
  } catch {
    // Private mode, cleared site data, quota — a missing cart is recoverable.
    return EMPTY_CART;
  }
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  // Server and first client render must agree, so the stored cart is read
  // after mount rather than during render.
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setCart(readStoredCart());
    setIsLoaded(true);
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
    } catch {
      // Nothing to do: the cart still works for this session.
    }
  }, [cart, isLoaded]);

  const addItem = useCallback<CartContextValue['addItem']>(
    ({ store, menuItemId, quantity = 1 }) => {
      let replacedStore: string | null = null;

      setCart((current) => {
        if (current.storeId && current.storeId !== store.id) {
          replacedStore = current.storeName;
          return {
            storeId: store.id,
            storeName: store.name,
            storeSlug: store.slug,
            lines: [{ menuItemId, quantity }],
          };
        }

        const existing = current.lines.find((line) => line.menuItemId === menuItemId);
        return {
          storeId: store.id,
          storeName: store.name,
          storeSlug: store.slug,
          lines: existing
            ? current.lines.map((line) =>
                line.menuItemId === menuItemId
                  ? { ...line, quantity: line.quantity + quantity }
                  : line,
              )
            : [...current.lines, { menuItemId, quantity }],
        };
      });

      return { replacedStore };
    },
    [],
  );

  const setQuantity = useCallback<CartContextValue['setQuantity']>((menuItemId, quantity) => {
    setCart((current) => {
      const lines =
        quantity <= 0
          ? current.lines.filter((line) => line.menuItemId !== menuItemId)
          : current.lines.map((line) =>
              line.menuItemId === menuItemId ? { ...line, quantity } : line,
            );
      // Dropping the last item releases the store, so the next add is clean.
      return lines.length === 0 ? EMPTY_CART : { ...current, lines };
    });
  }, []);

  const setNotes = useCallback<CartContextValue['setNotes']>((menuItemId, notes) => {
    setCart((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.menuItemId === menuItemId ? { ...line, notes } : line,
      ),
    }));
  }, []);

  const clear = useCallback(() => setCart(EMPTY_CART), []);

  const value = useMemo(
    () => ({ cart, isLoaded, addItem, setQuantity, setNotes, clear }),
    [cart, isLoaded, addItem, setQuantity, setNotes, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used inside a CartProvider');
  }
  return context;
}
