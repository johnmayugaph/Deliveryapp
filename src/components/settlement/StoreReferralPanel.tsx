import { ReferralStatus } from '@prisma/client';
import { formatCentavos } from '@/lib/money';
import type { StoreReferralSummary } from '@/lib/referrals/store-summary';

/**
 * A shop's introductions, on its own payouts screen.
 *
 * It lives here rather than on a screen of its own because the money is here:
 * a referral bonus is a line in what TARA owes this shop, and putting it two
 * taps away from the balance it changes would make it look like a different
 * kind of thing.
 *
 * There is no code to share, and the panel says so. A shop owner who was told
 * "share your code" would go looking for one — the introduction is recorded by
 * whoever they talk to at TARA, which is a genuinely different instruction and
 * the only honest one available. See `store-policy.ts`.
 */
export function StoreReferralPanel({
  summary,
}: {
  summary: StoreReferralSummary;
}) {
  // Nothing to say: no programme and no history. A dead panel advertising a
  // programme that is off is worse than no panel.
  if (!summary.isLive && summary.introduced === 0 && !summary.introducedBy) {
    return null;
  }

  return (
    <section aria-labelledby="store-referrals" className="space-y-2">
      <h2 id="store-referrals" className="px-1 text-[13px] font-semibold">
        Shops you introduced
      </h2>

      {summary.isLive ? (
        <p className="px-1 text-[11px] leading-relaxed text-ink-muted">
          TARA pays you{' '}
          <strong className="text-ink">
            {formatCentavos(summary.programme.referrerCentavos)}
          </strong>{' '}
          for a shop you bring, once that shop has earned{' '}
          <strong className="text-ink">
            {formatCentavos(summary.programme.qualifyingEarningsCentavos)}
          </strong>{' '}
          through TARA.
          {summary.programme.refereeCentavos > 0 ? (
            <>
              {' '}
              They get {formatCentavos(summary.programme.refereeCentavos)} at the
              same time.
            </>
          ) : null}{' '}
          It is added to what TARA owes you and goes out with your next payout.
        </p>
      ) : (
        <p className="px-1 text-[11px] leading-relaxed text-ink-muted">
          Shop referrals are not running at the moment. Anything already earned
          is still owed to you.
        </p>
      )}

      {summary.isLive ? (
        <p className="rounded-lg bg-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
          <strong className="text-ink">There is no code to share.</strong> Tell
          whoever you deal with at TARA which shop you introduced, and they
          record it — this panel is where it appears once they have.
        </p>
      ) : null}

      {summary.introducedShops.length > 0 ? (
        <ul className="divide-y divide-black/5 overflow-hidden rounded-xl bg-surface ring-1 ring-black/5">
          {summary.introducedShops.map((row) => (
            <li key={row.id} className="flex items-baseline gap-3 px-3.5 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{row.name}</span>
                <span className="block text-[11px] leading-snug text-ink-faint">
                  {row.status === ReferralStatus.REWARDED
                    ? row.rewardCentavos > 0
                      ? 'Paid — it is in what TARA owes you'
                      : row.blockedReason ?? 'They qualified'
                    : row.status === ReferralStatus.NOT_REWARDED
                      ? row.blockedReason ?? 'Not paid'
                      : `${formatCentavos(row.soFarCentavos)} of ${formatCentavos(
                          summary.programme.qualifyingEarningsCentavos,
                        )} earned — ${formatCentavos(row.toGoCentavos)} to go`}
                </span>
              </span>
              {row.rewardCentavos > 0 ? (
                <span className="shrink-0 text-[13px] font-semibold tabular-nums text-emerald-800">
                  +{formatCentavos(row.rewardCentavos)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : summary.isLive ? (
        <p className="px-1 text-[11px] leading-relaxed text-ink-muted">
          No shops recorded against you yet.
        </p>
      ) : null}

      {summary.introducedBy ? (
        <div className="rounded-xl bg-surface p-3.5 shadow-sm ring-1 ring-black/5">
          <p className="text-[13px] font-semibold">
            {summary.introducedBy.name} introduced you
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
            {summary.introducedBy.status === ReferralStatus.REWARDED
              ? summary.introducedBy.rewardCentavos > 0
                ? `Your ${formatCentavos(
                    summary.introducedBy.rewardCentavos,
                  )} welcome bonus is in what TARA owes you.`
                : 'You have qualified. This referral did not pay your side.'
              : summary.introducedBy.status === ReferralStatus.NOT_REWARDED
                ? 'This referral is closed and did not pay a bonus.'
                : `${formatCentavos(
                    summary.introducedBy.soFarCentavos,
                  )} of ${formatCentavos(
                    summary.programme.qualifyingEarningsCentavos,
                  )} earned — ${formatCentavos(
                    summary.introducedBy.toGoCentavos,
                  )} to go before your welcome bonus.`}
          </p>
        </div>
      ) : null}
    </section>
  );
}
