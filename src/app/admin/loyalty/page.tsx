import { requireAdmin } from '@/lib/admin/access';
import { loyaltyOverview } from '@/lib/admin/loyalty';
import { formatCentavos } from '@/lib/money';
import { TierBenefitType } from '@prisma/client';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  MAX_TIER_PRIORITY_WEIGHT,
  TIER_BENEFIT_NAME,
  describeTierBenefit,
  isBillBenefit,
} from '@/lib/loyalty/tier-benefits';
import {
  setLoyaltyProgrammeAction,
  removeLoyaltyTierBenefitAction,
  setLoyaltyTierAction,
  setLoyaltyTierBenefitAction,
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
        description="What each tier earns, what it confers, and the most one customer at it can cost you in a month."
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
                <Th>Confers</Th>
                <Th numeric>Ceiling / month</Th>
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
                  <Td>
                    {tier.benefits.length === 0 ? (
                      <span className="text-ink-faint">
                        the earn rate only
                      </span>
                    ) : (
                      <ul className="space-y-1">
                        {tier.benefits.map((benefit) => (
                          <li key={benefit.id} className="flex flex-wrap items-baseline gap-1.5">
                            <span className="text-[12px] font-medium">
                              {TIER_BENEFIT_NAME[benefit.type]}
                            </span>
                            <Pill tone={isBillBenefit(benefit.type) ? 'warn' : 'neutral'}>
                              {isBillBenefit(benefit.type) ? 'costs money' : 'perk'}
                            </Pill>
                            <span className="block w-full text-[11px] leading-snug text-ink-faint">
                              {describeTierBenefit(benefit, formatCentavos)}
                            </span>
                            <div className="w-full max-w-[15rem]">
                              <ReasonForm
                                action={removeLoyaltyTierBenefitAction}
                                hidden={{ benefitId: benefit.id }}
                                submitLabel="Remove"
                                tone="danger"
                                placeholder="Why this stops"
                              >
                                Receipts for orders it already priced still name it.
                              </ReasonForm>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    <span className="mt-1 block text-[11px] leading-snug text-ink-faint">
                      {tier.blurb}
                    </span>
                  </Td>
                  <Td numeric>
                    {tier.benefits.length === 0 ? (
                      <span className="text-ink-faint">—</span>
                    ) : tier.monthlyCeilingCentavos === null ? (
                      <>
                        <Pill tone="warn">unbounded</Pill>
                        <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
                          {formatCentavos(tier.perOrderCeilingCentavos)} an order,
                          and nothing caps the orders
                        </span>
                      </>
                    ) : (
                      <>
                        {formatCentavos(tier.monthlyCeilingCentavos)}
                        <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
                          {formatCentavos(tier.perOrderCeilingCentavos)} an order
                          {tier.perkCount > 0
                            ? `, plus ${tier.perkCount} ${
                                tier.perkCount === 1 ? 'perk' : 'perks'
                              } that cost nothing`
                            : ''}
                        </span>
                      </>
                    )}
                  </Td>
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
        title="Give a tier a benefit"
        description={`Pick the tier and what it confers. Only the fields that type uses are read — the rest are cleared, so changing a benefit's type never leaves a stale number behind.`}
      >
        <div className="space-y-3 px-4 py-3">
          {overview.tiers.length === 0 ? (
            <Empty>
              Build the ladder first. A benefit with no tier to hang on is a
              benefit nobody can reach.
            </Empty>
          ) : (
            <ReasonForm
              action={setLoyaltyTierBenefitAction}
              hidden={{}}
              submitLabel="Give it to the tier"
              extraFields={
                <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-[11px] font-semibold text-ink-muted">
                        Tier
                      </span>
                      <select
                        name="tierId"
                        required
                        defaultValue=""
                        className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] font-semibold ring-1 ring-black/5"
                      >
                        <option value="" disabled>
                          Pick a tier
                        </option>
                        {overview.tiers.map((tier) => (
                          <option key={tier.id} value={tier.id}>
                            {tier.name} (from {tier.thresholdPoints})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-semibold text-ink-muted">
                        What it confers
                      </span>
                      <select
                        name="type"
                        required
                        defaultValue=""
                        className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] font-semibold ring-1 ring-black/5"
                      >
                        <option value="" disabled>
                          Pick one
                        </option>
                        {Object.values(TierBenefitType).map((type) => (
                          <option key={type} value={type}>
                            {TIER_BENEFIT_NAME[type]}
                            {isBillBenefit(type) ? ' — costs money' : ' — a perk'}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <Field
                    name="displayLabel"
                    label="The line the customer reads"
                    value=""
                  />

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Field name="minimumPesos" label="Free delivery: minimum order (₱)" value="" />
                    <Field name="monthlyCap" label="Free delivery: times / month" value="" />
                    <Field name="percent" label="Discount or credit-back (%)" value="" />
                    <Field name="maxDiscountPesos" label="Discount: cap / order (₱)" value="" />
                    <Field name="monthlyCeilingPesos" label="Credit-back: cap / month (₱)" value="" />
                    <Field
                      name="priorityMinutes"
                      label={`Priority: minutes (max ${MAX_TIER_PRIORITY_WEIGHT})`}
                      value=""
                    />
                  </div>
                </div>
              }
            >
              <span className="block">
                Leave every field a type does not use blank. A tier already
                carrying this benefit is UPDATED rather than given a second one
                &mdash; two free-delivery rows would not be two free deliveries,
                because the checkout takes the first that applies.
              </span>
              <span className="mt-1.5 block">
                <strong className="text-ink">
                  The two priority benefits are minutes of a head start, not a
                  separate queue.
                </strong>{' '}
                A customer who has waited longer than that still goes first, in
                dispatch and in support alike. That bound is what stops a busy
                Friday starving somebody&rsquo;s dinner while sukis keep
                arriving &mdash; and nobody would see it happen, because a
                starved order looks exactly like an order waiting for a rider.
              </span>
            </ReasonForm>
          )}

          {overview.tiers.some((tier) => tier.waivesDelivery) ? (
            <p
              role="alert"
              className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200"
            >
              <span className="font-semibold">
                A tier is giving away the thing Plus is priced on.
              </span>{' '}
              Free delivery is the headline benefit of the subscription you are
              trying to sell, and a customer who gets it for ordering often has
              one less reason to pay for it. That can be the right trade &mdash;
              a tier costs you nothing to run and a subscription needs a
              collection every month &mdash; but it is a decision about the
              plan, not just about the tier. A customer with both gets one
              waiver, and the tier&rsquo;s allowance is spent first so the
              subscription they paid for keeps its own.
            </p>
          ) : null}
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
