'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark } from '@/components/brand/Wordmark';

/**
 * The footer, desktop only.
 *
 * A phone screen ends at the bottom navigation; a laptop screen ends at a
 * horizon of empty page, and a footer is what stops a wide layout looking
 * unfinished. Below `lg` it is not rendered at all rather than merely hidden —
 * on a phone it would be four columns of links between the last shop and the
 * navigation somebody was reaching for.
 *
 * EVERY LINK HERE GOES SOMEWHERE. There are no "About us", "Careers" or
 * "Blog" columns, because those pages do not exist and a footer full of dead
 * links is the clearest possible signal that a site is a shell. What is here
 * is what the application actually has.
 */
const HIDDEN_ON = ['/login', '/welcome', '/merchant', '/fleet', '/admin'];

const COLUMNS = [
  {
    heading: 'Order',
    links: [
      { href: '/', label: 'Home' },
      { href: '/search', label: 'Search' },
      { href: '/orders', label: 'Your orders' },
      { href: '/addresses', label: 'Addresses' },
    ],
  },
  {
    heading: 'Rewards',
    links: [
      { href: '/credits', label: 'Credits' },
      { href: '/points', label: 'Points' },
      { href: '/plus', label: 'Plus' },
      { href: '/invite', label: 'Invite a friend' },
    ],
  },
  {
    heading: 'Account',
    links: [
      { href: '/profile', label: 'Profile' },
      { href: '/notifications', label: 'Notifications' },
      { href: '/recover', label: 'Recover access' },
    ],
  },
  {
    heading: 'Partners',
    links: [
      { href: '/merchant', label: 'For shops' },
      { href: '/fleet', label: 'For riders' },
      { href: '/help', label: 'Help' },
    ],
  },
] as const;

export function SiteFooter() {
  const pathname = usePathname();

  if (HIDDEN_ON.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }

  return (
    <footer className="mt-12 hidden border-t border-ink/[0.06] bg-surface lg:block">
      <div className="mx-auto grid max-w-6xl grid-cols-5 gap-8 px-6 py-10">
        <div>
          <Wordmark size="md" />
          <p className="mt-2 max-w-[14rem] text-[12.5px] leading-relaxed text-ink-muted">
            Food, mart, parcel, errands and rides — one app, one login, one
            order history.
          </p>
        </div>

        {COLUMNS.map((column) => (
          <div key={column.heading}>
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-faint">
              {column.heading}
            </h2>
            <ul className="mt-3 space-y-2">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-[13px] text-ink-muted hover:text-brand-700"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-ink/[0.06]">
        <p className="mx-auto max-w-6xl px-6 py-4 text-[12px] text-ink-faint">
          © {new Date().getFullYear()} TARA. Prices are set by each shop and
          include VAT where it applies.
        </p>
      </div>
    </footer>
  );
}
