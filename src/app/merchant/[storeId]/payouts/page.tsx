import { SettlementParty, StoreRole } from '@prisma/client';
import { requireStoreAccess } from '@/lib/merchant/access';
import { positionOf, statementFor } from '@/lib/settlement/ledger';
import { PositionPanel } from '@/components/settlement/PositionPanel';
import { formatCentavos } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * What the shop is owed.
 *
 * MANAGER and above. Whoever is working the counter needs to accept orders and
 * mark things out of stock; what the business is owed is the owner's business,
 * and putting it on a shared till screen is how a shop's takings end up common
 * knowledge among staff.
 */
export default async function MerchantPayoutsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await requireStoreAccess(storeId, StoreRole.MANAGER);

  const ref = { party: 'STORE' as const, storeId: access.store.id };
  const [position, entries] = await Promise.all([
    positionOf(ref),
    statementFor(ref, 60),
  ]);

  return (
    <main className="space-y-3 px-4 py-4">
      <PositionPanel
        party={SettlementParty.STORE}
        position={position}
        entries={entries}
      />

      {access.store.commissionBasisPoints > 0 ? (
        <p className="px-1 text-[11px] leading-relaxed text-ink-faint">
          TARA keeps {(access.store.commissionBasisPoints / 100).toFixed(2)}% of
          the food on each order. The delivery fee goes to the rider, and so does
          the whole tip — neither is yours to be charged commission on.
        </p>
      ) : (
        <p className="px-1 text-[11px] leading-relaxed text-ink-faint">
          No commission is set for this shop, so you are owed the full food
          subtotal on every completed order. The delivery fee and the tip go to
          the rider.
        </p>
      )}

      {position.earnedCentavos > 0 ? (
        <p className="px-1 text-[11px] leading-relaxed text-ink-faint">
          Earned {formatCentavos(position.earnedCentavos)} in total since you
          joined.
        </p>
      ) : null}
    </main>
  );
}
