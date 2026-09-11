'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';

/**
 * The console's navigation.
 *
 * It replaces nineteen links wrapping across three lines of the header with no
 * grouping and nothing marking where you are. Three things were wrong with
 * that and all three are structural rather than cosmetic: an operator could
 * not tell which screen they were on, could not tell which screens were
 * related, and had to read the whole list every time because the order carried
 * no meaning.
 *
 * THE GROUPS ARE THE POINT. "Settlement" and "Payments" belong together and
 * "Errors" does not belong with either; a person looking for where the money
 * goes should be able to stop reading after the Money heading.
 *
 * The filter box exists because nineteen is the number at which a list stops
 * being scannable, and this console grows a screen most months.
 */
export interface NavBadges {
  support: number;
  fleet: number;
  errors: number;
}

const GROUPS: {
  heading: string;
  items: { href: string; label: string; badge?: keyof NavBadges }[];
}[] = [
  {
    heading: 'Overview',
    items: [{ href: '/admin', label: 'Overview' }],
  },
  {
    heading: 'Operations',
    items: [
      { href: '/admin/orders', label: 'Orders' },
      { href: '/admin/services', label: 'Services' },
      { href: '/admin/areas', label: 'Areas' },
      { href: '/admin/stores', label: 'Stores' },
      { href: '/admin/fleet', label: 'Fleet', badge: 'fleet' },
      { href: '/admin/users', label: 'People' },
      { href: '/admin/support', label: 'Support', badge: 'support' },
    ],
  },
  {
    heading: 'Money',
    items: [
      { href: '/admin/payments', label: 'Payments' },
      { href: '/admin/settlement', label: 'Settlement' },
      { href: '/admin/surge', label: 'Surge' },
    ],
  },
  {
    heading: 'Growth',
    items: [
      { href: '/admin/subscriptions', label: 'Plus' },
      { href: '/admin/loyalty', label: 'Points' },
      { href: '/admin/promo', label: 'Promo' },
      { href: '/admin/gift-cards', label: 'Gift cards' },
      { href: '/admin/referrals', label: 'Referrals' },
    ],
  },
  {
    heading: 'System',
    items: [
      { href: '/admin/health', label: 'Delivery health' },
      { href: '/admin/errors', label: 'Errors', badge: 'errors' },
      { href: '/admin/audit', label: 'Audit log' },
    ],
  },
];

export function AdminSidebar({
  badges,
  compact = false,
}: {
  badges: NavBadges;
  /**
   * The phone shape: one horizontally scrolling row instead of a column.
   *
   * Without it the full column rendered above the dashboard on a phone, so
   * nineteen links and five headings stood between somebody opening the
   * console and seeing a single number — which is worse than the wrapping
   * header this replaced, not better.
   */
  compact?: boolean;
}) {
  const pathname = usePathname();
  const [filter, setFilter] = useState('');

  const isCurrent = (href: string) =>
    href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);

  /* Above the early return below, and it has to stay there: a hook called
     after a conditional `return` is called on some renders and not others,
     which is the one thing the rules of hooks forbid. */
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return GROUPS;
    return GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.label.toLowerCase().includes(needle)),
    })).filter((group) => group.items.length > 0);
  }, [filter]);

  if (compact) {
    const items = GROUPS.flatMap((group) => group.items);
    return (
      <nav
        aria-label="Console"
        className="flex gap-1.5 overflow-x-auto px-3 py-2"
        style={{ scrollbarWidth: 'none' }}
      >
        {items.map((item) => {
          const count = item.badge ? badges[item.badge] : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isCurrent(item.href) ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-bold ${
                isCurrent(item.href)
                  ? 'bg-brand-600 text-white'
                  : 'bg-surface-sunken text-ink-muted'
              }`}
            >
              {item.label}
              {count > 0 ? (
                <span
                  className={`rounded-full px-1.5 text-[10.5px] ${
                    isCurrent(item.href) ? 'bg-white/25' : 'bg-brand-600 text-white'
                  }`}
                >
                  {count > 99 ? '99+' : count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Console"
      className="flex h-full flex-col gap-3 overflow-y-auto px-3 pb-6 pt-4"
    >
      <label className="block px-1">
        <span className="sr-only">Filter the menu</span>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter menu"
          className="w-full rounded-xl bg-surface-sunken px-3 py-2 text-[13px] ring-1 ring-ink/[0.08] placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>

      {groups.length === 0 ? (
        <p className="px-3 py-4 text-center text-[12px] text-ink-faint">
          Nothing matches “{filter}”.
        </p>
      ) : null}

      {groups.map((group) => (
        <div key={group.heading}>
          <h2 className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint">
            {group.heading}
          </h2>
          <ul>
            {group.items.map((item) => {
              /* Exact match for the root, prefix for the rest — otherwise
                 "Overview" is highlighted on every screen in the console,
                 which is the same as highlighting nothing. */
              const current = isCurrent(item.href);
              const count = item.badge ? badges[item.badge] : 0;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={current ? 'page' : undefined}
                    className={`mb-0.5 flex items-center gap-2 rounded-xl px-3 py-2 text-[13.5px] font-bold transition-colors ${
                      current
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {/* A badge only when there is something to answer for.
                        A grey zero beside every heading trains an operator to
                        stop looking at the numbers. */}
                    {count > 0 ? (
                      <span className="shrink-0 rounded-full bg-brand-600 px-2 py-0.5 text-[10.5px] font-bold text-white">
                        {count > 99 ? '99+' : count}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
