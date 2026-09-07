import type { ReviewSummary } from '@/lib/ratings/reviews';
import { MAX_STARS, MIN_REVIEWS_TO_SHOW, STAR_VALUES } from '@/lib/ratings/policy';

/**
 * Somebody's own ratings, for the merchant back office and the fleet profile.
 *
 * NO AUTHOR ANYWHERE, and that is the whole design rather than an omission.
 * The functions that feed this — `storeReviews` and `partnerReviews` — cannot
 * return one, so this component cannot leak one. A rider who can see who gave
 * them one star also knows that person's address, and a shop that can see who
 * complained can decide how to treat them next time.
 *
 * What it shows instead is the order number, which identifies the transaction
 * being described without identifying the person, and which the recipient can
 * look up in their own history.
 *
 * It shows the average from the first review rather than waiting for
 * `MIN_REVIEWS_TO_SHOW`, unlike the customer-facing badge. That threshold
 * exists to stop one review being presented to a stranger as a verdict on a
 * shop; a shop looking at its own numbers should see all of them, and the
 * count is right there beside it.
 */
export function ReviewPanel({
  summary,
  /** "The food" or "Your deliveries" — what these scores are about. */
  heading,
  emptyNote,
}: {
  summary: ReviewSummary;
  heading: string;
  emptyNote: string;
}) {
  const worst = Math.max(...STAR_VALUES.map((star) => summary.breakdown[star] ?? 0), 1);

  return (
    <section
      aria-labelledby="reviews-heading"
      className="rounded-xl bg-surface p-4 shadow-sm ring-1 ring-black/5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="reviews-heading" className="text-[13px] font-semibold">
          {heading}
        </h2>
        {summary.ratingCount > 0 ? (
          <span className="text-sm font-bold tabular-nums">
            <span aria-hidden className="text-amber-500">
              ★
            </span>{' '}
            {summary.ratingAvg.toFixed(1)}
            <span className="ml-1 text-[11px] font-normal text-ink-muted">
              {summary.ratingCount} rating{summary.ratingCount === 1 ? '' : 's'}
            </span>
          </span>
        ) : null}
      </div>

      {summary.ratingCount === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{emptyNote}</p>
      ) : (
        <>
          {summary.ratingCount < MIN_REVIEWS_TO_SHOW ? (
            <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
              Customers do not see a score until there are {MIN_REVIEWS_TO_SHOW}.
            </p>
          ) : null}

          <dl className="mt-3 space-y-1">
            {STAR_VALUES.map((star) => {
              const count = summary.breakdown[star] ?? 0;
              return (
                <div key={star} className="flex items-center gap-2 text-[11px]">
                  <dt className="w-8 shrink-0 tabular-nums text-ink-muted">
                    {star}
                    <span aria-hidden className="text-ink-faint">
                      ★
                    </span>
                    <span className="sr-only"> out of {MAX_STARS}</span>
                  </dt>
                  <dd className="flex flex-1 items-center gap-2">
                    <span
                      aria-hidden
                      className="h-1.5 rounded-full bg-amber-400"
                      // A share of the LARGEST bar, not of the total: with 40
                      // five-star reviews and 2 one-stars, bars scaled to the
                      // total make the complaints invisible, which is the one
                      // thing this panel exists to surface.
                      style={{ width: `${Math.max(2, (count / worst) * 100)}%` }}
                    />
                    <span className="w-6 shrink-0 tabular-nums text-ink-faint">
                      {count}
                    </span>
                  </dd>
                </div>
              );
            })}
          </dl>

          {summary.recent.some((review) => review.comment !== null) ? (
            <ul className="mt-4 space-y-2.5 border-t border-black/5 pt-3">
              {summary.recent
                .filter((review) => review.comment !== null)
                .map((review) => (
                  <li key={review.id}>
                    <p className="text-xs leading-relaxed">{review.comment}</p>
                    <p className="mt-0.5 text-[11px] text-ink-faint">
                      <span aria-hidden className="text-amber-500">
                        {'★'.repeat(review.stars)}
                      </span>
                      <span className="sr-only">
                        {review.stars} out of {MAX_STARS}
                      </span>{' '}
                      · {review.orderNumber} ·{' '}
                      {review.createdAt.toLocaleDateString('en-PH', {
                        day: 'numeric',
                        month: 'short',
                        timeZone: 'Asia/Manila',
                      })}
                    </p>
                  </li>
                ))}
            </ul>
          ) : null}

          <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
            Comments are not shown on your public page, and we do not tell you
            who wrote one.
          </p>
        </>
      )}
    </section>
  );
}
