import { StoreRole } from '@prisma/client';
import { requireStoreAccess, roleSatisfies } from '@/lib/merchant/access';
import { storeMenu, storeMenuStock } from '@/lib/merchant/menu';
import { categoriesOf, groupByCategory } from '@/lib/merchant/menu-policy';
import { describeStock } from '@/lib/merchant/menu-stock';
import { MenuItemForm } from '@/components/merchant/MenuItemForm';
import { MenuRow } from '@/components/merchant/MenuRow';
import { MenuSection } from '@/components/merchant/MenuSection';
import { MenuStockNotice } from '@/components/merchant/MenuStockNotice';

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
  const [items, menu] = await Promise.all([
    storeMenu(access.store.id),
    // Replaces the option-group COUNT this screen used to load beside the
    // menu: satisfiability needs the options themselves, so the count for
    // each row's "2 choices" link comes off the same read.
    storeMenuStock(access.store.id),
  ]);

  const canEdit = roleSatisfies(access.role, StoreRole.MANAGER);
  const groups = groupByCategory(items);
  const sections = categoriesOf(items);

  return (
    <main className="pb-8">
      {/*
        Leads with what a customer can order rather than with how many rows
        exist. The line here read "11 items · 4 out of stock", which counted
        rows and was silent about a dish that was in stock and unorderable —
        the case that costs the shop an order without looking like anything.
      */}
      <p className="px-4 py-3 text-xs text-ink-muted">
        {describeStock(menu.stock, items.length)}
        {canEdit ? '' : ' · Staff can mark items out of stock'}
      </p>

      <MenuStockNotice storeId={access.store.id} stock={menu.stock} />

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
                compareAtPriceCentavos: item.compareAtPriceCentavos,
                isAvailable: item.isAvailable,
                isFirstInSection: position === 0,
                isLastInSection: position === group.items.length - 1,
                imageId: item.image?.id ?? null,
                optionGroupCount: menu.groupCounts.get(item.id) ?? 0,
                stock: menu.byItem.get(item.id) ?? {
                  // Only reachable if the two reads raced a delete, in which
                  // case the row is about to disappear; treating it as fine is
                  // better than crashing the menu over it.
                  id: item.id,
                  name: item.name,
                  reason: null,
                  outFor: 'UNKNOWN',
                  phrase: null,
                  blockedByGroups: [],
                  sellable: true,
                },
              }}
            />
          ))}
        </MenuSection>
      ))}

      {canEdit ? <MenuItemForm storeId={access.store.id} sections={sections} /> : null}
    </main>
  );
}
