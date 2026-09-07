import { StoreRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireStoreAccess, roleSatisfies } from '@/lib/merchant/access';
import { MenuRow } from '@/components/merchant/MenuRow';

export const dynamic = 'force-dynamic';

/**
 * Menu management.
 *
 * Grouped by the store's own category strings, so a merchant sees their menu
 * the way they wrote it rather than in an order we imposed.
 */
export default async function MerchantMenuPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await requireStoreAccess(storeId);

  const items = await prisma.menuItem.findMany({
    where: { storeId: access.store.id },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
  });

  const canEditPrice = roleSatisfies(access.role, StoreRole.MANAGER);

  const byCategory = new Map<string, typeof items>();
  for (const item of items) {
    const existing = byCategory.get(item.category);
    if (existing) existing.push(item);
    else byCategory.set(item.category, [item]);
  }

  const unavailable = items.filter((item) => !item.isAvailable).length;

  return (
    <main className="pb-8">
      <p className="px-4 py-3 text-xs text-ink-muted">
        {items.length} item{items.length === 1 ? '' : 's'}
        {unavailable > 0 ? ` · ${unavailable} unavailable` : ''}
        {canEditPrice ? '' : ' · Staff: cannot change prices'}
      </p>

      {Array.from(byCategory.entries()).map(([category, categoryItems]) => (
        <section key={category} aria-labelledby={`cat-${category}`} className="mt-2">
          <h2
            id={`cat-${category}`}
            className="px-4 pb-1 text-[13px] font-semibold uppercase tracking-wide text-ink-muted"
          >
            {category}
          </h2>
          <ul className="divide-y divide-black/5">
            {categoryItems.map((item) => (
              <MenuRow
                key={item.id}
                storeId={access.store.id}
                canEditPrice={canEditPrice}
                item={{
                  id: item.id,
                  name: item.name,
                  category: item.category,
                  priceCentavos: item.priceCentavos,
                  isAvailable: item.isAvailable,
                }}
              />
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
