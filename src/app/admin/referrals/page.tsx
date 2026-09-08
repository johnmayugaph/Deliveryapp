import Link from 'next/link';
import { ReferralStatus } from '@prisma/client';
import { requireAdmin } from '@/lib/admin/access';
import { referralOverview } from '@/lib/admin/referrals';
import { partnerReferralOverview } from '@/lib/admin/partner-referrals';
import { storeReferralOverview } from '@/lib/admin/store-referrals';
import { MAX_REWARD_CENTAVOS } from '@/lib/referrals/policy';
import { MAX_PARTNER_REWARD_CENTAVOS } from '@/lib/referrals/partner-policy';
import { MAX_STORE_REWARD_CENTAVOS } from '@/lib/referrals/store-policy';
import { formatCentavos } from '@/lib/money';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  setPartnerReferralProgrammeAction,
  setReferralProgrammeAction,
  setStoreReferralProgrammeAction,
} from '@/lib/actions/admin-actions';
import {
  Empty,
  Panel,
  Pill,
  Stat,
  TableScroll,
  Td,
  Th,
  PersonLink,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * Referrals.
 *
 * The screen exists to make one number impossible to miss: **what a person
 * referring themselves nets at the amounts currently set.** Every referral
 * programme has that number. Almost none of them show it, which is why so many
 * get quietly farmed for a month before somebody adds up the ledger.
 *
 * It is a warning rather than a refusal. A launch subsidy that loses money per
 * account can be a deliberate choice; buying accounts by accident cannot.
 *
 * Everything else here is the ordinary console shape: what the programme is,
 * what it has cost, why it refused to pay, and who is earning most.
 */
export default async function AdminReferralsPage() {
  await requireAdmin();
  const [overview, partner, store] = await Promise.all([
    referralOverview(),
    partnerReferralOverview(),
    storeReferralOverview(),
  ]);
  const { programme, margin } = overview;

  // The one piece of arithmetic this programme needs and neither of the other
  // two has: the bonus and the commission are in the SAME units, so they can
  // be subtracted. `breakEven` is how much a shop acquired this way has to
  // earn through TARA before the commission on it has covered the bonus.
  const commissionBp = store.typicalCommissionBasisPoints;
  const earnsItBack =
    commissionBp !== null &&
    store.cost.costBasisPointsOfEarnings <= commissionBp;
  const breakEvenCentavos =
    commissionBp !== null && commissionBp > 0
      ? Math.ceil((store.cost.bothSidesCentavos * 10_000) / commissionBp)
      : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Referrals</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
          A referral pays the invited person credits when their account is
          attributed, and the inviter credits only once that person&rsquo;s first
          order has been delivered. Credits can only be spent on orders — never
          transferred, never cashed out — so the worst case is discounted food
          rather than lost money. Off until you set the amounts.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Programme"
          value={overview.isLive ? 'On' : 'Off'}
          note={
            overview.isLive
              ? `${formatCentavos(programme.refereeCentavos)} to them, ${formatCentavos(programme.referrerCentavos)} to the inviter`
              : 'Codes earn nothing and the invite screen says so'
          }
        />
        <Stat
          label="Waiting on a first order"
          value={String(overview.attributed)}
          note="Attributed, inviter not yet paid"
        />
        <Stat
          label="Paid"
          value={String(overview.rewarded)}
          note={`${overview.rewardedThisMonth} this month`}
        />
        <Stat
          label="Granted in credits"
          value={formatCentavos(overview.paidOutCentavos)}
          note="Both sides, from the credits ledger"
        />
      </div>

      {overview.isLive && margin.farmingPays ? (
        <p
          role="alert"
          className="rounded-xl bg-rose-50 px-4 py-3 text-xs leading-relaxed text-rose-800 ring-1 ring-rose-200"
        >
          <span className="font-semibold">
            At these amounts, referring yourself pays.
          </span>{' '}
          One person with a second phone number collects{' '}
          {formatCentavos(margin.bothSidesCentavos)} across both sides and needs
          to place an order of only{' '}
          {formatCentavos(programme.minimumOrderCentavos)} to unlock it — netting{' '}
          <strong>{formatCentavos(margin.netCentavos)}</strong> per account, in
          credits. Raise the minimum order above the two amounts combined, or
          lower them, unless this is a subsidy you mean to pay.
        </p>
      ) : overview.isLive ? (
        <p className="rounded-xl bg-emerald-50 px-4 py-3 text-xs leading-relaxed text-emerald-900 ring-1 ring-emerald-200">
          <span className="font-semibold">Self-referral costs money.</span>{' '}
          Somebody using their own second number collects{' '}
          {formatCentavos(margin.bothSidesCentavos)} but must buy{' '}
          {formatCentavos(programme.minimumOrderCentavos)} of food to unlock it,
          so they are {formatCentavos(-margin.netCentavos)} down per account —
          and hold credits they can only spend on more orders. The caps bound the
          rest: at most{' '}
          {formatCentavos(overview.liabilityPerReferrerCentavos)} to any one
          account, ever.
        </p>
      ) : null}

      <Panel
        title="The programme"
        description={`Both amounts are per referral, and one side may be worth at most ${formatCentavos(MAX_REWARD_CENTAVOS)}. Changing them never alters a referral already attributed.`}
      >
        <div className="px-4 py-3">
          <ReasonForm
            action={setReferralProgrammeAction}
            hidden={{ isActive: String(!programme.isActive) }}
            submitLabel={programme.isActive ? 'Save and switch OFF' : 'Save and switch ON'}
            tone={programme.isActive ? 'danger' : 'default'}
            extraFields={
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Field
                  name="refereePesos"
                  label="To them (₱)"
                  value={(programme.refereeCentavos / 100).toFixed(2)}
                />
                <Field
                  name="referrerPesos"
                  label="To the inviter (₱)"
                  value={(programme.referrerCentavos / 100).toFixed(2)}
                />
                <Field
                  name="minimumPesos"
                  label="Minimum order (₱)"
                  value={(programme.minimumOrderCentavos / 100).toFixed(2)}
                />
                <Field
                  name="monthlyCap"
                  label="Cap / month"
                  value={String(programme.monthlyRewardCap)}
                />
                <Field
                  name="lifetimeCap"
                  label="Cap / lifetime"
                  value={String(programme.lifetimeRewardCap)}
                />
              </div>
            }
          >
            The caps are per inviter and count referrals actually PAID, so
            somebody whose friends signed up and never ordered has used none of
            their allowance. They are what turns this from an open-ended
            liability into a budget — an enthusiast and a farmer look identical
            for the first few.
          </ReasonForm>
        </div>
      </Panel>

      <Panel
        title="Why referrals did not pay"
        description="The tuning signal. A minimum order nobody clears, or a cap everybody hits, shows up here first."
      >
        {overview.refusals.length === 0 ? (
          <Empty>
            Nothing has been refused. With {overview.attributed} waiting on a
            first order, that is either a healthy programme or a young one.
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Reason</Th>
                <Th numeric>Referrals</Th>
              </tr>
            </thead>
            <tbody>
              {overview.refusals.map((row) => (
                <tr key={row.reason}>
                  <Td>{row.reason}</Td>
                  <Td numeric>{row.count}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Earning most"
        description="Not an accusation — an enthusiast with a big family looks exactly like this. It is where to look first if the ledger surprises you."
      >
        {overview.topReferrers.length === 0 ? (
          <Empty>Nobody has been paid for a referral yet.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Phone</Th>
                <Th numeric>Paid referrals</Th>
                <Th numeric>Earned</Th>
                <Th>Against the lifetime cap</Th>
              </tr>
            </thead>
            <tbody>
              {overview.topReferrers.map((row) => (
                <tr key={row.userId}>
                  <Td>
                    <PersonLink
                      user={{ id: row.userId, fullName: row.name, phone: row.phone }}
                    />
                  </Td>
                  <Td muted>{formatPhilippineMobile(row.phone)}</Td>
                  <Td numeric>{row.rewarded}</Td>
                  <Td numeric>{formatCentavos(row.earnedCentavos)}</Td>
                  <Td>
                    {programme.lifetimeRewardCap > 0 ? (
                      <Pill
                        tone={
                          row.rewarded >= programme.lifetimeRewardCap ? 'warn' : 'neutral'
                        }
                      >
                        {row.rewarded} of {programme.lifetimeRewardCap}
                      </Pill>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      {/* ---------------------------------------------------------------- */}

      <div className="border-t border-black/10 pt-5">
        <h2 className="text-lg font-bold">Rider invites</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
          A rider who brings a rider is paid <strong>money</strong>, not
          credits: a bonus is added to what TARA owes them and goes out with
          their next payout, on the same ledger as the fees they earn riding.
          Credits would be no use to somebody who does not order lunch.
          Off until you set the amounts.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Programme"
          value={partner.isLive ? 'On' : 'Off'}
          note={
            partner.isLive
              ? `${formatCentavos(partner.programme.referrerCentavos)} to the inviter, ${formatCentavos(partner.programme.refereeCentavos)} to them`
              : 'Codes earn no rider bonus and the apply screen hides the field'
          }
        />
        <Stat
          label="A rider costs"
          value={formatCentavos(partner.cost.bothSidesCentavos)}
          note={
            partner.cost.qualifyingDeliveries > 0
              ? `${formatCentavos(partner.cost.perQualifyingDeliveryCentavos)} per delivery over ${partner.cost.qualifyingDeliveries}`
              : 'No delivery threshold set'
          }
        />
        <Stat
          label="Riding to their bonus"
          value={String(partner.attributed)}
          note={`${partner.rewarded} paid, ${partner.notRewarded} closed unpaid`}
        />
        <Stat
          label="Accrued in bonuses"
          value={formatCentavos(partner.accruedCentavos)}
          note={`${formatCentavos(partner.accruedThisMonthCentavos)} this month, from the ledger`}
        />
      </div>

      {partner.isLive ? (
        <p className="rounded-xl bg-surface-sunken px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <span className="font-semibold text-ink">
            There is no self-referral warning here, and that is deliberate.
          </span>{' '}
          Collecting a rider bonus means passing verification a second time and
          completing {partner.cost.qualifyingDeliveries}{' '}
          {partner.cost.qualifyingDeliveries === 1 ? 'delivery' : 'deliveries'} —
          real orders, to real customers, each of which already paid that
          account its own fee. Somebody who does all that has done the job the
          bonus is for. What can go wrong instead is the number above:{' '}
          {formatCentavos(partner.cost.perQualifyingDeliveryCentavos)} per
          delivery, on top of what you pay the rider for it. Compare it to what
          a delivery earns the business, because nothing else here will.
          {partner.cost.lifetimeLiabilityPerReferrerCentavos > 0 ? (
            <>
              {' '}
              The caps bound the rest: at most{' '}
              {formatCentavos(partner.cost.lifetimeLiabilityPerReferrerCentavos)}{' '}
              to any one rider, ever.
            </>
          ) : null}
        </p>
      ) : null}

      <Panel
        title="The rider programme"
        description={`Both amounts are per invite, and one side may be worth at most ${formatCentavos(MAX_PARTNER_REWARD_CENTAVOS)}. Changing them never alters a bonus already paid.`}
      >
        <div className="px-4 py-3">
          <ReasonForm
            action={setPartnerReferralProgrammeAction}
            hidden={{ isActive: String(!partner.programme.isActive) }}
            submitLabel={
              partner.programme.isActive ? 'Save and switch OFF' : 'Save and switch ON'
            }
            tone={partner.programme.isActive ? 'danger' : 'default'}
            extraFields={
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Field
                  name="referrerPesos"
                  label="To the inviter (₱)"
                  value={(partner.programme.referrerCentavos / 100).toFixed(2)}
                />
                <Field
                  name="refereePesos"
                  label="To the new rider (₱)"
                  value={(partner.programme.refereeCentavos / 100).toFixed(2)}
                />
                <Field
                  name="qualifyingDeliveries"
                  label="Deliveries first"
                  value={String(partner.programme.qualifyingDeliveries)}
                />
                <Field
                  name="monthlyCap"
                  label="Cap / month"
                  value={String(partner.programme.monthlyRewardCap)}
                />
                <Field
                  name="lifetimeCap"
                  label="Cap / lifetime"
                  value={String(partner.programme.lifetimeRewardCap)}
                />
              </div>
            }
          >
            The delivery threshold is the defence and the caps are the budget.
            At least one delivery is required to switch this on: paying on
            signup would be paying for owning a SIM card rather than for the
            work. The caps refuse the INVITER only — a new rider who did the
            deliveries is still paid, because a promise broken by somebody
            else&rsquo;s cap is not one they can do anything about.
          </ReasonForm>
        </div>
      </Panel>

      <Panel
        title="Why rider invites did not pay"
        description="A cap everybody hits, or a threshold nobody reaches, shows up here first."
      >
        {partner.refusals.length === 0 ? (
          <Empty>
            Nothing has been refused. With {partner.attributed} still riding
            towards a bonus, that is either a healthy programme or a young one.
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Reason</Th>
                <Th numeric>Invites</Th>
              </tr>
            </thead>
            <tbody>
              {partner.refusals.map((row) => (
                <tr key={row.reason}>
                  <Td>{row.reason}</Td>
                  <Td numeric>{row.count}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Who brought whom"
        description="Newest first. The delivery count is what the bonus was paid against."
      >
        {partner.rows.length === 0 ? (
          <Empty>No rider has applied with another rider&rsquo;s code yet.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Inviter</Th>
                <Th>New rider</Th>
                <Th>Code</Th>
                <Th>State</Th>
                <Th numeric>Paid</Th>
              </tr>
            </thead>
            <tbody>
              {partner.rows.map((row) => (
                <tr key={row.id}>
                  <Td>
                    {row.referrerName}
                    <span className="mt-0.5 block text-[11px] tabular-nums text-ink-faint">
                      {formatPhilippineMobile(row.referrerPhone)}
                    </span>
                  </Td>
                  <Td>
                    {row.refereeName}
                    <span className="mt-0.5 block text-[11px] tabular-nums text-ink-faint">
                      {formatPhilippineMobile(row.refereePhone)}
                    </span>
                  </Td>
                  <Td muted>
                    <span className="font-mono text-[11px]">{row.codeUsed}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-faint">
                      {manilaTime(row.createdAt)}
                    </span>
                  </Td>
                  <Td>
                    <Pill
                      tone={
                        row.status === ReferralStatus.REWARDED
                          ? 'good'
                          : row.status === ReferralStatus.NOT_REWARDED
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {row.status === ReferralStatus.REWARDED
                        ? 'Paid'
                        : row.status === ReferralStatus.NOT_REWARDED
                          ? 'Unpaid'
                          : 'Riding'}
                    </Pill>
                    {row.qualifyingDeliveryCount !== null ? (
                      <span className="mt-0.5 block text-[11px] text-ink-faint">
                        at {row.qualifyingDeliveryCount} deliveries
                      </span>
                    ) : null}
                    {row.blockedReason ? (
                      <span className="mt-0.5 block text-[11px] text-ink-faint">
                        {row.blockedReason}
                      </span>
                    ) : null}
                  </Td>
                  <Td numeric>
                    {row.referrerRewardCentavos + row.refereeRewardCentavos > 0 ? (
                      <>
                        {formatCentavos(
                          row.referrerRewardCentavos + row.refereeRewardCentavos,
                        )}
                        <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
                          {formatCentavos(row.referrerRewardCentavos)} +{' '}
                          {formatCentavos(row.refereeRewardCentavos)}
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      {/* ---------------------------------------------------------------- */}

      <div className="border-t border-black/10 pt-5">
        <h2 className="text-lg font-bold">Shop referrals</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
          A shop that brings a shop is paid <strong>money</strong> as well, on
          the same settlement ledger as the food it sells. What differs is the
          attribution: a shop does not sign itself up, so there is no code to
          type — somebody here records the introduction from the new
          shop&rsquo;s own page, with their name and a reason against it. The
          bonus is earned once that shop has <strong>earned</strong> its way
          past a threshold, not once it has taken a number of orders, because
          twenty ₱120 orders is not a trading shop. Off until you set the
          amounts.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Programme"
          value={store.isLive ? 'On' : 'Off'}
          note={
            store.isLive
              ? `${formatCentavos(store.programme.referrerCentavos)} to the introducing shop, ${formatCentavos(store.programme.refereeCentavos)} to the new one`
              : 'Attributions earn nothing and the shop’s payouts panel says so'
          }
        />
        <Stat
          label="A shop costs"
          value={formatCentavos(store.cost.bothSidesCentavos)}
          note={
            store.cost.qualifyingEarningsCentavos > 0
              ? `${(store.cost.costBasisPointsOfEarnings / 100).toFixed(2)}% of the ${formatCentavos(store.cost.qualifyingEarningsCentavos)} they must earn first`
              : 'No earnings threshold set'
          }
        />
        <Stat
          label="Trading towards a bonus"
          value={String(store.attributed)}
          note={`${store.rewarded} paid, ${store.notRewarded} closed unpaid`}
        />
        <Stat
          label="Accrued in bonuses"
          value={formatCentavos(store.accruedCentavos)}
          note={`${formatCentavos(store.accruedThisMonthCentavos)} this month, from the ledger`}
        />
      </div>

      {store.isLive && commissionBp === null ? (
        <p
          role="alert"
          className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200"
        >
          <span className="font-semibold">
            No visible shop is charged commission, so nothing earns this back.
          </span>{' '}
          Every {formatCentavos(store.cost.bothSidesCentavos)} paid here is
          spent outright: the shops keep the whole food subtotal, so TARA takes
          nothing from the {formatCentavos(store.cost.qualifyingEarningsCentavos)}{' '}
          they have to earn first. That can be a deliberate launch subsidy. It
          cannot be an accident.
        </p>
      ) : store.isLive && earnsItBack ? (
        <p className="rounded-xl bg-emerald-50 px-4 py-3 text-xs leading-relaxed text-emerald-900 ring-1 ring-emerald-200">
          <span className="font-semibold">The threshold earns it back.</span>{' '}
          The bonus is {(store.cost.costBasisPointsOfEarnings / 100).toFixed(2)}%
          of the {formatCentavos(store.cost.qualifyingEarningsCentavos)} the new
          shop must earn before it is owed, and a typical shop pays{' '}
          {(commissionBp / 100).toFixed(2)}% of what it sells in commission — so
          the trading that qualifies the referral has already paid for it, and
          everything after is yours. The caps bound the rest: at most{' '}
          {formatCentavos(store.cost.lifetimeLiabilityPerReferrerCentavos)} to
          any one shop, ever.
        </p>
      ) : store.isLive ? (
        <p
          role="alert"
          className="rounded-xl bg-rose-50 px-4 py-3 text-xs leading-relaxed text-rose-800 ring-1 ring-rose-200"
        >
          <span className="font-semibold">
            A shop bought this way starts out behind.
          </span>{' '}
          The bonus is {(store.cost.costBasisPointsOfEarnings / 100).toFixed(2)}%
          of the {formatCentavos(store.cost.qualifyingEarningsCentavos)}{' '}
          threshold, and a typical shop pays only{' '}
          {((commissionBp ?? 0) / 100).toFixed(2)}% of what it sells — so the
          shop has
          to earn about{' '}
          <strong>{formatCentavos(breakEvenCentavos ?? 0)}</strong> through TARA
          before the commission on it has covered the{' '}
          {formatCentavos(store.cost.bothSidesCentavos)} you paid for it. Buying
          growth forward is a normal thing to do; lower the amounts or raise the
          threshold if it is not what you meant.
        </p>
      ) : null}

      {store.isLive ? (
        <p className="rounded-xl bg-surface-sunken px-4 py-3 text-xs leading-relaxed text-ink-muted">
          <span className="font-semibold text-ink">
            What can go wrong here is not farming — it is a claim nobody
            checked.
          </span>{' '}
          The other two programmes attribute themselves: a link is followed, a
          code is typed. This one is recorded by one of us, about two shops we
          are talking to, and it pays real money out of the settlement ledger.
          So the rule refuses a shop that has already earned anything through
          TARA — it was trading before anybody introduced it — and every row
          below carries who recorded it and what they said. Read them the way
          you read recorded payouts.
        </p>
      ) : null}

      <Panel
        title="The shop programme"
        description={`Both amounts are per introduction, and one side may be worth at most ${formatCentavos(MAX_STORE_REWARD_CENTAVOS)}. Changing them never alters a bonus already paid.`}
      >
        <div className="px-4 py-3">
          <ReasonForm
            action={setStoreReferralProgrammeAction}
            hidden={{ isActive: String(!store.programme.isActive) }}
            submitLabel={
              store.programme.isActive ? 'Save and switch OFF' : 'Save and switch ON'
            }
            tone={store.programme.isActive ? 'danger' : 'default'}
            extraFields={
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Field
                  name="referrerPesos"
                  label="To the introducer (₱)"
                  value={(store.programme.referrerCentavos / 100).toFixed(2)}
                />
                <Field
                  name="refereePesos"
                  label="To the new shop (₱)"
                  value={(store.programme.refereeCentavos / 100).toFixed(2)}
                />
                <Field
                  name="qualifyingEarningsPesos"
                  label="They must earn (₱)"
                  value={(
                    store.programme.qualifyingEarningsCentavos / 100
                  ).toFixed(2)}
                />
                <Field
                  name="monthlyCap"
                  label="Cap / month"
                  value={String(store.programme.monthlyRewardCap)}
                />
                <Field
                  name="lifetimeCap"
                  label="Cap / lifetime"
                  value={String(store.programme.lifetimeRewardCap)}
                />
              </div>
            }
          >
            The earnings threshold is the defence: it has to be above zero to
            switch this on, because zero would pay for a shop being ADDED to
            the console, which is something we do by hand for a shop that may
            never sell anything. It counts food earnings only — a bonus a shop
            was itself paid does not help it qualify, or a chain of
            introductions could bootstrap itself. The caps refuse the
            INTRODUCING shop only; a new shop that sold the food is still paid.
          </ReasonForm>
        </div>
      </Panel>

      <Panel
        title="Why shop referrals did not pay"
        description="A threshold nobody reaches, or a shop that had withdrawn by the time its introduction qualified, shows up here first."
      >
        {store.refusals.length === 0 ? (
          <Empty>
            Nothing has been refused. With {store.attributed} still trading
            towards a bonus, that is either a healthy programme or a young one.
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Reason</Th>
                <Th numeric>Introductions</Th>
              </tr>
            </thead>
            <tbody>
              {store.refusals.map((row) => (
                <tr key={row.reason}>
                  <Td>{row.reason}</Td>
                  <Td numeric>{row.count}</Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Which shop brought which"
        description="Newest first. Every row is somebody’s claim, so every row names them and what they said — this table is the whole audit of a programme with no code."
      >
        {store.rows.length === 0 ? (
          <Empty>
            No introduction has been recorded yet. You record one from a
            shop&rsquo;s own page in Stores, not from here — it is a fact about
            that shop.
          </Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Introduced by</Th>
                <Th>New shop</Th>
                <Th>Recorded by</Th>
                <Th>State</Th>
                <Th numeric>Owed</Th>
              </tr>
            </thead>
            <tbody>
              {store.rows.map((row) => (
                <tr key={row.id}>
                  <Td>
                    <Link
                      href={`/admin/stores/${row.referrerStoreId}`}
                      className="font-semibold text-brand-700"
                    >
                      {row.referrerName}
                    </Link>
                  </Td>
                  <Td>
                    <Link
                      href={`/admin/stores/${row.refereeStoreId}`}
                      className="font-semibold text-brand-700"
                    >
                      {row.refereeName}
                    </Link>
                  </Td>
                  <Td muted>
                    {row.attributedByName}
                    <span className="mt-0.5 block text-[11px] text-ink-faint">
                      {manilaTime(row.createdAt)}
                    </span>
                    <span className="mt-0.5 block max-w-[18rem] text-[11px] leading-snug text-ink-faint">
                      {row.attributionNote}
                    </span>
                  </Td>
                  <Td>
                    <Pill
                      tone={
                        row.status === ReferralStatus.REWARDED
                          ? 'good'
                          : row.status === ReferralStatus.NOT_REWARDED
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {row.status === ReferralStatus.REWARDED
                        ? 'Paid'
                        : row.status === ReferralStatus.NOT_REWARDED
                          ? 'Unpaid'
                          : 'Trading'}
                    </Pill>
                    {row.qualifyingEarningsCentavos !== null ? (
                      <span className="mt-0.5 block text-[11px] text-ink-faint">
                        at {formatCentavos(row.qualifyingEarningsCentavos)}{' '}
                        earned
                      </span>
                    ) : null}
                    {row.blockedReason ? (
                      <span className="mt-0.5 block max-w-[16rem] text-[11px] leading-snug text-ink-faint">
                        {row.blockedReason}
                      </span>
                    ) : null}
                  </Td>
                  <Td numeric>
                    {row.referrerRewardCentavos + row.refereeRewardCentavos > 0 ? (
                      <>
                        {formatCentavos(
                          row.referrerRewardCentavos + row.refereeRewardCentavos,
                        )}
                        <span className="mt-0.5 block text-[11px] font-normal text-ink-faint">
                          {formatCentavos(row.referrerRewardCentavos)} +{' '}
                          {formatCentavos(row.refereeRewardCentavos)}
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
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
        inputMode="decimal"
        defaultValue={value}
        className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
    </label>
  );
}
