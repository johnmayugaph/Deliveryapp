import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ReferralStatus } from '@prisma/client';
import { getFleetPartner } from '@/lib/fleet/partner';
import { partnerInviteSummary } from '@/lib/referrals/partner-summary';
import { ensureReferralCode } from '@/lib/referrals/codes';
import { formatCentavos } from '@/lib/money';
import { ShareInvite } from '@/components/referrals/ShareInvite';

export const dynamic = 'force-dynamic';

/**
 * A rider's own invite screen.
 *
 * ### The two things it has to be honest about
 *
 * **It is money, and it is owed rather than paid.** A bonus lands on the
 * settlement ledger, which means it arrives in the next payout somebody
 * records — not instantly, and not as credits. Every sentence here says
 * "owed" or "payout" for that reason. A rider who reads "you earned ₱500" and
 * then cannot find ₱500 has been told something false about their own money.
 *
 * **What each invite is waiting on, as a number.** "Ben — 12 of 20
 * deliveries" is something a rider can act on: they can message Ben. "Ben —
 * waiting" is not, and a screen full of "waiting" is why most referral
 * programmes are shared once and never again.
 *
 * The code is the SAME code as the customer invite screen shows — one person,
 * one code, and what it earns depends on what the invitee does. It is minted
 * on this page load rather than at signup, like the other one.
 */
export default async function FleetInvitePage() {
  const partner = await getFleetPartner();
  if (!partner) {
    redirect('/fleet/apply');
  }

  const summary = await partnerInviteSummary(partner.id);

  // No code for a dead offer. Showing a rider a code that earns nothing is
  // worse than telling them invites are not running.
  const code = summary.isLive ? await ensureReferralCode(partner.userId) : null;

  const plural = (count: number, one: string, many: string): string =>
    count === 1 ? one : many;

  return (
    <main className="px-4 py-4 pb-10">
      <h1 className="text-lg font-bold">Invite a rider</h1>

      {!summary.isLive ? (
        <div className="mt-3 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
          <p className="text-sm font-semibold">Rider invites are not running yet.</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
            When they are, you will be paid for every rider you bring who
            actually starts delivering — added to what TARA owes you, so it
            arrives with your payout. Nothing to do for now.
          </p>
          <Link
            href="/fleet"
            className="mt-3 inline-block text-xs font-semibold text-brand-700"
          >
            Back to offers
          </Link>
        </div>
      ) : (
        <>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            You get{' '}
            <strong className="text-ink">
              {formatCentavos(summary.programme.referrerCentavos)}
            </strong>{' '}
            for every rider you bring, once they have completed{' '}
            <strong className="text-ink">
              {summary.programme.qualifyingDeliveries}{' '}
              {plural(summary.programme.qualifyingDeliveries, 'delivery', 'deliveries')}
            </strong>
            .
            {summary.programme.refereeCentavos > 0 ? (
              <>
                {' '}
                They get{' '}
                <strong className="text-ink">
                  {formatCentavos(summary.programme.refereeCentavos)}
                </strong>{' '}
                at the same time.
              </>
            ) : null}
          </p>

          <p className="mt-2 rounded-lg bg-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
            This is <strong className="text-ink">money, not credits</strong> — it
            is added to what TARA owes you and goes out with your next payout,
            the same as the fees you earn riding.
          </p>

          {code ? <ShareInvite code={code} variant="RIDER" /> : null}

          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-surface px-2 py-2.5 shadow-sm ring-1 ring-black/5">
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                Invited
              </dt>
              <dd className="text-base font-bold tabular-nums">{summary.invited}</dd>
            </div>
            <div className="rounded-xl bg-surface px-2 py-2.5 shadow-sm ring-1 ring-black/5">
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                Still riding to it
              </dt>
              <dd className="text-base font-bold tabular-nums">{summary.waiting}</dd>
            </div>
            <div className="rounded-xl bg-surface px-2 py-2.5 shadow-sm ring-1 ring-black/5">
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                Earned
              </dt>
              <dd className="text-base font-bold tabular-nums">
                {formatCentavos(summary.earnedCentavos)}
              </dd>
            </div>
          </dl>

          {summary.remainingThisMonth !== null &&
          summary.remainingEver !== null ? (
            <p className="mt-2 px-1 text-[11px] text-ink-faint">
              {summary.remainingThisMonth === 0
                ? 'You have earned the most invites can pay this month. Anybody you invite now still gets their own bonus.'
                : `${summary.remainingThisMonth} more ${plural(
                    summary.remainingThisMonth,
                    'invite',
                    'invites',
                  )} can pay you this month, ${summary.remainingEver} in total.`}
            </p>
          ) : null}

          {summary.recent.length > 0 ? (
            <section aria-labelledby="invited-heading" className="mt-4">
              <h2 id="invited-heading" className="px-1 text-[13px] font-semibold">
                Riders you brought
              </h2>
              <ul className="mt-1.5 divide-y divide-black/5 overflow-hidden rounded-xl bg-surface ring-1 ring-black/5">
                {summary.recent.map((row) => (
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
                            : `${row.deliveriesSoFar} of ${summary.programme.qualifyingDeliveries} deliveries — ${row.deliveriesToGo} to go`}
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
            </section>
          ) : (
            <p className="mt-4 px-1 text-[11px] leading-relaxed text-ink-muted">
              Nobody yet. A rider you invite appears here as soon as they apply
              with your code, with how many deliveries they have done.
            </p>
          )}
        </>
      )}

      {/* Their own side, when somebody invited them. Shown even with the
          programme off, because a bonus they are owed does not disappear
          because the offer stopped. */}
      {summary.invitedBy ? (
        <section
          aria-labelledby="invited-by-heading"
          className="mt-4 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
        >
          <h2 id="invited-by-heading" className="text-[13px] font-semibold">
            {summary.invitedBy.name} invited you
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            {summary.invitedBy.status === ReferralStatus.REWARDED
              ? summary.invitedBy.rewardCentavos > 0
                ? `Your ${formatCentavos(
                    summary.invitedBy.rewardCentavos,
                  )} welcome bonus is in what TARA owes you.`
                : 'You have qualified. This invite did not pay your side.'
              : summary.invitedBy.status === ReferralStatus.NOT_REWARDED
                ? 'This invite is closed and did not pay a bonus.'
                : `${summary.invitedBy.deliveriesSoFar} of ${summary.programme.qualifyingDeliveries} deliveries done — ${summary.invitedBy.deliveriesToGo} to go.`}
          </p>
        </section>
      ) : null}
    </main>
  );
}
