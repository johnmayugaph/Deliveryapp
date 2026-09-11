import type { PublicReview } from '@/lib/ratings/reviews';
import { MAX_STARS } from '@/lib/ratings/policy';

/**
 * "What people say" — a shop's own reviews, in the customer's words.
 *
 * NO NAMES. The reference this follows prints a first name beside each quote;
 * ours cannot, because `publicStoreReviews` does not return one and the
 * function it is separated from does not return one either. That is the whole
 * design of `reviews.ts`: a rider who can see who gave them one star also
 * knows that person's address. The quote and the score are what a stranger
 * came here to read anyway.
 *
 * Only reviews with words in them, which the loader enforces. A rail of bare
 * five-star rows says less than the number already on the shop's card.
 */
export function ReviewRail({ reviews }: { reviews: PublicReview[] }) {
  if (reviews.length === 0) {
    // Nothing at all rather than an empty frame saying "no reviews yet" — on a
    // new shop that frame is the biggest thing on the page, and it is an
    // announcement that nobody has ordered.
    return null;
  }

  return (
    <section aria-labelledby="reviews-rail-heading" className="bg-surface-sunken py-4">
      <h2
        id="reviews-rail-heading"
        className="px-4 text-[19px] font-extrabold tracking-tight"
      >
        What people say
      </h2>
      <ul
        className="mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4"
        style={{ scrollbarWidth: 'none' }}
      >
        {reviews.map((review) => (
          <li
            key={review.id}
            className="w-[17rem] shrink-0 snap-start rounded-2xl bg-surface p-3.5 shadow-tile ring-1 ring-ink/[0.06]"
          >
            {/* Three lines, then it stops. A review card that grows to fit its
                longest review makes every other card in the rail that tall
                too, and the rail is a taster — the shop's own page is where
                somebody reads all of them. */}
            <p className="line-clamp-3 text-[13.5px] leading-snug">{review.comment}</p>
            {/*
              * `relative` is load-bearing. The screen-reader text below is
              * `position: absolute` (that is what `sr-only` is), and with no
              * positioned ancestor its containing block is the document
              * rather than this card — so inside a horizontally scrolled rail
              * it anchored itself wherever the card had been scrolled to and
              * dragged the PAGE's scroll width out with it. The whole store
              * page could be swiped 525px sideways because of a one-pixel
              * span nobody can see.
              */}
            <p className="relative mt-2 text-[13px] tracking-tight">
              <span aria-hidden className="text-sun-500">
                {'★'.repeat(review.stars)}
                <span className="text-ink-faint">
                  {'★'.repeat(MAX_STARS - review.stars)}
                </span>
              </span>
              <span className="sr-only">
                {review.stars} out of {MAX_STARS}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
