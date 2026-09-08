import { StoreRole } from '@prisma/client';
import { requireStoreAccess } from '@/lib/merchant/access';
import { storeTierStanding } from '@/lib/merchant/tier-customers';
import { TierStandingPanel } from '@/components/merchant/TierStandingPanel';

export const dynamic = 'force-dynamic';

/**
 * What TARA's loyalty statuses mean to this shop.
 *
 * STAFF, not MANAGER. This deliberately differs from Payouts, which is
 * MANAGER-and-above because a shop's takings are the owner's business. Nothing
 * on this page is a takings figure: the counts are about the shop's customers,
 * and whoever is working the counter is the person who benefits from knowing
 * that the name on the next order belongs to a regular. Locking that behind
 * the owner's login would put it in front of the one person not standing at
 * the counter.
 *
 * The subtotal figure is the closest thing to takings here, and it is gross
 * food value over ninety days rather than anything owed — the same number the
 * queue card already shows on every single order, added up.
 */
export default async function MerchantRegularsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await requireStoreAccess(storeId, StoreRole.STAFF);
  const standing = await storeTierStanding(access.store.id);

  return (
    <main className="space-y-3 px-4 py-4">
      <div className="px-1">
        <h1 className="text-lg font-bold">Your regulars</h1>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
          Customers who order enough across TARA to earn a status, and what that
          status changes about their orders here.
        </p>
      </div>

      <TierStandingPanel standing={standing} />
    </main>
  );
}
