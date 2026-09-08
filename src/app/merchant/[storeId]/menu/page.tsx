import { StoreRole } from '@prisma/client';
import { requireStoreAccess, roleSatisfies } from '@/lib/merchant/access';
import { storeMenu } from '@/lib/merchant/menu';
import { categoriesOf, describeMenu, groupByCategory } from '@/lib/merchant/menu-policy';
import { MenuItemForm } from '@/components/merchant/MenuItemForm';
import { MenuRow } from '@/components/merchant/MenuRow';
import { MenuSection } from '@/components/merchant/MenuSection';

export const dynamic = 'force-dynamic';

/**
 * The menu, as the shop's own document.
 *
 * Sections appear in the shop's order, not alphabetically, and the whole list
 * is editable here by a manager or the owner — which is new: before this the
 * screen could change a price and mark something out of stock, and the dishes
 * themselves could only be created by the seed file.
 *
 * Every "may I" question is answered HERE, on the server, from the viewer's
 * real membership, and passed down as one boolean. The client components
 * render controls; they never decide who may use them, and each action checks
 * the same role again — a hidden button is not an authorisation check.
 */
export default async function MerchantMenuPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await requireStoreAccess(storeId);
  const items = await storeMenu(access.store.id);

  const canEdit = roleSatisfies(access.role, StoreRole.MANAGER);
  const groups = groupByCategory(items);
  const sections = categoriesOf(items);
  const unavailable = items.filter((item) => !item.isAvailable).length;

  return (
    <main className="pb-8">
      <p className="px-4 py-3 text-xs text-ink-muted">
        {describeMenu({ items: items.length, unavailable })}
        {canEdit ? '' : ' · Staff can mark items out of stock'}
      </p>

      {items.length === 0 ? (
        <p className="mx-4 rounded-xl bg-amber-50 px-3.5 py-3 text-[12px] leading-relaxed text-amber-900">
          {canEdit ? (
            <>
              Nothing here yet. Add your dishes below — the shop cannot be made
              visible to customers until it has a menu, because they would open
              it and find an empty page.
            </>
          ) : (
            <>
              Nothing here yet. A manager or the owner adds the dishes; you can
              mark them out of stock once they are in.
            </>
          )}
        </p>
      ) : null}

      {groups.map((group, index) => (
        <MenuSection
          key={group.category}
          storeId={access.store.id}
          category={group.category}
          count={group.items.length}
          isFirst={index === 0}
          isLast={index === groups.length - 1}
          canEdit={canEdit}
        >
          {group.items.map((item, position) => (
            <MenuRow
              key={item.id}
              storeId={access.store.id}
              canEdit={canEdit}
              categories={sections}
              item={{
                id: item.id,
                name: item.name,
                description: item.description,
                category: item.category,
                priceCentavos: item.priceCentavos,
                isAvailable: item.isAvailable,
                isFirstInSection: position === 0,
                isLastInSection: position === group.items.length - 1,
              }}
            />
          ))}
        </MenuSection>
      ))}

      {canEdit ? <MenuItemForm storeId={access.store.id} sections={sections} /> : null}
    </main>
  );
}
