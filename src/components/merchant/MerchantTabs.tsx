'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { StoreRole } from '@prisma/client';
import { tabsFor } from '@/lib/merchant/roles';

/** Back-office tabs.
 *
 *  The list itself lives in `lib/merchant/roles.ts`, with the role each screen
 *  needs — so the staff screen can tell an owner what granting a role actually
 *  exposes without a second, rottable copy of the answer. This component
 *  renders whatever that map says this member may open.
 *
 *  Before the roles were honoured here at all, a STAFF member saw a Payouts tab,
 *  tapped it, and got "Something on our side broke": the page requires MANAGER
 *  and nothing caught the throw. The page refuses properly now too. */
export function MerchantTabs({
  storeId,
  role,
}: {
  storeId: string;
  role: StoreRole;
}) {
  const pathname = usePathname();
  const base = `/merchant/${storeId}`;

  const tabs = tabsFor(role).map((area) => ({
    href: area.path === null ? base : `${base}/${area.path}`,
    label: area.tab,
  }));

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
