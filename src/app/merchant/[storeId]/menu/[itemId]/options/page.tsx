import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StoreRole } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireStoreAccess, roleSatisfies } from '@/lib/merchant/access';
import { itemOptionGroups } from '@/lib/merchant/options';
import { unsatisfiableGroups } from '@/lib/merchant/option-policy';
import { OptionEditor } from '@/components/merchant/OptionEditor';
import { formatCentavos } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * The choices on one dish.
 *
 * Its own screen rather than a panel on the menu row, because this is a
 * two-level list — questions, and answers under them — and nesting that
 * inside a row makes both harder to read. The menu links here with a count, so
 * a shop can see at a glance which dishes ask something.
 *
 * Everything a viewer may do is decided here, on the server, from their real
 * membership; the editor renders controls and each action checks again.
 */
export default async function MenuItemOptionsPage({
  params,
}: {
  params: Promise<{ storeId: string; itemId: string }>;
}) {
  const { storeId, itemId } = await params;
  const access = await requireStoreAccess(storeId);

  const item = await prisma.menuItem.findFirst({
    where: { id: itemId, storeId: access.store.id },
    select: { id: true, name: true, priceCentavos: true, category: true },
  });
  if (!item) notFound();

  const groups = await itemOptionGroups({ storeId: access.store.id, menuItemId: item.id });
  const canEdit = roleSatisfies(access.role, StoreRole.MANAGER);
  const stuck = unsatisfiableGroups(groups);

  return (
    <main className="space-y-4 px-4 py-4 pb-8">
      <div>
        <Link
          href={`/merchant/${access.store.id}/menu`}
          className="text-[11px] font-semibold text-brand-700"
        >
          ← Menu
        </Link>
        <h1 className="mt-1 text-base font-bold">{item.name}</h1>
        <p className="mt-0.5 text-[11px] text-ink-muted">
          {item.category} · {formatCentavos(item.priceCentavos)} before choices
          {canEdit ? '' : ' · staff can mark answers out of stock'}
        </p>
      </div>

      {stuck.length > 0 ? (
        <p className="rounded-xl bg-amber-50 px-3.5 py-3 text-[12px] leading-relaxed text-amber-900">
          {/* The one mistake here that a customer meets as a dead end: a
              required question whose answers have all run out means the dish
              cannot be ordered at all. Said here, where it can be fixed. */}
          <strong>Nobody can order this right now.</strong>{' '}
          {stuck.map((group) => `“${group.name}”`).join(', ')}{' '}
          {stuck.length === 1 ? 'asks for' : 'ask for'} more answers than are
          available. Mark something back in stock, add another answer, or lower
          what it asks for.
        </p>
      ) : null}

      <OptionEditor
        storeId={access.store.id}
        itemId={item.id}
        itemName={item.name}
        basePriceCentavos={item.priceCentavos}
        canEdit={canEdit}
        groups={groups.map((group, index) => ({
          id: group.id,
          name: group.name,
          minChoices: group.minChoices,
          maxChoices: group.maxChoices,
          isFirst: index === 0,
          isLast: index === groups.length - 1,
          options: group.options.map((option, position) => ({
            id: option.id,
            name: option.name,
            priceDeltaCentavos: option.priceDeltaCentavos,
            isAvailable: option.isAvailable,
            isFirst: position === 0,
            isLast: position === group.options.length - 1,
          })),
        }))}
      />
    </main>
  );
}
