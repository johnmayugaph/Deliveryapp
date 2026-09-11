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
const HIDDEN_ON = ['/checkout', '/orders', '/login', '/welcome', '/merchant', '/fleet', '/admin'];

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
    /* Sits above the bottom navigation. The offset is 4.75rem because the
       navigation grew when its current tab became a pill — the old 4.1rem
       left this bar's bottom edge tucked behind it, which read as a clipped
       button rather than a floating one. */
    <div className="fixed inset-x-0 bottom-[5.5rem] z-40 px-4">
      <div className="mx-auto max-w-lg">
        {/*
          * Ink ground with a mango chip, rather than a solid brand-coloured
          * bar. Two reasons, and the second is the one that decided it: a full
          * bar in brand yellow cannot carry white text, and in deep amber it
          * competed with the navigation pill directly below it. Dark bar,
          * yellow call to action, and the eye goes to the one thing that is
          * a button.
          */}
        <Link
          href="/checkout"
          className="press flex items-center justify-between gap-3 rounded-full bg-ink py-2 pl-3 pr-2 text-surface shadow-lifted"
        >
          <span className="flex items-center gap-2.5 text-[13.5px] font-bold">
            <span
              aria-hidden
              className="flex h-7 min-w-7 items-center justify-center rounded-full bg-brand-500 px-1.5 text-xs font-bold tabular-nums text-ink"
            >
              {count}
            </span>
            <span className="truncate">{cart.storeName ?? 'Cart'}</span>
          </span>
          <span className="flex items-center gap-1 rounded-full bg-brand-500 px-3.5 py-2 text-[13px] font-bold text-ink">
            Checkout <span aria-hidden>→</span>
          </span>
        </Link>
      </div>
    </div>
  );
}
