import { redirect } from 'next/navigation';
import { SettlementParty } from '@prisma/client';
import { getFleetPartner } from '@/lib/fleet/partner';
import { lastPayout, positionOf, statementFor } from '@/lib/settlement/ledger';
import { PositionPanel } from '@/components/settlement/PositionPanel';

export const dynamic = 'force-dynamic';

/**
 * Where a rider stands with TARA.
 *
 * Separate from `/fleet/history`, which lists jobs and what each paid. This is
 * the running total, and the number on it that matters is the one nobody could
 * see before: **the cash they are holding.** A rider finishing a shift with
 * ₱2,400 of other people's money in their bag needs that stated plainly, and
 * so does whoever they hand it to.
 */
export default async function FleetEarningsPage() {
  const partner = await getFleetPartner();
  if (!partner) {
    redirect('/fleet/apply');
  }

  const ref = { party: 'FLEET_PARTNER' as const, fleetPartnerId: partner.id };
  const [position, entries, latestPayout] = await Promise.all([
    positionOf(ref),
    statementFor(ref, 60),
    lastPayout(ref),
  ]);

  return (
    <main className="space-y-3 px-4 py-4">
      <PositionPanel
        party={SettlementParty.FLEET_PARTNER}
        position={position}
        entries={entries}
        lastPayout={latestPayout}
      />
    </main>
  );
}
