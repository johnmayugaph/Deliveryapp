'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark } from '@/components/brand/Wordmark';

/**
 * The top navigation, desktop only.
 *
 * A bottom bar is a phone convention — it exists because a thumb reaches the
 * bottom of a handset and not the top. On a laptop it is a strip of buttons
 * floating over the middle of a wide screen, miles from the pointer and from
 * everything else the page offers. So below `lg` the bottom pill navigates and
 * this is not rendered; from `lg` up the reverse.
 *
 * SAME DESTINATIONS, SAME ORDER, SAME NAMES as `BottomNav` — including
 * "Credits" rather than "Wallet", which is a product rule and not a layout one
 * (see docs/architecture.md § Credits). Two navigations that disagree about
 * what the app contains is worse than either one alone.
 */
const HIDDEN_ON = ['/login', '/welcome', '/merchant', '/fleet', '/admin'];
const ITEMS = [
  { href: '/', label: 'Home' },
  { href: '/orders', label: 'Orders' },
  { href: '/credits', label: 'Credits' },
  { href: '/profile', label: 'Profile' },
] as const;

export function DesktopNav() {
  const pathname = usePathname();

  if (HIDDEN_ON.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }

  return (
    <header className="sticky top-0 z-40 hidden border-b border-ink/[0.06] bg-surface/95 backdrop-blur lg:block">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <Link href="/" className="shrink-0" aria-label="TARA home">
          <Wordmark size="sm" />
        </Link>

        <nav aria-label="Main" className="flex items-center gap-1">
          {ITEMS.map((item) => {
            const isCurrent =
              item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isCurrent ? 'page' : undefined}
                className={`rounded-full px-3.5 py-2 text-[13.5px] font-bold transition-colors ${
                  isCurrent
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Search on the right, where a wide header has room for it and a
            phone header does not. It posts to the same screen the in-page
            search field does, so there is one search and not two. */}
        <form action="/search" method="get" role="search" className="ml-auto w-72">
          <label htmlFor="desktop-search" className="sr-only">
            Search
          </label>
          <div className="relative flex items-center gap-2 rounded-full bg-surface-sunken px-3.5 py-2 ring-1 ring-ink/[0.06] focus-within:ring-2 focus-within:ring-brand-500">
            <span aria-hidden className="text-[13px]">
              🔎
            </span>
            <input
              id="desktop-search"
              name="q"
              type="search"
              autoComplete="off"
              placeholder="Search shops and dishes"
              className="w-full bg-transparent text-[13.5px] focus:outline-none"
            />
          </div>
        </form>

        <Link
          href="/help"
          className="shrink-0 text-[13.5px] font-bold text-ink-muted hover:text-ink"
        >
          Help
        </Link>
      </div>
    </header>
  );
}
