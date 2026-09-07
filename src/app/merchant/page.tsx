import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAccessibleStores } from '@/lib/merchant/access';
import { loadMerchantQueue } from '@/lib/merchant/queue';
import { STORE_ROLE_LABELS } from '@/lib/merchant/staff-policy';

export const dynamic = 'force-dynamic';

/**
 * Store picker.
 *
 * Skipped entirely for the common case of one store — a chooser with a single
 * option is a wasted tap. It exists because a small chain owner holds several,
 * and because assuming one store is exactly the kind of shortcut that has to be
 * unpicked later.
 */
export default async function MerchantHomePage() {
  const memberships = await getAccessibleStores();

  if (memberships.length === 0) {
    return (
      <main className="px-4 py-10">
        <h1 className="text-xl font-bold">No stores</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Your account is not attached to any store yet. Contact support if
          that is wrong.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm font-semibold text-brand-700">
          ← Home
        </Link>
      </main>
    );
  }

  if (memberships.length === 1) {
    redirect(`/merchant/${memberships[0]!.storeId}`);
  }

  // Pending counts up front, so a chain owner sees where the pressure is
  // without opening each store.
  const withCounts = await Promise.all(
    memberships.map(async (membership) => ({
      membership,
      queue: await loadMerchantQueue(membership.storeId),
    })),
  );

  return (
    <main className="px-4 py-8">
      <h1 className="text-xl font-bold">Your stores</h1>
      <ul className="mt-4 space-y-2">
        {withCounts.map(({ membership, queue }) => {
          const needsDecision =
            queue.stages.find((entry) => entry.stage.key === 'needs-decision')?.orders.length ?? 0;
          return (
            <li key={membership.id}>
              <Link
                href={`/merchant/${membership.storeId}`}
                className="flex items-center gap-3 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5 transition-colors hover:bg-brand-50/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{membership.store.name}</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {STORE_ROLE_LABELS[membership.role]}
                    {membership.store.isOpen ? '' : ' · Sarado'}
                  </span>
                </span>
                {needsDecision > 0 ? (
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900 tabular-nums">
                    {needsDecision} new
                  </span>
                ) : null}
                <span aria-hidden className="shrink-0 text-xs text-ink-faint">
                  ›
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
