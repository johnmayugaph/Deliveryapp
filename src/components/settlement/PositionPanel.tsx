import { SettlementParty, type SettlementEntry } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
import {
  MISSING_REFERENCE_NOTE,
  entryDetailLines,
  referenceState,
  type DetailValue,
} from '@/lib/settlement/entry-detail';
import { formatDateTimeIn, formatLongFullDayIn } from '@/lib/time/manila';
import {
  bonusTotalLabel,
  describePosition,
  entryLabel,
  settlementSideFor,
  type Position,
} from '@/lib/settlement/policy';

/**
 * A partner's own statement: where they stand, and every line behind it.
 *
 * Shared by the rider's screen and the shop's, because it is the same
 * question asked by two people and answering it twice would let the two
 * answers drift. Rendered on the server from the ledger — there is no summary
 * column to be stale.
 *
 * The framing changes with the sign, and that is the point. A positive balance
 * is money coming to you. A negative one, for a rider, is **cash in your
 * pocket that is not yours**, and that sentence has to be unmistakable: it is
 * the number the whole cash-handling problem is about, and a rider who does
 * not understand it is a rider who spends it.
 */
/** A breakdown figure, formatted where the unit is known. */
function detailValue(value: DetailValue): string {
  return value.kind === 'money'
    ? formatCentavos(value.centavos)
    : `${(value.basisPoints / 100).toFixed(2)}%`;
}

export function PositionPanel({
  party,
  position,
  entries,
  lastPayout,
  currentCommissionBasisPoints,
}: {
  party: SettlementParty;
  position: Position;
  entries: SettlementEntry[];
  /**
   * The newest payout, from its own query rather than from `entries` — which
   * is capped, so a busy partner's last payout can easily be older than the
   * lines shown.
   */
  lastPayout?: SettlementEntry | null;
  /**
   * The shop's rate now, so a line that was priced at a DIFFERENT rate can say
   * so — and every line priced at the current one can stay quiet.
   */
  currentCommissionBasisPoints?: number | undefined;
}) {
  const side = settlementSideFor(position);
  const magnitude = Math.abs(position.balanceCentavos);

  const tone =
    side === 'WE_OWE'
      ? { band: 'bg-emerald-50 ring-emerald-200', ink: 'text-emerald-900' }
      : side === 'THEY_OWE'
        ? { band: 'bg-amber-100 ring-amber-300', ink: 'text-amber-950' }
        : { band: 'bg-surface-sunken ring-black/5', ink: 'text-ink' };

  return (
    <section aria-labelledby="position-heading" className="space-y-3">
      <div className={`rounded-xl px-4 py-3.5 ring-1 ${tone.band}`}>
        <h2
          id="position-heading"
          className={`text-[11px] font-bold uppercase tracking-wide ${tone.ink}`}
        >
          {side === 'WE_OWE'
            ? 'TARA owes you'
            : side === 'THEY_OWE'
              ? 'You are holding TARA’s cash'
              : 'Settled up'}
        </h2>
        <p className={`mt-0.5 text-2xl font-extrabold tabular-nums ${tone.ink}`}>
          {formatCentavos(magnitude)}
        </p>
        <p className={`mt-0.5 text-[11px] leading-snug ${tone.ink}`}>
          {describePosition(position, party)}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-[12px]">
        <div className="rounded-lg bg-surface px-3 py-2 ring-1 ring-black/5">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Earned
          </dt>
          <dd className="text-sm font-bold tabular-nums">
            {formatCentavos(position.earnedCentavos)}
          </dd>
        </div>
        {party === SettlementParty.FLEET_PARTNER ? (
          <div className="rounded-lg bg-surface px-3 py-2 ring-1 ring-black/5">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              Cash collected
            </dt>
            <dd className="text-sm font-bold tabular-nums">
              {formatCentavos(position.collectedCentavos)}
            </dd>
          </div>
        ) : null}
        <div className="rounded-lg bg-surface px-3 py-2 ring-1 ring-black/5">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
            Paid to you
          </dt>
          <dd className="text-sm font-bold tabular-nums">
            {formatCentavos(position.paidOutCentavos)}
          </dd>
        </div>
        {party === SettlementParty.FLEET_PARTNER ? (
          <div className="rounded-lg bg-surface px-3 py-2 ring-1 ring-black/5">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              Handed in
            </dt>
            <dd className="text-sm font-bold tabular-nums">
              {formatCentavos(position.remittedCentavos)}
            </dd>
          </div>
        ) : null}
        {/* Only when there is one. A permanent "Invite bonuses ₱0.00" tile
            advertises a programme that may not even be running, and a rider
            who has earned none does not need to be told so on every visit.

            The heading is per party: a shop was not invited by anybody, and
            this tile sat two inches above a panel saying "There is no code to
            share". Found in a browser, on the same page as the line label. */}
        {position.bonusCentavos > 0 ? (
          <div className="rounded-lg bg-surface px-3 py-2 ring-1 ring-black/5">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
              {bonusTotalLabel(party)}
            </dt>
            <dd className="text-sm font-bold tabular-nums">
              {formatCentavos(position.bonusCentavos)}
            </dd>
          </div>
        ) : null}
      </dl>

      {entries.length === 0 ? (
        <p className="px-1 text-[11px] text-ink-muted">
          Nothing yet. A line appears here when an order completes.
        </p>
      ) : (
        <ul className="divide-y divide-black/5 overflow-hidden rounded-xl bg-surface ring-1 ring-black/5">
          {entries.map((entry) => {
            const detail = entryDetailLines(entry, party, {
              currentCommissionBasisPoints,
            });
            const ref = referenceState(entry);
            return (
            <li key={entry.id} className="flex items-baseline gap-3 px-3.5 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium">
                  {entryLabel(entry.type, party)}
                </span>
                <span className="block text-[11px] text-ink-faint">
                  {entry.description} ·{' '}
                  {formatDateTimeIn(entry.createdAt)}
                </span>
                {/* What was taken and at what rate. Recorded on every earnings
                    line since settlement was built and read by nothing until
                    now, so a shop had to do the arithmetic to check its own
                    commission on the one screen meant to be checkable. */}
                {detail.length > 0 ? (
                  <span className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-ink-faint">
                    {detail.map((line) => (
                      <span key={line.label}>
                        {line.label}{' '}
                        <span className="font-medium tabular-nums text-ink-muted">
                          {detailValue(line.value)}
                        </span>
                      </span>
                    ))}
                  </span>
                ) : null}
                {/* The reference is REQUIRED on a payout so it can be checked,
                    and until now the only person who could see it was an
                    administrator. */}
                {ref.kind === 'shown' ? (
                  <span className="mt-0.5 block font-mono text-[10px] text-ink-muted">
                    Ref {ref.reference}
                  </span>
                ) : null}
                {ref.kind === 'missing' ? (
                  <span className="mt-0.5 block text-[10px] text-amber-800">
                    {MISSING_REFERENCE_NOTE}
                  </span>
                ) : null}
              </span>
              <span
                className={`shrink-0 text-[13px] font-semibold tabular-nums ${
                  entry.amountCentavos < 0 ? 'text-amber-800' : 'text-emerald-800'
                }`}
              >
                {entry.amountCentavos < 0 ? '−' : '+'}
                {formatCentavos(Math.abs(entry.amountCentavos))}
              </span>
            </li>
            );
          })}
        </ul>
      )}

      {/* Answers the question a payout screen is actually opened with, as far
          as the ledger can: not "when will I be paid" — nothing in the app
          knows a schedule — but "when was I last paid, and for how much". */}
      {lastPayout ? (
        <p className="px-1 text-[11px] leading-relaxed text-ink-muted">
          Last paid{' '}
          <strong className="font-semibold text-ink">
            {formatCentavos(Math.abs(lastPayout.amountCentavos))}
          </strong>{' '}
          on{' '}
          {formatLongFullDayIn(lastPayout.createdAt)}
          {lastPayout.reference?.trim()
            ? `, reference ${lastPayout.reference.trim()}`
            : ''}
          .
        </p>
      ) : null}

      {/* Said out loud rather than left to be discovered. A partner who
          expects the app to pay them automatically will not chase a payout
          that never arrives. */}
      <p className="px-1 text-[11px] leading-relaxed text-ink-faint">
        TARA does not send money from inside the app. Payouts and cash handovers
        are arranged with the team and recorded here once they have happened.
      </p>
    </section>
  );
}
