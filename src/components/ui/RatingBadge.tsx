import { describeRating, MIN_REVIEWS_TO_SHOW } from '@/lib/ratings/policy';

/**
 * A shop's rating, or an honest absence of one.
 *
 * The reason this is a component rather than `ratingAvg.toFixed(1)` inline in
 * four places: one five-star review makes a new shop look better than a shop
 * with two hundred reviews averaging 4.6, and a customer reading "★ 5.0" has
 * no way to tell which they are looking at. Below `MIN_REVIEWS_TO_SHOW` it
 * says "New" instead — which is true, useful, and not a claim.
 *
 * Before ratings could be written this rendered "★ 0.0" everywhere, which was
 * worse than either.
 */
export function RatingBadge({
  ratingAvg,
  ratingCount,
  /** Show the count in brackets. For a shop's own page, not a list. */
  withCount = false,
}: {
  ratingAvg: number;
  ratingCount: number;
  withCount?: boolean;
}) {
  const rating = describeRating({ ratingAvg, ratingCount });

  if (!rating.show) {
    return (
      <span
        title={
          rating.count === 0
            ? 'No ratings yet'
            : `${rating.count} rating${rating.count === 1 ? '' : 's'} — shown from ${MIN_REVIEWS_TO_SHOW}`
        }
      >
        New
      </span>
    );
  }

  return (
    <span>
      <span aria-hidden>★</span> {rating.label}
      <span className="sr-only"> out of 5</span>
      {withCount ? ` (${rating.count})` : ''}
    </span>
  );
}
