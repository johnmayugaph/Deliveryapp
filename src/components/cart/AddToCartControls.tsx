'use client';

import { useState } from 'react';
import { useCart } from '@/components/cart/CartProvider';

/**
 * Quantity stepper for one menu item.
 *
 * Shows an "Add" button until the item is in the cart, then a stepper. Adding
 * from a different store replaces the cart, and says so afterwards rather than
 * silently discarding a basket.
 */
export function AddToCartControls({
  store,
  menuItemId,
  itemName,
}: {
  store: { id: string; name: string; slug: string };
  menuItemId: string;
  itemName: string;
}) {
  const { cart, isLoaded, addItem, setQuantity } = useCart();
  const [replacedStore, setReplacedStore] = useState<string | null>(null);

  const line = cart.lines.find((candidate) => candidate.menuItemId === menuItemId);
  const quantity = cart.storeId === store.id ? (line?.quantity ?? 0) : 0;

  // Until the stored cart is read, render the neutral state so the server and
  // client markup agree.
  if (!isLoaded) {
    return <div className="h-8 w-16" aria-hidden />;
  }

  if (quantity === 0) {
    return (
      <div className="text-right">
        <button
          type="button"
          onClick={() => {
            const { replacedStore: replaced } = addItem({ store, menuItemId });
            setReplacedStore(replaced);
          }}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          Add
          <span className="sr-only"> {itemName} to cart</span>
        </button>
        {replacedStore ? (
          <p role="status" className="mt-1 max-w-[9rem] text-[10px] leading-tight text-amber-700">
            Your cart from {replacedStore} was replaced.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => setQuantity(menuItemId, quantity - 1)}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-sunken text-sm font-semibold ring-1 ring-black/10 transition-colors hover:bg-brand-50"
      >
        <span aria-hidden>−</span>
        <span className="sr-only">Remove one {itemName}</span>
      </button>
      <span className="w-5 text-center text-sm font-semibold tabular-nums" aria-live="polite">
        {quantity}
      </span>
      <button
        type="button"
        onClick={() => setQuantity(menuItemId, quantity + 1)}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
      >
        <span aria-hidden>+</span>
        <span className="sr-only">Add one {itemName}</span>
      </button>
    </div>
  );
}
