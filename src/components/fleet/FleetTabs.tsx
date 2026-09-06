'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Partner tabs. "Job" is first because a partner with a job cares about nothing else. */
export function FleetTabs({ hasActiveJob }: { hasActiveJob: boolean }) {
  const pathname = usePathname();

  const tabs = [
    { href: '/fleet', label: 'Offers' },
    { href: '/fleet/job', label: hasActiveJob ? 'Job ●' : 'Job' },
    { href: '/fleet/history', label: 'History' },
    { href: '/fleet/profile', label: 'Profile' },
  ];

  return (
    <nav aria-label="Fleet sections" className="mt-3 -mb-3 flex gap-1 overflow-x-auto">
      {tabs.map((tab) => {
        const isCurrent = tab.href === '/fleet' ? pathname === '/fleet' : pathname.startsWith(tab.href);
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
