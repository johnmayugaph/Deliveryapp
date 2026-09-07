import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireStoreAccess, STORE_ROLE_LABELS } from '@/lib/merchant/access';
import { getAccessibleStores } from '@/lib/merchant/access';
import { MerchantTabs } from '@/components/merchant/MerchantTabs';
import { StoreOpenToggle } from '@/components/merchant/StoreOpenToggle';
import { NotificationBell } from '@/components/notifications/NotificationBell';

export const dynamic = 'force-dynamic';

/**
 * The merchant shell.
 *
 * Its own layout, with its own tabs — the customer's bottom navigation would
 * offer Credits and Orders to somebody running a kitchen. Access is checked
 * here, once, so every page beneath it can assume the store is theirs.
 */
export default async function MerchantStoreLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

  let access;
  try {
    access = await requireStoreAccess(storeId);
  } catch {
    // Same answer whether the store is missing or simply not theirs, so this
    // cannot be used to discover other stores' ids.
    notFound();
  }

  const memberships = await getAccessibleStores();

  return (
    <div className="min-h-dvh bg-surface-sunken pb-6">
      <header className="bg-surface px-4 pb-3 pt-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {memberships.length > 1 ? (
              <Link href="/merchant" className="text-[11px] font-semibold text-brand-700">
                ← Your stores
              </Link>
            ) : (
              <Link href="/" className="text-[11px] font-semibold text-brand-700">
                ← Customer app
              </Link>
            )}
            <h1 className="mt-1 truncate text-lg font-bold">{access.store.name}</h1>
            <p className="text-[11px] text-ink-muted">
              {STORE_ROLE_LABELS[access.role]} · {access.store.preparationMinutes} min prep
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <NotificationBell userId={access.user.id} />
            <StoreOpenToggle storeId={access.store.id} isOpen={access.store.isOpen} />
          </div>
        </div>

        <MerchantTabs storeId={access.store.id} />
      </header>

      {children}
    </div>
  );
}
