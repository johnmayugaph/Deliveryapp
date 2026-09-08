import { SettlementParty } from '@prisma/client';
import { requireAdmin } from '@/lib/admin/access';
import { settlementOverview, storeCommissions } from '@/lib/admin/settlement';
import { formatCentavos } from '@/lib/money';
import { formatPhilippineMobile } from '@/lib/auth/phone';
import { ReasonForm } from '@/components/admin/ReasonForm';
import {
  adjustSettlementAction,
  recordPayoutAction,
  recordRemittanceAction,
  setStoreCommissionAction,
} from '@/lib/actions/admin-actions';
import type { PartnerPosition } from '@/lib/admin/settlement';
import { Empty, Panel, Pill, Stat } from '@/components/admin/primitives';

export const dynamic = 'force-dynamic';

/** The fields every settlement form needs to name its partner. */
function partyFields(row: PartnerPosition): Record<string, string> {
  return { party: row.party, partyId: row.partyId };
}

function partyLabel(row: PartnerPosition): string {
  return row.party === SettlementParty.STORE ? 'Store' : 'Rider';
}

/** Money in, money out and the reference — the shape both forms share. */
function MoneyFields({
  amountLabel,
  defaultAmount,
  referenceLabel,
}: {
  amountLabel: string;
  defaultAmount?: string;
  referenceLabel: string;
}) {
  return (
    <>
      <label className="block">
        <span className="text-[11px] font-semibold text-ink-muted">{amountLabel}</span>
        <input
          name="amount"
          inputMode="decimal"
          defaultValue={defaultAmount}
          className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>
      <label className="block">
        <span className="text-[11px] font-semibold text-ink-muted">{referenceLabel}</span>
        <input
          name="reference"
          className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </label>
    </>
  );
}

/**
 * Settlement.
 *
 * Two columns of people, and they are two different problems. On the left are
 * partners TARA owes — the payout run, largest first, because that is the
 * order somebody works through it in. On the right are partners holding TARA's
 * money, which is almost entirely riders on cash orders: the float. That
 * number was the operational risk the launch checklist called "the one most
 * likely to bite in week one", and until this screen existed nothing in the
 * app knew it.
 *
 * **Nothing here moves money.** Every control records that a person moved it,
 * with their name, a reference and a reason. That is deliberate and it is the
 * same posture the customer refund control takes: a button that looked like it
 * paid somebody would be the most dangerous thing in this console.
 */
export default async function AdminSettlementPage() {
  await requireAdmin();

  const [overview, stores] = await Promise.all([
    settlementOverview(),
    storeCommissions(),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold">Settlement</h1>
        <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
          What TARA owes its shops and riders, and what they are holding for
          TARA. A cash order puts the whole total in the rider&rsquo;s hand, so
          most riders will owe money back; a prepaid order puts it in ours, so
          we owe the shop. Every line below is netted from the ledger.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="We owe" value={formatCentavos(overview.totalOwedCentavos)} />
        <Stat label="Partners to pay" value={String(overview.weOwe.length)} />
        <Stat
          label="Cash held by riders"
          value={formatCentavos(overview.totalHeldCentavos)}
        />
        <Stat label="Square" value={String(overview.squareCount)} />
      </div>

      <Panel title={`We owe them (${overview.weOwe.length})`}>
        {overview.weOwe.length === 0 ? (
          <Empty>
            Nobody is owed anything. Earnings accrue when an order completes.
          </Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {overview.weOwe.map((row) => (
              <li key={`${row.party}:${row.partyId}`} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold">
                    {row.name}{' '}
                    <Pill tone="neutral">{partyLabel(row)}</Pill>
                  </span>
                  <span className="text-base font-bold tabular-nums text-emerald-800">
                    {formatCentavos(row.position.balanceCentavos)}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-muted tabular-nums">
                  {row.phone ? formatPhilippineMobile(row.phone) : '—'} · earned{' '}
                  {formatCentavos(row.position.earnedCentavos)}
                  {row.position.paidOutCentavos > 0
                    ? ` · paid ${formatCentavos(row.position.paidOutCentavos)}`
                    : ''}
                  {row.position.collectedCentavos > 0
                    ? ` · collected ${formatCentavos(row.position.collectedCentavos)}`
                    : ''}
                </p>

                <div className="mt-2 grid gap-3 lg:grid-cols-2">
                  <ReasonForm
                    action={recordPayoutAction}
                    hidden={partyFields(row)}
                    submitLabel="Record payout as sent"
                    placeholder="Which payout run, or who authorised it"
                    extraFields={
                      <MoneyFields
                        amountLabel="Amount you sent"
                        defaultAmount={(row.position.balanceCentavos / 100).toFixed(2)}
                        referenceLabel="Transfer reference"
                      />
                    }
                  >
                    <p className="text-[11px] leading-relaxed text-ink-muted">
                      <strong>Send the money first.</strong> This records that you
                      did, with your name against it. It cannot exceed{' '}
                      {formatCentavos(row.position.balanceCentavos)}.
                    </p>
                  </ReasonForm>

                  <ReasonForm
                    action={adjustSettlementAction}
                    hidden={partyFields(row)}
                    submitLabel="Correct this balance"
                    tone="danger"
                    placeholder="What happened, in a sentence"
                    extraFields={
                      <MoneyFields
                        amountLabel="Correction (−150 charges them)"
                        referenceLabel="Ticket or reference"
                      />
                    }
                  >
                    <p className="text-[11px] leading-relaxed text-ink-muted">
                      For the cases no rule covers — a rider who paid a shop
                      directly, a damaged order somebody absorbed.
                    </p>
                  </ReasonForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`They are holding our money (${overview.theyOwe.length})`}>
        {overview.theyOwe.length === 0 ? (
          <Empty>
            Nobody is holding TARA&rsquo;s cash. A rider appears here the moment
            they complete a cash order.
          </Empty>
        ) : (
          <ul className="divide-y divide-black/5">
            {overview.theyOwe.map((row) => (
              <li key={`${row.party}:${row.partyId}`} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold">
                    {row.name} <Pill tone="neutral">{partyLabel(row)}</Pill>
                  </span>
                  <span className="text-base font-bold tabular-nums text-amber-800">
                    {formatCentavos(-row.position.balanceCentavos)}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-muted tabular-nums">
                  {row.phone ? formatPhilippineMobile(row.phone) : '—'} · collected{' '}
                  {formatCentavos(row.position.collectedCentavos)} · earned{' '}
                  {formatCentavos(row.position.earnedCentavos)}
                  {row.position.remittedCentavos > 0
                    ? ` · handed in ${formatCentavos(row.position.remittedCentavos)}`
                    : ''}
                </p>

                <div className="mt-2 max-w-md">
                  <ReasonForm
                    action={recordRemittanceAction}
                    hidden={partyFields(row)}
                    submitLabel="Record cash handed in"
                    placeholder="Who took it in, and when"
                    extraFields={
                      <MoneyFields
                        amountLabel="Amount received"
                        defaultAmount={(-row.position.balanceCentavos / 100).toFixed(2)}
                        referenceLabel="Receipt number, or who took it"
                      />
                    }
                  >
                    <p className="text-[11px] leading-relaxed text-ink-muted">
                      Count it first. This is a cash handover, so the reference is
                      whatever lets you find it again in a week.
                    </p>
                  </ReasonForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Commission"
        description="What TARA keeps from each shop's food. Zero until you negotiate one — a default would have invented revenue and quietly changed what every shop is owed."
      >
        <ul className="divide-y divide-black/5">
          {stores.map((store) => (
            <li key={store.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">
                  {store.name}{' '}
                  {store.isVisible ? null : <Pill tone="neutral">hidden</Pill>}
                </span>
                <span className="text-sm font-bold tabular-nums">
                  {(store.commissionBasisPoints / 100).toFixed(2)}%
                </span>
              </div>
              <div className="mt-2 max-w-md">
                <ReasonForm
                  action={setStoreCommissionAction}
                  hidden={{ storeId: store.id }}
                  submitLabel="Set the rate"
                  placeholder="What was agreed, and with whom"
                  extraFields={
                    <label className="block">
                      <span className="text-[11px] font-semibold text-ink-muted">
                        Basis points{' '}
                        <span className="font-normal text-ink-faint">
                          (250 = 2.5%, max 5000)
                        </span>
                      </span>
                      <input
                        name="basisPoints"
                        inputMode="numeric"
                        defaultValue={String(store.commissionBasisPoints)}
                        className="mt-0.5 w-full rounded-lg bg-surface px-2.5 py-1.5 text-[13px] tabular-nums ring-1 ring-black/5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    </label>
                  }
                >
                  <p className="text-[11px] leading-relaxed text-ink-muted">
                    Applies to future orders only, on the food subtotal. Never on
                    the tip, which is the rider&rsquo;s entirely, and never on the
                    delivery fee.
                  </p>
                </ReasonForm>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
