import { notFound } from 'next/navigation';
import { SettlementParty, StoreRole } from '@prisma/client';
import { requireStoreAccess } from '@/lib/merchant/access';
import { lastPayout, positionOf, statementFor } from '@/lib/settlement/ledger';
import { storeReferralSummary } from '@/lib/referrals/store-summary';
import { PositionPanel } from '@/components/settlement/PositionPanel';
import { StoreReferralPanel } from '@/components/settlement/StoreReferralPanel';
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

  /**
   * Caught, not left to throw. `requireStoreAccess` raises
   * `InsufficientStoreRoleError`, and an uncaught throw here was a **500** —
   * a STAFF member who tapped the Payouts tab got "Something on our side
   * broke, not anything you did". And because that error is a deliberate
   * expected refusal, nothing was ever written to the error page about it, so
   * it could have stayed that way indefinitely.
   *
   * `notFound()` matches what the layout already does one level up, and is the
   * same reasoning: the same answer whether the screen is missing or simply
   * not theirs. The tab is hidden from them too, so reaching this needs a
   * typed URL or a bookmark from when they were a manager.
   */
  let access;
  try {
    access = await requireStoreAccess(storeId, StoreRole.MANAGER);
  } catch {
    notFound();
  }

  const ref = { party: 'STORE' as const, storeId: access.store.id };
  const [position, entries, referrals, latestPayout] = await Promise.all([
    positionOf(ref),
    statementFor(ref, 60),
    storeReferralSummary(access.store.id),
    lastPayout(ref),
  ]);

  return (
    <main className="space-y-3 px-4 py-4">
      <PositionPanel
        party={SettlementParty.STORE}
        position={position}
        entries={entries}
        lastPayout={latestPayout}
        currentCommissionBasisPoints={access.store.commissionBasisPoints}
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

      {/* Below the balance, deliberately: a referral bonus is a line IN that
          balance, and the total above is also the number a shop this one
          introduced is measured against. */}
      <StoreReferralPanel summary={referrals} />
    </main>
  );
}
