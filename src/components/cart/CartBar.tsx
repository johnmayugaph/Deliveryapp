'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCart } from '@/components/cart/CartProvider';
import { cartItemCount } from '@/lib/cart/types';

/**
 * The sticky "go to checkout" bar.
 *
 * It shows an item count, not a total. A total here would have to be computed
 * client-side from cached prices, and would then disagree with the server's
 * quote at the worst possible moment. The checkout screen shows the real
 * number, computed once, server-side.
 *
 * Hidden on the routes where it would be redundant or in the way: checkout
 * itself, and order tracking — where a leftover cart must not compete with the
 * order the customer is actually watching.
 */
const HIDDEN_ON = ['/checkout', '/orders'];

export function CartBar() {
  const { cart, isLoaded } = useCart();
  const pathname = usePathname();

  if (!isLoaded || cart.lines.length === 0) {
    return null;
  }
  if (HIDDEN_ON.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }

  const count = cartItemCount(cart);

  return (
    // Sits above the bottom navigation, which is 4rem tall.
    <div className="fixed inset-x-0 bottom-[4.1rem] z-40 px-4">
      <div className="mx-auto max-w-lg">
        <Link
          href="/checkout"
          className="flex items-center justify-between gap-3 rounded-xl bg-brand-700 px-4 py-3 text-white shadow-lg transition-colors hover:bg-brand-800"
        >
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span
              aria-hidden
              className="flex h-6 min-w-6 items-center justify-center rounded-full bg-white/20 px-1.5 text-xs tabular-nums"
            >
              {count}
            </span>
            {cart.storeName ?? 'Cart'}
          </span>
          <span className="text-sm font-semibold">
            Checkout <span aria-hidden>→</span>
          </span>
        </Link>
      </div>
    </div>
  );
}
