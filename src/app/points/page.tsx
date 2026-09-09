import Link from 'next/link';
import { LoyaltyEntryType } from '@prisma/client';
import { requireScreen } from '@/lib/auth/access';
import { pointsSummary } from '@/lib/loyalty/summary';
import { formatCentavos } from '@/lib/money';
import { RedeemPoints } from '@/components/loyalty/RedeemPoints';
import { TierBenefits } from '@/components/loyalty/TierBenefits';

export const dynamic = 'force-dynamic';

/**
 * A customer's points.
 *
 * The balance is shown in points AND in pesos, always together. A screen that
 * says "1,437 points" alone asks the customer to do the programme's own
 * arithmetic, and whatever they guess will be wrong in the direction that
 * disappoints them.
 *
 * The tier sits under it with the distance to the next one, because "142 more
 * points" is a reason to order and "you are Suki" is a label.
 *
 * And what expires next, before it happens. A balance that quietly shrank is
 * indistinguishable from a bug; a customer who was warned can spend.
 */
export default async function PointsPage() {
  /* Was `requireOnboardedUser()`, which THROWS. On a server action that is
     right; on a page it renders app/error.tsx — "This screen did not load.
     Something on our side broke." — to a customer whose session merely
     ended. Nothing broke, and they can fix it in one tap. */
  const user = await requireScreen('points');
  const summary = await pointsSummary(user.id);

  if (!summary.isLive) {
    return (
      <main className="px-4 py-5">
        <h1 className="text-lg font-bold">Points</h1>
        <div className="mt-3 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5">
          <p className="text-sm font-semibold">Points are not running yet.</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
            When they are, you will earn points on every order and turn them into
            credits to spend on the next one. Nothing to do for now.
          </p>
          <Link
            href="/credits"
            className="mt-3 inline-block text-xs font-semibold text-brand-700"
          >
            See your credits
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="px-4 py-5 pb-10">
      <h1 className="text-lg font-bold">Points</h1>

      <section
        aria-label="Your points"
        className="mt-3 rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
      >
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          Your points
        </p>
        <p className="mt-1 text-3xl font-bold tabular-nums">
          {summary.points.toLocaleString('en-PH')}
        </p>
        <p className="mt-0.5 text-sm text-ink-muted">
          Worth {formatCentavos(summary.valueCentavos)} in credits
        </p>

        {summary.current ? (
          <div className="mt-3 border-t border-black/5 pt-3">
            <p className="text-[13px] font-semibold">
              You are {summary.current.name}
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
              {summary.current.blurb}
            </p>
            {summary.next ? (
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
                {summary.pointsToNext.toLocaleString('en-PH')} more points and you
                are <strong className="text-ink">{summary.next.name}</strong> —{' '}
                {summary.next.blurb.toLowerCase()}
              </p>
            ) : (
              <p className="mt-1.5 text-[11px] text-ink-muted">
                This is the top tier.
              </p>
            )}
          </div>
        ) : null}
      </section>

      {/* What the tier is actually worth, directly under the tier's name.
          Until this existed a tier was a word and a blurb: the multiplier was
          real but invisible, and every other benefit was unbuilt. A status
          band nobody can price is a status band nobody works towards. */}
      {summary.current ? (
        <TierBenefits
          benefits={summary.currentBenefits}
          heading={`What ${summary.current.name} gets you`}
          emptyText={
            summary.current.earnMultiplierBasisPoints > 10_000
              ? `${summary.current.name} earns points ${(
                  summary.current.earnMultiplierBasisPoints / 10_000
                ).toFixed(2)}× as fast. Nothing else is attached to it yet.`
              : `Nothing is attached to ${summary.current.name} yet.`
          }
        />
      ) : null}

      {summary.next && summary.nextBenefits.length > 0 ? (
        <TierBenefits
          benefits={summary.nextBenefits}
          heading={`What ${summary.next.name} would add`}
          alreadyHave={summary.currentBenefits.map((benefit) => benefit.type)}
        />
      ) : null}

      {/* One component owns both the offer and the "not yet" line. Splitting
          them meant redeeming unmounted the control and took its own success
          message with it — the balance changed and the customer was told
          nothing, which reads exactly like a tap that failed. */}
      <RedeemPoints
        offer={
          summary.offer.refusal === null
            ? {
                points: summary.offer.pointsSpent,
                centavos: summary.offer.centavosGranted,
              }
            : null
        }
        points={summary.points}
        blockPoints={summary.programme.redemptionBlockPoints}
      />

      {summary.nextExpiry ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900">
          {summary.nextExpiry.points.toLocaleString('en-PH')} of your points
          expire on{' '}
          {summary.nextExpiry.at.toLocaleDateString('en-PH', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
          . Redeem them before then and the credits do not expire.
        </p>
      ) : null}

      {summary.history.length > 0 ? (
        <section aria-label="History" className="mt-5">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
            History
          </h2>
          <ul className="mt-2 space-y-1.5">
            {summary.history.map((row) => (
              <li
                key={row.id}
                className="flex items-baseline justify-between gap-3 rounded-xl bg-surface px-3 py-2.5 shadow-sm ring-1 ring-black/5"
              >
                <span className="min-w-0">
                  <span className="block text-xs">{row.description}</span>
                  <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-ink-faint">
                    {row.createdAt.toLocaleDateString('en-PH', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                </span>
                <span
                  className={`text-[13px] font-bold tabular-nums ${
                    row.points > 0
                      ? 'text-emerald-700'
                      : row.type === LoyaltyEntryType.EXPIRED
                        ? 'text-ink-faint'
                        : 'text-ink'
                  }`}
                >
                  {row.points > 0 ? '+' : ''}
                  {row.points.toLocaleString('en-PH')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="mt-4 text-xs leading-relaxed text-ink-muted">
          You have not earned any points yet. They arrive when an order is
          delivered, not when it is placed.
        </p>
      )}

      <p className="mt-5 text-[11px] leading-relaxed text-ink-faint">
        Points are earned on the food in your order, not on the delivery fee or
        the tip — those go to your rider. They become credits, which can only be
        spent on orders in this app and cannot be sent to anybody or turned back
        into cash.
      </p>
    </main>
  );
}
