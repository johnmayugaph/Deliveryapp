import { OrderStatus } from '@prisma/client';

/**
 * What a rating is, when one may be left, and when a number is worth showing.
 *
 * All pure. The interesting decisions here are about restraint rather than
 * arithmetic: a rating system's failure mode is not a wrong average, it is an
 * average that looks authoritative on the strength of one review.
 */

export const MIN_STARS = 1;
export const MAX_STARS = 5;

/** Every value a star control may offer. Ordered high to low, as they read. */
export const STAR_VALUES: readonly number[] = [5, 4, 3, 2, 1];

/**
 * What each score means, so the two ends are not left to interpretation.
 *
 * Written out because a bare five-point scale means different things to
 * different people, and "3" from somebody who thinks it is the midpoint is not
 * the same signal as "3" from somebody who thinks it is a pass.
 */
export const STAR_LABELS: Readonly<Record<number, string>> = {
  5: 'Very good',
  4: 'Good',
  3: 'Okay',
  2: 'Poor',
  1: 'Very bad',
};

/**
 * Reads a score out of form data.
 *
 * Returns null for absent, blank, or anything not a whole 1–5 — which is the
 * same answer, because a form offering five radio buttons has no legitimate
 * way to produce a 7 and the caller's next question is only ever "did they
 * rate this".
 */
export function parseStars(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  if (value < MIN_STARS || value > MAX_STARS) return null;
  return value;
}

export const MAX_COMMENT_LENGTH = 500;

/** Trimmed, capped, and null rather than an empty string. */
export function normaliseComment(raw: unknown): string | null {
  const comment = String(raw ?? '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, MAX_COMMENT_LENGTH);
  return comment.length > 0 ? comment : null;
}

// --- When somebody may rate --------------------------------------------------

/**
 * How long after an order somebody may rate it.
 *
 * A fortnight. Long enough that a rating is not a race, short enough that the
 * average describes the shop as it is now — a restaurant that changed hands in
 * March should not be carrying January's kitchen. It also stops a bulk pass
 * over a year of history from moving every aggregate at once.
 */
export const RATING_WINDOW_DAYS = 14;

export function reviewWindowClosesAt(completedAt: Date): Date {
  return new Date(completedAt.getTime() + RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export type ReviewEligibility =
  | { allowed: true }
  | { allowed: false; reason: 'NOT_COMPLETED' | 'NO_COMPLETION_TIME' | 'WINDOW_CLOSED' };

/**
 * Only a COMPLETED order can be rated, and only for a while.
 *
 * Not a cancelled one, and not a failed delivery. That looks harsh — somebody
 * whose order never arrived has the strongest opinion of anybody — but a
 * rating is a judgement of an experience that happened, and what they actually
 * need is a refund and a person to talk to. Both exist: the timeout sweep
 * refunds automatically, and the tracking screen offers support. Letting a
 * non-delivery become a one-star review would fold two different problems into
 * the one signal dispatch ranking reads.
 */
export function canReviewOrder(input: {
  status: OrderStatus;
  completedAt: Date | null;
  now?: Date;
}): ReviewEligibility {
  if (input.status !== OrderStatus.COMPLETED) {
    return { allowed: false, reason: 'NOT_COMPLETED' };
  }
  if (input.completedAt === null) {
    // Completed with no timestamp should not happen — the state machine sets
    // it — but the window cannot be computed from nothing, and guessing would
    // mean either refusing every such order or accepting them forever.
    return { allowed: false, reason: 'NO_COMPLETION_TIME' };
  }
  const now = input.now ?? new Date();
  if (now.getTime() > reviewWindowClosesAt(input.completedAt).getTime()) {
    return { allowed: false, reason: 'WINDOW_CLOSED' };
  }
  return { allowed: true };
}

export const REVIEW_REFUSAL_MESSAGE: Readonly<
  Record<Exclude<ReviewEligibility, { allowed: true }>['reason'], string>
> = {
  NOT_COMPLETED:
    'You can rate an order once it has been delivered. If something went ' +
    'wrong with this one, message support from the order instead.',
  NO_COMPLETION_TIME: 'This order cannot be rated. Message support if you need to.',
  WINDOW_CLOSED: `Ratings close ${RATING_WINDOW_DAYS} days after delivery.`,
};

// --- What an aggregate is worth ----------------------------------------------

/**
 * Below this, no number is shown at all.
 *
 * The whole reason this constant exists: one five-star review makes a new shop
 * look better than a shop with two hundred reviews averaging 4.6, and a
 * customer reading "★ 5.0" has no way to know which they are looking at. Three
 * is not statistically meaningful either, but it is the point at which the
 * number stops being one person's afternoon.
 */
export const MIN_REVIEWS_TO_SHOW = 3;

export type RatingDisplay =
  | { show: true; label: string; count: number }
  /** Not "no rating" — "not enough yet", which reads differently. */
  | { show: false; count: number };

export function describeRating(input: {
  ratingAvg: number;
  ratingCount: number;
}): RatingDisplay {
  if (input.ratingCount < MIN_REVIEWS_TO_SHOW) {
    return { show: false, count: input.ratingCount };
  }
  return {
    show: true,
    label: input.ratingAvg.toFixed(1),
    count: input.ratingCount,
  };
}

/**
 * The average, to two decimals.
 *
 * Stored rather than computed on read because dispatch ranking sorts on it and
 * the storefront lists on it. Two decimals so a 4.65 does not become 4.7 in
 * the column that decides who gets offered work first, while the screens
 * render one.
 */
export function averageStars(scores: readonly number[]): number {
  if (scores.length === 0) return 0;
  const total = scores.reduce((sum, score) => sum + score, 0);
  return Math.round((total / scores.length) * 100) / 100;
}

/** For a screen reader, and for the title attribute. */
export function starsAsWords(stars: number): string {
  return `${stars} out of ${MAX_STARS}${
    STAR_LABELS[stars] ? ` — ${STAR_LABELS[stars].toLowerCase()}` : ''
  }`;
}

// --- Telling the shop and the rider ------------------------------------------

/**
 * How long a rating waits before anybody is told about it.
 *
 * An hour, and the delay is the feature. A notification per rating is a buzz
 * per star: a shop with a good lunch would get thirty of them, learn to swipe
 * them away, and miss the one that mattered. Waiting an hour turns that into
 * one message that says "eleven new ratings, averaging 4.6, lowest was a two"
 * — which is both less annoying and more useful.
 *
 * Nothing is urgent about a rating. Nobody is waiting on the shop to read it.
 */
export const RATING_DIGEST_DELAY_MINUTES = 60;

export interface RatingDigest {
  count: number;
  average: number;
  lowest: number;
}

/**
 * Folds a batch of scores into what a digest says.
 *
 * `lowest` is carried on purpose. A digest that reported only a count and an
 * average would let a single one-star hide inside a good afternoon, and the
 * bad one is the entire reason to open the screen.
 */
export function foldRatingDigest(scores: readonly number[]): RatingDigest | null {
  if (scores.length === 0) return null;
  return {
    count: scores.length,
    average: averageStars(scores),
    lowest: Math.min(...scores),
  };
}

/** Whether a batch is old enough to send. */
export function digestIsDue(input: {
  /** When the oldest un-notified rating in the batch arrived. */
  oldestAt: Date;
  now: Date;
  delayMinutes?: number;
}): boolean {
  const delay = input.delayMinutes ?? RATING_DIGEST_DELAY_MINUTES;
  return input.now.getTime() - input.oldestAt.getTime() >= delay * 60 * 1000;
}
