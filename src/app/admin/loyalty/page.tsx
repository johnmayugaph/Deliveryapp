import { requireAdmin } from '@/lib/admin/access';
import { loyaltyOverview } from '@/lib/admin/loyalty';
import { formatCentavos } from '@/lib/money';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  setLoyaltyProgrammeAction,
  setLoyaltyTierAction,
} from '@/lib/actions/admin-actions';
import {
  Empty,
  Panel,
  Pill,
  Stat,
  TableScroll,
  Td,
  Th,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * Loyalty points.
 *
 * The screen exists for one figure: **what the outstanding points would cost
 * if everybody redeemed tomorrow.** Points are an obligation denominated in
 * your money, and that number is two rates away from the point count — easy to
 * get wrong by a factor of ten, and invisible until somebody adds up the
 * ledger.
 *
 * It sits beside the expiry setting deliberately. With no expiry configured
 * that figure only ever goes up, and the largest balances accumulate among the
 * customers who stopped ordering — the worst possible shape for a liability.
 *
 * The second figure worth the space is the stranded total: accounts holding
 * points below one redemption block, which can never be spent. A large one
 * means the block size is set too high and the programme is quietly not paying
 * out, which customers notice long before a dashboard does.
 */
export default async function AdminLoyaltyPage() {
  await requireAdmin();
  const overview = await loyaltyOverview();
  const { programme } = overview;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Loyalty points</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
          Customers earn points on the food in a completed order — not the
          delivery fee, surge or tip, which are the rider&rsquo;s — and turn them
          into credits in whole blocks. Points are never spendable themselves,
          so there is still only one balance a customer can spend. Off until you
          set the rates.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Programme"
          value={overview.isLive ? 'On' : 'Off'}
          note={
            overview.isLive
              ? `Giving back ${(overview.givebackBasisPoints / 100).toFixed(2)}% of food value`
              : 'Nothing earns and the points screen says so'
          }
        />
        <Stat
          label="Points outstanding"
          value={overview.pointsOutstanding.toLocaleString('en-PH')}
          note={`Held by ${overview.accountsHoldingPoints} account(s)`}
        />
        <Stat
          label="If everybody redeemed"
          value={formatCentavos(overview.liabilityCentavos)}
          note={
            programme.expiryMonths > 0
              ? `Points expire after ${programme.expiryMonths} months`
              : 'Points never expire, so this only goes up'
          }
        />
        <Stat
          label="Paid out so far"
          value={formatCentavos(overview.redeemedCentavos)}
          note={`${overview.pointsRedeemed.toLocaleString('en-PH')} points redeemed`}
        />
      </div>

      {overview.isLive && programme.expiryMonths === 0 ? (
        <p
          role="alert"
          className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200"
        >
          <span className="font-semibold">Points never expire at this setting.</span>{' '}
          That is a choice, not a mistake — but it means{' '}
          {formatCentavos(overview.liabilityCentavos)} of obligation can only grow,
          and it grows fastest among customers who have stopped ordering, which is
          the worst shape for it. An expiry window is the only thing that bounds it.
        </p>
      ) : null}

      {overview.strandedAccounts > 0 ? (
        <p className="rounded-xl bg-surface px-4 py-3 text-xs leading-relaxed text-ink-muted shadow-sm ring-1 ring-black/5">
          <span className="font-semibold text-ink">
            {overview.strandedAccounts} account(s) hold{' '}
            {overview.strandedPoints.toLocaleString('en-PH')} points they cannot
            redeem
          </span>{' '}
          — below one block of{' '}
          {programme.redemptionBlockPoints.toLocaleString('en-PH')}. A little of
          this is normal. A lot of it means the block is too big, and the
          programme is quietly not paying out.
        </p>
      ) : null}

      <Panel
        title="The rates"
        description="Earning is points per peso of food. Redemption is points per peso of credits. They point in opposite directions, which is why the giveback percentage is shown above rather than left for you to derive."
      >
        <div className="px-4 py-3">
          <ReasonForm
            action={setLoyaltyProgrammeAction}
            hidden={{ isActive: String(!programme.isActive) }}
            submitLabel={programme.isActive ? 'Save and switch OFF' : 'Save and switch ON'}
            tone={programme.isActive ? 'danger' : 'default'}
            extraFields={
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Field
                  name="pointsPerPeso"
                  label="Points per ₱1 spent"
                  value={(programme.pointsPerPesoBasisPoints / 10_000).toString()}
                />
                <Field
                  name="pointsPerPesoRedeemed"
                  label="Points per ₱1 back"
                  value={String(programme.pointsPerPesoRedeemed)}
                />
                <Field
                  name="redemptionBlockPoints"
                  label="Redeem in blocks of"
                  value={String(programme.redemptionBlockPoints)}
                />
                <Field
                  name="expiryMonths"
                  label="Expire after (months)"
                  value={String(programme.expiryMonths)}
                />
                <Field
                  name="tierWindowMonths"
                  label="Tier window (months)"
                  value={String(programme.tierWindowMonths)}
                />
              </div>
            }
          >
            Switching points off leaves every balance where it is — nothing is
            taken, and customers can redeem again when you switch it back on. The
            tier window is rolling rather than lifetime, so a tier can be lost;
            a tier nobody can lose is not a reason to order again.
          </ReasonForm>
        </div>
      </Panel>

      <Panel
        title="Tiers"
        description="A tier changes ONE thing: how fast points are earned. Deliberately not a fourth way to discount a bill — this app already has three, and each interacts with the others at the checkout."
      >
        {overview.tiers.length === 0 ? (
          <Empty>
            No tiers. Points still earn at the base rate; nobody has a status.
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th numeric>From (points)</Th>
                <Th numeric>Earns</Th>
                <Th numeric>Customers</Th>
                <Th>What it says</Th>
              </tr>
            </thead>
            <tbody>
              {overview.tiers.map((tier) => (
                <tr key={tier.id}>
                  <Td>
                    <Pill tone="good">{tier.name}</Pill>
                  </Td>
                  <Td numeric>{tier.thresholdPoints.toLocaleString('en-PH')}</Td>
                  <Td numeric>
                    {(tier.earnMultiplierBasisPoints / 10_000).toFixed(2)}×
                  </Td>
                  <Td numeric>{tier.holders}</Td>
                  <Td muted>{tier.blurb}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Add or change a tier"
        description="Leave the id blank to add one. Thresholds and names have to be distinct, or which tier applies would be a coin flip."
      >
        <div className="px-4 py-3">
          <ReasonForm
            action={setLoyaltyTierAction}
            hidden={{}}
            submitLabel="Save the tier"
            extraFields={
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Field name="tierId" label="Id (blank to add)" value="" />
                  <Field name="name" label="Name" value="" />
                  <Field name="thresholdPoints" label="From (points)" value="0" />
                  <Field name="multiplier" label="Earn ×" value="1" />
                </div>
                <Field
                  name="blurb"
                  label="What it says to the customer"
                  value=""
                />
              </div>
            }
          >
            Nobody is re-scored retroactively: a tier applies to orders from the
            moment it exists, the same way a rider&rsquo;s settled earnings keep
            the rate they were paid at.
          </ReasonForm>
        </div>
      </Panel>

      <Panel
        title="The ledger, end to end"
        description="Earned, redeemed and expired since the beginning. These three should account for the outstanding balance exactly."
      >
        <TableScroll>
          <thead>
            <tr>
              <Th>Movement</Th>
              <Th numeric>Points</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>Earned</Td>
              <Td numeric>+{overview.pointsEarned.toLocaleString('en-PH')}</Td>
            </tr>
            <tr>
              <Td>Redeemed</Td>
              <Td numeric>−{overview.pointsRedeemed.toLocaleString('en-PH')}</Td>
            </tr>
            <tr>
              <Td>Expired</Td>
              <Td numeric>−{overview.pointsExpired.toLocaleString('en-PH')}</Td>
            </tr>
            <tr>
              <Td>
                <strong>Outstanding</strong>
              </Td>
              <Td numeric>
                <strong>{overview.pointsOutstanding.toLocaleString('en-PH')}</strong>
              </Td>
            </tr>
          </tbody>
        </TableScroll>
      </Panel>
    </div>
  );
}

function Field({
  name,
  label,
  value,
}: {
  name: string;
  label: string;
  value: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-ink-muted">{label}</span>
      <input
        name={name}
        defaultValue={value}
        className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
    </label>
  );
}
