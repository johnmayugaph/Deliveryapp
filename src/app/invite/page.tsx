import Link from 'next/link';
import { ReferralStatus } from '@prisma/client';
import { requireScreen } from '@/lib/auth/access';
import { inviteSummary } from '@/lib/referrals/summary';
import { ensureReferralCode } from '@/lib/referrals/codes';
import { formatCentavos } from '@/lib/money';
import { ShareInvite } from '@/components/referrals/ShareInvite';
import { EnterCode } from '@/components/referrals/EnterCode';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * A customer's own invite screen.
 *
 * Three things, in this order, because that is the order somebody wants them:
 * what it is worth, the code, and what has come of the ones they already sent.
 *
 * The last part is the one most referral screens omit and the one that decides
 * whether anybody shares a second link. "3 invited" tells a person nothing;
 * "Ana — waiting on her first order" and "Ben — ₱50, paid" tell them the thing
 * works and what it is waiting on. A refusal is shown with its reason for the
 * same reason: silence reads as the app having taken something.
 *
 * The code is minted on this page load rather than at signup — most accounts
 * never open this screen, and a column of unused codes only makes collisions
 * likelier.
 */
export default async function InvitePage() {
  const user = await requireScreen('invite');
  const summary = await inviteSummary(user.id);

  // Whether THIS account could still use somebody else's code. Shown only when
  // it is true, because a field that refuses everybody who sees it is worse
  // than no field: the two reasons it would refuse — already referred, already
  // a customer — are both permanent.
  const [alreadyReferred, completedOrders] = await Promise.all([
    prisma.referral.count({ where: { refereeId: user.id } }),
    prisma.order.count({ where: { customerId: user.id, status: 'COMPLETED' } }),
  ]);
  const couldUseACode = summary.isLive && alreadyReferred === 0 && completedOrders === 0;

  // No code for a dead offer: showing somebody a code that earns nothing is
  // worse than telling them invites are not running.
  const code = summary.isLive ? await ensureReferralCode(user.id) : null;

  return (
    <main className="px-4 py-5 pb-10">
      <h1 className="text-lg font-bold">Invite friends</h1>

      {!summary.isLive ? (
        <div className="mt-3 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
          <p className="text-sm font-semibold">Invites are not running yet.</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
            When they are, you will get credits for every friend who orders — and
            they will get credits to spend on their first order. Nothing to do
            for now.
          </p>
          <Link
            href="/"
            className="mt-3 inline-block text-xs font-semibold text-brand-700"
          >
            Back to the app
          </Link>
        </div>
      ) : (
        <>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Your friend gets{' '}
            <strong className="text-ink">
              {formatCentavos(summary.programme.refereeCentavos)}
            </strong>{' '}
            in credits to spend on their first order.{' '}
            {summary.programme.referrerCentavos > 0 ? (
              <>
                You get{' '}
                <strong className="text-ink">
                  {formatCentavos(summary.programme.referrerCentavos)}
                </strong>{' '}
                once that order arrives
                {summary.programme.minimumOrderCentavos > 0
                  ? ` — as long as it is ${formatCentavos(
                      summary.programme.minimumOrderCentavos,
                    )} or more`
                  : ''}
                .
              </>
            ) : null}
          </p>

          {code ? <ShareInvite code={code} /> : null}

          {couldUseACode ? <EnterCode /> : null}

          <section
            aria-label="Your invites"
            className="mt-4 grid grid-cols-3 gap-2"
          >
            <Stat label="Invited" value={String(summary.invited)} />
            <Stat label="Waiting" value={String(summary.waiting)} />
            <Stat label="Earned" value={formatCentavos(summary.earnedCentavos)} />
          </section>

          {summary.remainingThisMonth !== null &&
          summary.remainingThisMonth === 0 ? (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900">
              You have earned the most invites can pay this month. Your code
              still works and your friends still get their credits — yours start
              again next month.
            </p>
          ) : summary.remainingThisMonth !== null ? (
            <p className="mt-3 text-[11px] text-ink-faint">
              {summary.remainingThisMonth} more can pay you this month.
            </p>
          ) : null}

          {summary.recent.length > 0 ? (
            <section aria-label="Recent invites" className="mt-4">
              <h2 className="text-[13px] font-semibold">Who you invited</h2>
              <ul className="mt-2 space-y-2">
                {summary.recent.map((row) => (
                  <li
                    key={row.id}
                    className="rounded-xl bg-surface px-3 py-2.5 shadow-sm ring-1 ring-black/5"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[13px] font-semibold">{row.name}</span>
                      {row.status === ReferralStatus.REWARDED ? (
                        <span className="text-[13px] font-bold tabular-nums text-emerald-700">
                          +{formatCentavos(row.rewardCentavos)}
                        </span>
                      ) : (
                        <span className="text-[11px] text-ink-faint">
                          {row.status === ReferralStatus.ATTRIBUTED
                            ? 'Waiting on their first order'
                            : 'No credits'}
                        </span>
                      )}
                    </div>
                    {row.blockedReason ? (
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                        {row.blockedReason}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="mt-4 text-xs leading-relaxed text-ink-muted">
              Nobody has used your code yet. It works best sent to one person
              with a reason — the shop you both like, say.
            </p>
          )}

          <p className="mt-5 text-[11px] leading-relaxed text-ink-faint">
            Credits can only be spent on orders in the app. They cannot be sent
            to anybody or turned back into cash, and invite codes are for people
            who have not ordered with us before.
          </p>
        </>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface px-3 py-2.5 shadow-sm ring-1 ring-black/5">
      <p className="text-sm font-bold tabular-nums">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
        {label}
      </p>
    </div>
  );
}
