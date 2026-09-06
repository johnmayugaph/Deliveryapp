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
 */
const ITEMS = [
  { href: '/', label: 'Home', glyph: '🏠' },
  { href: '/orders', label: 'Orders', glyph: '🧾' },
  { href: '/credits', label: 'Credits', glyph: '🎁' },
  { href: '/profile', label: 'Profile', glyph: '👤' },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-black/5 bg-surface/95 backdrop-blur"
    >
      <ul className="mx-auto flex max-w-lg items-stretch">
        {ITEMS.map((item) => {
          const isCurrent =
            item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={isCurrent ? 'page' : undefined}
                className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors ${
                  isCurrent ? 'text-brand-700' : 'text-ink-faint hover:text-ink-muted'
                }`}
              >
                <span aria-hidden className="text-lg leading-none">
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
