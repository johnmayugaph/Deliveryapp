import { PromoKind } from '@prisma/client';
import { requireAdmin } from '@/lib/admin/access';
import { promoOverview, describeKind, type PromoCodeRow } from '@/lib/admin/promo';
import { getActiveServices } from '@/lib/services/registry';
import { prisma } from '@/lib/prisma';
import { formatCentavos } from '@/lib/money';
import { MAX_DISCOUNT_CENTAVOS } from '@/lib/promo/policy';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  createPromoCodeAction,
  setPromoCodeActiveAction,
} from '@/lib/actions/admin-actions';
import {
  Empty,
  Panel,
  Pill,
  Stat,
  TableScroll,
  Td,
  Th,
  manilaTime,
} from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/**
 * Promo codes.
 *
 * The screen exists to make two numbers impossible to miss, in the same spirit
 * as the self-referral margin on the referrals screen:
 *
 *  - **What each live campaign can still cost.** Not its redemption count —
 *    the money still on the table. A campaign's danger is never the discount
 *    on one order, it is the number of orders, and a code with no total limit
 *    and no budget is an open cheque however small the discount looks.
 *  - **Whether a code makes food free.** A fixed amount at or above the
 *    minimum order means somebody eats for nothing while we pay the shop and
 *    the rider in full. The arithmetic is right, the orders go through, and
 *    nothing anywhere is an error.
 *
 * Codes are switched off, never deleted: a used code cannot be deleted at all,
 * because the redemptions are the record of what the campaign cost.
 */
export default async function AdminPromoPage() {
  await requireAdmin();

  const [overview, services, cities] = await Promise.all([
    promoOverview(),
    getActiveServices(),
    prisma.city.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Promo codes</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
          A promo code is public by design — it goes on a tarpaulin and round a
          group chat — so the defence is the caps and not the secrecy. Every
          figure below is counted from the redemptions themselves, so what a
          campaign has cost and what it can still cost are the same arithmetic.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Live now"
          value={String(overview.liveCount)}
          note="Switched on and inside its dates"
        />
        <Stat
          label="Redemptions"
          value={String(overview.redemptions)}
          note="Every code, all time"
        />
        <Stat
          label="Given away"
          value={formatCentavos(overview.spentCentavos)}
          note={`${formatCentavos(overview.spentThisMonthCentavos)} this month`}
        />
        <Stat
          label="Still on the table"
          value={
            overview.remainingExposureCentavos === null
              ? 'Unbounded'
              : formatCentavos(overview.remainingExposureCentavos)
          }
          note={
            overview.remainingExposureCentavos === null
              ? 'A live code has no limit and no budget'
              : 'Worst case across every live code'
          }
        />
      </div>

      {/* The two warnings this screen is for. */}
      {overview.unbounded.length > 0 ? (
        <p
          role="alert"
          className="rounded-xl bg-rose-50 px-4 py-3 text-xs leading-relaxed text-rose-800 ring-1 ring-rose-200"
        >
          <span className="font-semibold">
            {overview.unbounded.length === 1
              ? 'One live code has no bound on what it can cost.'
              : `${overview.unbounded.length} live codes have no bound on what they can cost.`}
          </span>{' '}
          {overview.unbounded.map((code) => code.code).join(', ')} — no
          redemption limit and no budget, so the total is decided by how many
          people see it. The dates bound how long it runs, not how much it
          costs. Switch it off and create a replacement with a cap.
        </p>
      ) : null}

      {overview.freeFood.length > 0 ? (
        <p
          role="alert"
          className="rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200"
        >
          <span className="font-semibold">
            {overview.freeFood.length === 1
              ? 'One live code can make an order free.'
              : `${overview.freeFood.length} live codes can make an order free.`}
          </span>{' '}
          {overview.freeFood
            .map((code) =>
              // With no minimum, the smallest qualifying order is one centavo,
              // and "covers an order of ₱0.01" is true but reads as a rounding
              // artefact rather than as the point. Say the point.
              code.minimumOrderCentavos === 0
                ? `${code.code} has no minimum order, so it covers ANY order in full`
                : `${code.code} covers an order of ${formatCentavos(code.giveaway.smallestOrderCentavos)} in full`,
            )
            .join('; ')}
          . The order still goes through correctly and we still pay the shop and
          the rider, so this costs real money per use. Raise the minimum order
          above the discount unless it is a subsidy you mean to pay.
        </p>
      ) : null}

      <Panel
        title="Campaigns"
        description="Cost so far against the budget, and what is still on the table. Switching a code off leaves orders already placed with it untouched."
      >
        {overview.codes.length === 0 ? (
          <Empty>No codes yet.</Empty>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Takes off</Th>
                <Th>Who and where</Th>
                <Th>Window</Th>
                <Th numeric>Used</Th>
                <Th numeric>Cost</Th>
                <Th numeric>Still on the table</Th>
                <Th>Switch</Th>
              </tr>
            </thead>
            <tbody>
              {overview.codes.map((code) => (
                <tr key={code.id}>
                  <Td>
                    <span className="font-semibold tracking-wide">{code.code}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-muted">
                      {code.label}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      <StatePill code={code} />
                      {code.giveaway.coversTheFood ? (
                        <Pill tone="bad">Free order possible</Pill>
                      ) : null}
                      {code.exposure.unbounded && code.isLive ? (
                        <Pill tone="bad">No cap</Pill>
                      ) : null}
                      {!code.stacksWithSubscription ? (
                        <Pill tone="warn">Not with Plus</Pill>
                      ) : null}
                      {code.firstOrderOnly ? <Pill>First order</Pill> : null}
                    </span>
                  </Td>

                  <Td muted>
                    <span className="text-[11px]">{describeKind(code)}</span>
                    {code.kind === PromoKind.FIXED_AMOUNT && code.amountCentavos ? (
                      <span className="mt-0.5 block text-[11px]">
                        {formatCentavos(code.amountCentavos)}
                      </span>
                    ) : null}
                    {code.maxDiscountCentavos ? (
                      <span className="mt-0.5 block text-[11px]">
                        up to {formatCentavos(code.maxDiscountCentavos)} an order
                      </span>
                    ) : null}
                    <span className="mt-0.5 block text-[11px]">
                      {code.minimumOrderCentavos > 0
                        ? `min ${formatCentavos(code.minimumOrderCentavos)}`
                        : 'no minimum'}
                    </span>
                  </Td>

                  <Td muted>
                    <span className="text-[11px]">
                      {code.serviceTypes.length === 0
                        ? 'Every service'
                        : code.serviceTypes.join(', ')}
                    </span>
                    <span className="mt-0.5 block text-[11px]">
                      {code.storeName
                        ? code.storeName
                        : code.cityNames.length === 0
                          ? 'Every city'
                          : code.cityNames.join(', ')}
                    </span>
                    <span className="mt-0.5 block text-[11px]">
                      {code.perCustomerLimit === 1
                        ? 'once per account'
                        : `${code.perCustomerLimit}× per account`}
                    </span>
                  </Td>

                  <Td muted>
                    <span className="text-[11px]">{manilaTime(code.startsAt)}</span>
                    <span className="mt-0.5 block text-[11px]">
                      to {manilaTime(code.endsAt)}
                    </span>
                  </Td>

                  <Td numeric>
                    {code.usage.redemptions}
                    {code.totalRedemptionLimit !== null ? (
                      <span className="block text-[11px] text-ink-faint">
                        of {code.totalRedemptionLimit}
                      </span>
                    ) : (
                      <span className="block text-[11px] text-ink-faint">no limit</span>
                    )}
                  </Td>

                  <Td numeric>
                    {formatCentavos(code.usage.spentCentavos)}
                    {code.budgetCentavos !== null ? (
                      <span className="block text-[11px] text-ink-faint">
                        of {formatCentavos(code.budgetCentavos)}
                      </span>
                    ) : (
                      <span className="block text-[11px] text-ink-faint">no budget</span>
                    )}
                  </Td>

                  <Td numeric>
                    {/* The number this screen is for. Only meaningful for a
                        code that can still be used at all — a finished or
                        switched-off campaign has nothing on the table
                        regardless of what its caps say. */}
                    {!code.isLive ? (
                      <span className="text-[11px] text-ink-faint">—</span>
                    ) : code.exposure.remainingCentavos === null ? (
                      <span className="font-semibold text-rose-700">Unbounded</span>
                    ) : (
                      <>
                        {formatCentavos(code.exposure.remainingCentavos)}
                        {code.exposure.remainingRedemptions !== null ? (
                          <span className="block text-[11px] text-ink-faint">
                            {code.exposure.remainingRedemptions} left
                          </span>
                        ) : null}
                      </>
                    )}
                  </Td>

                  <Td>
                    <ReasonForm
                      action={setPromoCodeActiveAction}
                      hidden={{ promoCodeId: code.id, isActive: String(!code.isActive) }}
                      submitLabel={code.isActive ? 'Switch off' : 'Switch on'}
                      tone={code.isActive ? 'danger' : 'default'}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Create a code"
        description={`A redemption limit or a budget is required — a public code with neither is an open cheque. The most one order may be discounted is ${formatCentavos(MAX_DISCOUNT_CENTAVOS)}.`}
      >
        <div className="px-4 py-3">
          <ReasonForm
            action={createPromoCodeAction}
            hidden={{}}
            submitLabel="Create and switch on"
            placeholder="Which campaign this is for, and who approved the spend"
            extraFields={
              <div className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Code" hint="Letters, digits and hyphens. Read aloud, so keep it short.">
                    <input
                      name="code"
                      required
                      maxLength={40}
                      placeholder="TARA50"
                      className={INPUT}
                    />
                  </Field>
                  <Field label="Name on the bill" hint="What the customer reads next to the money.">
                    <input
                      name="label"
                      required
                      maxLength={120}
                      placeholder="₱50 off your first order"
                      className={INPUT}
                    />
                  </Field>
                </div>

                <div className="grid gap-2 sm:grid-cols-4">
                  <Field label="Takes off">
                    <select name="kind" defaultValue={PromoKind.FIXED_AMOUNT} className={INPUT}>
                      <option value={PromoKind.FIXED_AMOUNT}>A flat amount</option>
                      <option value={PromoKind.PERCENTAGE}>A percentage of the food</option>
                      <option value={PromoKind.FREE_DELIVERY}>The delivery fee</option>
                    </select>
                  </Field>
                  <Field label="Amount, pesos" hint="Flat amount only.">
                    <input name="amountPesos" inputMode="decimal" placeholder="50" className={INPUT} />
                  </Field>
                  <Field label="Percent" hint="Percentage only.">
                    <input name="percent" inputMode="decimal" placeholder="15" className={INPUT} />
                  </Field>
                  <Field label="Ceiling an order, pesos" hint="Required for a percentage.">
                    <input name="ceilingPesos" inputMode="decimal" placeholder="100" className={INPUT} />
                  </Field>
                </div>

                <div className="grid gap-2 sm:grid-cols-4">
                  <Field
                    label="Minimum order, pesos"
                    hint="Keep it above the discount, or the food is free."
                  >
                    <input
                      name="minimumPesos"
                      required
                      inputMode="decimal"
                      defaultValue="0"
                      className={INPUT}
                    />
                  </Field>
                  <Field label="Redemption limit" hint="Blank for none — needs a budget then.">
                    <input name="totalLimit" inputMode="numeric" placeholder="500" className={INPUT} />
                  </Field>
                  <Field label="Budget, pesos" hint="Blank for none — needs a limit then.">
                    <input name="budgetPesos" inputMode="decimal" placeholder="25000" className={INPUT} />
                  </Field>
                  <Field label="Uses per account">
                    <input
                      name="perCustomerLimit"
                      required
                      inputMode="numeric"
                      defaultValue="1"
                      className={INPUT}
                    />
                  </Field>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Starts">
                    <input name="startsAt" type="datetime-local" required className={INPUT} />
                  </Field>
                  <Field label="Ends">
                    <input name="endsAt" type="datetime-local" required className={INPUT} />
                  </Field>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Field
                    label="Services"
                    hint="Select none for every service. Read from the registry, never a list in code."
                  >
                    <select name="serviceTypes" multiple size={3} className={INPUT}>
                      {services.map((service) => (
                        <option key={service.key} value={service.key}>
                          {service.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Cities" hint="Select none for every city.">
                    <select name="cityIds" multiple size={3} className={INPUT}>
                      {cities.map((city) => (
                        <option key={city.id} value={city.id}>
                          {city.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <label className="flex items-center gap-2 text-[11px]">
                  <input type="checkbox" name="firstOrderOnly" className="accent-brand-600" />
                  Only for somebody who has never had an order delivered
                </label>
                <label className="flex items-start gap-2 text-[11px] leading-relaxed">
                  <input
                    type="checkbox"
                    name="stacksWithSubscription"
                    defaultChecked
                    className="mt-0.5 accent-brand-600"
                  />
                  <span>
                    May be combined with a Plus subscription&rsquo;s benefits.
                    Unticked, the two are priced separately and the cheaper bill
                    wins — so a subscriber never pays more for typing a code
                    than for typing nothing, and the code is left unspent when
                    their plan was better.
                  </span>
                </label>
              </div>
            }
          />
        </div>
      </Panel>
    </div>
  );
}

const INPUT =
  'mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold text-ink-muted">{label}</span>
      {children}
      {hint ? <span className="mt-0.5 block text-[10px] text-ink-faint">{hint}</span> : null}
    </label>
  );
}

/**
 * On, off, not started yet, or finished.
 *
 * Four states rather than two, because "switched on" and "working" are not the
 * same thing and the difference is the whole reason somebody comes to this
 * screen asking why a code does nothing.
 */
function StatePill({ code }: { code: PromoCodeRow }) {
  if (!code.isActive) return <Pill tone="bad">Off</Pill>;
  if (code.window === 'BEFORE') return <Pill tone="warn">Not started</Pill>;
  if (code.window === 'ENDED') return <Pill>Finished</Pill>;
  return <Pill tone="good">Live</Pill>;
}
