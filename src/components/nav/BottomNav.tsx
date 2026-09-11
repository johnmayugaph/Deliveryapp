'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Bottom navigation: Home, Orders, Credits, Profile.
 *
 * "Credits" is the customer-facing name for the rewards ledger. It is never
 * "Wallet" — see docs/architecture.md § Credits for why that wording matters.
 *
 * Orders is one chronological list across every service. That unified history
 * is a large part of what makes this feel like one product rather than several
 * apps sharing a login.
 *
 * Hidden where it would be wrong rather than merely redundant: the auth screens
 * (offering navigation to signed-in destinations to somebody who is not signed
 * in) and the merchant back office (a different product with its own tabs).
 */
const HIDDEN_ON = ['/login', '/welcome', '/merchant', '/fleet', '/admin'];
const ITEMS = [
  { href: '/', label: 'Home', glyph: '🏠' },
  { href: '/orders', label: 'Orders', glyph: '🧾' },
  { href: '/credits', label: 'Credits', glyph: '🎁' },
  { href: '/profile', label: 'Profile', glyph: '👤' },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  if (HIDDEN_ON.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }

  return (
    <nav
      aria-label="Main"
      /*
       * A floating pill rather than a bar welded to the bottom edge. It is
       * what the current generation of these apps does, and the gap underneath
       * is not decoration: it lets the page scroll visibly past the navigation
       * instead of ending at a hard line, which is what made the old bar read
       * as a page footer.
       */
      className="fixed inset-x-0 bottom-0 z-40 px-3 pb-3"
      /* The home-bar inset, so the labels are not sitting under it on an
         iPhone. `env()` resolves to 0 everywhere else, which is why it can be
         unconditional. */
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex max-w-lg items-stretch gap-1 rounded-full bg-surface/95 px-2 py-1.5 shadow-lifted ring-1 ring-ink/[0.06] backdrop-blur-md">
        {ITEMS.map((item) => {
          const isCurrent =
            item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={isCurrent ? 'page' : undefined}
                /*
                 * The current tab is a filled pill rather than coloured text.
                 * Four small labels in four shades of the same hue is a
                 * distinction people squint at; a shape is legible at a
                 * glance and survives being looked at in sunlight.
                 */
                className={`flex flex-col items-center gap-0.5 rounded-full py-2 text-[11px] font-bold transition-colors ${
                  isCurrent
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-ink-faint hover:bg-ink/[0.04] hover:text-ink-muted'
                }`}
              >
                <span aria-hidden className="text-[19px] leading-none">
                  {item.glyph}
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
