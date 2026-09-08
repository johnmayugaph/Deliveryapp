'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { StoreRole } from '@prisma/client';
import { roleSatisfies } from '@/lib/merchant/roles';

/** Back-office tabs. Menu and settings are separated because they are edited
 *  on different rhythms: availability changes hourly, settings almost never.
 *
 *  Each tab carries the minimum role its screen requires, and a tab this
 *  member cannot open is not rendered. Before that, a STAFF member saw a
 *  Payouts tab, tapped it, and got "Something on our side broke" — the page
 *  calls `requireStoreAccess(…, MANAGER)` and the throw became a 500. Worse,
 *  `InsufficientStoreRoleError` is a deliberate expected refusal, so nothing
 *  was ever recorded about it. The page refuses properly now too; this is the
 *  half that stops anybody being invited to try. */
export function MerchantTabs({
  storeId,
  role,
}: {
  storeId: string;
  role: StoreRole;
}) {
  const pathname = usePathname();
  const base = `/merchant/${storeId}`;

  const tabs = [
    { href: base, label: 'Queue', needs: StoreRole.STAFF },
    { href: `${base}/menu`, label: 'Menu', needs: StoreRole.STAFF },
    { href: `${base}/history`, label: 'History', needs: StoreRole.STAFF },
    // Who the shop's regulars are is counter knowledge, not takings.
    { href: `${base}/regulars`, label: 'Regulars', needs: StoreRole.STAFF },
    // The only screen that refuses outright. Staff and Settings admit a STAFF
    // member and degrade to read-only — `canRevoke` and `canEdit` — so hiding
    // those would take away screens they can legitimately look at. The first
    // version of this list marked all three MANAGER and was wrong for two.
    { href: `${base}/payouts`, label: 'Payouts', needs: StoreRole.MANAGER },
    { href: `${base}/staff`, label: 'Staff', needs: StoreRole.STAFF },
    { href: `${base}/settings`, label: 'Settings', needs: StoreRole.STAFF },
  ].filter((tab) => roleSatisfies(role, tab.needs));

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
