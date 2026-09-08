import { SettlementParty, type SettlementEntry } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
import {
  ENTRY_LABEL,
  describePosition,
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
export function PositionPanel({
  party,
  position,
  entries,
}: {
  party: SettlementParty;
  position: Position;
  entries: SettlementEntry[];
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
      </dl>

      {entries.length === 0 ? (
        <p className="px-1 text-[11px] text-ink-muted">
          Nothing yet. A line appears here when an order completes.
        </p>
      ) : (
        <ul className="divide-y divide-black/5 overflow-hidden rounded-xl bg-surface ring-1 ring-black/5">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-baseline gap-3 px-3.5 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium">
                  {ENTRY_LABEL[entry.type]}
                </span>
                <span className="block text-[11px] text-ink-faint">
                  {entry.description} ·{' '}
                  {entry.createdAt.toLocaleString('en-PH', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
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
          ))}
        </ul>
      )}

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
