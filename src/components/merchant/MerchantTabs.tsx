'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Back-office tabs. Menu and settings are separated because they are edited
 *  on different rhythms: availability changes hourly, settings almost never. */
export function MerchantTabs({ storeId }: { storeId: string }) {
  const pathname = usePathname();
  const base = `/merchant/${storeId}`;

  const tabs = [
    { href: base, label: 'Queue' },
    { href: `${base}/menu`, label: 'Menu' },
    { href: `${base}/history`, label: 'History' },
    { href: `${base}/settings`, label: 'Settings' },
  ];

  return (
    <nav aria-label="Store sections" className="mt-3 -mb-3 flex gap-1 overflow-x-auto">
      {tabs.map((tab) => {
        const isCurrent = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isCurrent ? 'page' : undefined}
            className={`shrink-0 border-b-2 px-3 pb-2.5 text-xs font-semibold transition-colors ${
              isCurrent
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-ink-faint hover:text-ink-muted'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
