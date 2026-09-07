import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@prisma/client';
import { NotificationChannel, NotificationKind } from '@prisma/client';
import { KIND_POLICY } from '@/lib/notifications/policy';
import { renderNotification } from '@/lib/notifications/templates';
import {
  MAX_COMMENT_LENGTH,
  MIN_REVIEWS_TO_SHOW,
  RATING_WINDOW_DAYS,
  REVIEW_REFUSAL_MESSAGE,
  STAR_LABELS,
  STAR_VALUES,
  averageStars,
  canReviewOrder,
  describeRating,
  normaliseComment,
  parseStars,
  RATING_DIGEST_DELAY_MINUTES,
  digestIsDue,
  foldRatingDigest,
  reviewWindowClosesAt,
  starsAsWords,
} from '@/lib/ratings/policy';
import { countByStar } from '@/lib/ratings/reviews';

/**
 * Ratings.
 *
 * `Store.ratingAvg` and `FleetPartner.ratingAvg` were read in six places from
 * the first commit and written by nothing. Now that they are written, two
 * properties matter more than the arithmetic: the aggregate must be derivable
 * from the rows (because dispatch ranking scores on it and a drifted average
 * misroutes work silently), and a comment must not end up somewhere it can
 * hurt the person who wrote it.
 */

function source(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, '..', '..', relativePath), 'utf8');
}

function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(
      (line) =>
        !line.trimStart().startsWith('//') && !line.trimStart().startsWith('--'),
    )
    .join('\n');
}

// -----------------------------------------------------------------------------
// A score
// -----------------------------------------------------------------------------

describe('reading a score', () => {
  it('takes one to five', () => {
    for (const stars of STAR_VALUES) {
      expect(parseStars(String(stars)), String(stars)).toBe(stars);
    }
  });

  it('treats absent, blank and impossible the same way', () => {
    // The caller's only question is "did they rate this", and a form with five
    // radio buttons has no legitimate way to produce a 7.
    for (const raw of [null, undefined, '', '0', '6', '-1', '2.5', 'abc', {}]) {
      expect(parseStars(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('has words for both ends of the scale', () => {
    // A bare five-point scale means different things to different people:
    // "3" from somebody who reads it as the midpoint is not the same signal as
    // "3" from somebody who reads it as a pass.
    expect(Object.keys(STAR_LABELS).sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(starsAsWords(3)).toMatch(/3 out of 5/);
    expect(starsAsWords(1).toLowerCase()).toContain('very bad');
  });
});

describe('the comment', () => {
  it('trims, collapses and caps', () => {
    expect(normaliseComment('  cold    food  ')).toBe('cold food');
    expect(normaliseComment('x'.repeat(MAX_COMMENT_LENGTH + 200))).toHaveLength(
      MAX_COMMENT_LENGTH,
    );
  });

  it('is null rather than empty', () => {
    // So "did they say anything" is one check and not two.
    for (const raw of ['', '   ', null, undefined]) {
      expect(normaliseComment(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

// -----------------------------------------------------------------------------
// When
// -----------------------------------------------------------------------------

describe('who may rate an order', () => {
  const completedAt = new Date('2026-09-01T10:00:00Z');
  const within = new Date('2026-09-05T10:00:00Z');

  it('allows a delivered order inside the window', () => {
    expect(
      canReviewOrder({ status: OrderStatus.COMPLETED, completedAt, now: within }),
    ).toEqual({ allowed: true });
  });

  it('closes the window exactly when it says it does', () => {
    const closes = reviewWindowClosesAt(completedAt);
    expect(closes.getTime() - completedAt.getTime()).toBe(
      RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(
      canReviewOrder({ status: OrderStatus.COMPLETED, completedAt, now: closes }).allowed,
    ).toBe(true);
    expect(
      canReviewOrder({
        status: OrderStatus.COMPLETED,
        completedAt,
        now: new Date(closes.getTime() + 1),
      }),
    ).toEqual({ allowed: false, reason: 'WINDOW_CLOSED' });
  });

  it('refuses anything that did not actually happen', () => {
    // Harsh-looking and deliberate. Somebody whose order never arrived has the
    // strongest opinion of anybody — and what they need is a refund and a
    // person to talk to, both of which exist. Letting a non-delivery become a
    // one-star review folds two different problems into the one signal
    // dispatch ranking reads.
    for (const status of [
      OrderStatus.CANCELLED_BY_CUSTOMER,
      OrderStatus.CANCELLED_BY_MERCHANT,
      OrderStatus.CANCELLED_BY_RIDER,
      OrderStatus.CANCELLED_BY_SYSTEM,
      OrderStatus.FAILED_DELIVERY,
      OrderStatus.PREPARING,
    ]) {
      expect(canReviewOrder({ status, completedAt, now: within }), status).toEqual({
        allowed: false,
        reason: 'NOT_COMPLETED',
      });
    }
  });

  it('points a refused customer at support rather than nowhere', () => {
    expect(REVIEW_REFUSAL_MESSAGE.NOT_COMPLETED).toMatch(/support/i);
  });

  it('refuses a completed order with no completion time rather than guessing', () => {
    // Should not happen — the state machine sets it — but the window cannot be
    // computed from nothing, and guessing means either refusing every such
    // order forever or accepting them forever.
    expect(
      canReviewOrder({ status: OrderStatus.COMPLETED, completedAt: null, now: within }),
    ).toEqual({ allowed: false, reason: 'NO_COMPLETION_TIME' });
  });

  it('has a sentence for every refusal', () => {
    for (const reason of ['NOT_COMPLETED', 'NO_COMPLETION_TIME', 'WINDOW_CLOSED'] as const) {
      expect(REVIEW_REFUSAL_MESSAGE[reason].length).toBeGreaterThan(10);
    }
  });

  it('does not let a rating be left forever', () => {
    // The average should describe the shop as it is now. A restaurant that
    // changed hands in March should not be carrying January's kitchen.
    expect(RATING_WINDOW_DAYS).toBeGreaterThan(0);
    expect(RATING_WINDOW_DAYS).toBeLessThanOrEqual(60);
  });
});

// -----------------------------------------------------------------------------
// The average
// -----------------------------------------------------------------------------

describe('averaging', () => {
  it('is zero for nothing, not NaN', () => {
    // A shop with no reviews is sorted and displayed alongside the rest.
    expect(averageStars([])).toBe(0);
  });

  it('keeps two decimals, because one is what the screens round to', () => {
    // Dispatch ranking sorts on the stored value. Rounding 4.65 to 4.7 in the
    // column that decides who is offered work first is a change of substance.
    expect(averageStars([5, 4])).toBe(4.5);
    expect(averageStars([5, 4, 4])).toBe(4.33);
    expect(averageStars([5, 5, 4, 4])).toBe(4.5);
    expect(averageStars([1])).toBe(1);
  });
});

describe('showing a rating to a stranger', () => {
  it('says nothing until there is more than one person’s afternoon', () => {
    // One five-star review makes a new shop look better than a shop with two
    // hundred reviews averaging 4.6, and the customer reading "★ 5.0" cannot
    // tell which they are looking at.
    expect(MIN_REVIEWS_TO_SHOW).toBeGreaterThan(1);
    expect(describeRating({ ratingAvg: 5, ratingCount: 1 })).toEqual({
      show: false,
      count: 1,
    });
    expect(describeRating({ ratingAvg: 0, ratingCount: 0 })).toEqual({
      show: false,
      count: 0,
    });
  });

  it('shows it once there are enough', () => {
    const shown = describeRating({
      ratingAvg: 4.66,
      ratingCount: MIN_REVIEWS_TO_SHOW,
    });
    expect(shown.show).toBe(true);
    if (!shown.show) return;
    expect(shown.label).toBe('4.7');
    expect(shown.count).toBe(MIN_REVIEWS_TO_SHOW);
  });

  it('is what every customer-facing site uses', () => {
    // Before ratings could be written these rendered "★ 0.0" everywhere, which
    // was worse than either answer.
    for (const file of [
      'src/components/home/RecentStores.tsx',
      'src/app/stores/[slug]/page.tsx',
      'src/app/services/[key]/page.tsx',
    ]) {
      const code = codeOnly(source(file));
      expect(code, `${file} does not use the badge`).toMatch(/<RatingBadge/);
      expect(code, `${file} still formats the average itself`).not.toMatch(
        /ratingAvg\.toFixed/,
      );
    }
  });
});

describe('the breakdown', () => {
  it('counts every star and invents none', () => {
    expect(countByStar([5, 5, 4, 1])).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 2 });
    expect(countByStar([])).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  });

  it('ignores a score that should not exist', () => {
    // Defensive: the database check constrains this, but an aggregate that
    // silently absorbed a 0 would move a shop's bar chart.
    expect(countByStar([0, 6, 5])).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 });
  });
});

// -----------------------------------------------------------------------------
// The rule the whole thing rests on
// -----------------------------------------------------------------------------

describe('the reviews are the truth and the aggregate is derived', () => {
  const reviews = codeOnly(source('src/lib/ratings/reviews.ts'));

  it('never increments an aggregate', () => {
    // The same rule the credits ledger follows. An aggregate that has drifted
    // does not fail — it quietly offers work to the wrong people, and nobody
    // can reconcile it afterwards.
    expect(reviews).not.toMatch(/increment/);
  });

  it('recomputes both subjects inside the transaction that changed the review', () => {
    const submit = reviews.slice(reviews.indexOf('export async function submitReview'));
    const body = submit.slice(0, submit.indexOf('export async function recompute'));
    expect(body).toMatch(/prisma\.\$transaction/);
    expect(body).toMatch(/recomputeStoreRating\(affectedStore, tx\)/);
    expect(body).toMatch(/recomputePartnerRating\(affectedPartner, tx\)/);
  });

  it('recomputes what a review has JUST STOPPED being about', () => {
    // An edit that moved a score from the shop to the rider changes two
    // aggregates. Recomputing only the one just set leaves the other carrying
    // a score it no longer has.
    const submit = reviews.slice(reviews.indexOf('export async function submitReview'));
    expect(submit).toMatch(/subjects\.existing\?\.storeId/);
    expect(submit).toMatch(/subjects\.existing\?\.fleetPartnerId/);
  });

  it('can rebuild every aggregate from scratch, and there is a command for it', () => {
    expect(reviews).toMatch(/export async function recomputeAllRatings/);
    const scripts = JSON.parse(source('package.json')).scripts as Record<string, string>;
    expect(scripts['db:ratings-recompute']).toContain('recompute-ratings.ts');
  });

  it('does not let the seed invent an aggregate any more', () => {
    // It used to seed "4.7 from 412 reviews". Harmless while nothing wrote
    // ratings; a number no review supports now, which the recompute correctly
    // reports as drift.
    const seed = codeOnly(source('prisma/seed.ts'));
    expect(seed).not.toMatch(/ratingAvg:/);
    expect(seed).not.toMatch(/ratingCount:/);
  });

  it('always writes a score and its subject together', () => {
    // The invariant the SQL guards deliberately do NOT enforce, so this is
    // where it lives.
    const submit = reviews.slice(reviews.indexOf('export async function submitReview'));
    expect(submit).toMatch(/const storeId = storeStars === null \? null :/);
    expect(submit).toMatch(/const fleetPartnerId = partnerStars === null \? null :/);
  });
});

describe('the database guards', () => {
  const guard = codeOnly(source('prisma/sql/order_reviews.sql'));

  it('refuses a score outside one to five', () => {
    // A stray 0 or 11 does not error anywhere — it just moves the number a
    // shop is judged on.
    expect(guard).toMatch(/order_review_store_stars_range/);
    expect(guard).toMatch(/order_review_partner_stars_range/);
    expect(guard).toMatch(/>= 1 AND "storeStars" <= 5/);
  });

  it('refuses a review that rates nothing', () => {
    expect(guard).toMatch(/order_review_rates_something/);
    expect(guard).toMatch(/"storeStars" IS NOT NULL OR "partnerStars" IS NOT NULL/);
  });

  it('does NOT require a score to have a subject, and says why', () => {
    // Tried first, and it made a shop with any review on it undeletable:
    // `storeId` is ON DELETE SET NULL so that removing a shop does not erase
    // the rider's half, the cascade nulls the id, the stars stay, and the
    // DELETE fails on the check. Verified against the real database, not
    // assumed.
    expect(guard).not.toMatch(/order_review_score_needs_subject/);
    expect(source('prisma/sql/order_reviews.sql')).toMatch(/undeletable/);
  });
});

// -----------------------------------------------------------------------------
// Who sees what
// -----------------------------------------------------------------------------

describe('a comment cannot hurt the person who wrote it', () => {
  const reviews = source('src/lib/ratings/reviews.ts');

  it('never hands the author to a shop or a rider', () => {
    // A rider who can see who gave them one star also knows that person's
    // address. Enforced by what the function returns, not by remembering to
    // redact at the call site.
    for (const name of ['storeReviews', 'partnerReviews']) {
      const start = reviews.indexOf(`export async function ${name}`);
      const body = reviews.slice(start, reviews.indexOf('export ', start + 30));
      expect(body, `${name} selects the author`).not.toMatch(/author/);
    }
  });

  it('gives them the order number instead, which is what they can act on', () => {
    expect(codeOnly(source('src/components/ui/ReviewPanel.tsx'))).toMatch(
      /orderNumber/,
    );
    expect(codeOnly(source('src/components/ui/ReviewPanel.tsx'))).not.toMatch(
      /author/,
    );
  });

  it('shows an identity beside a comment in exactly one place', () => {
    const withAuthor = ['adminReviewFeed'];
    for (const name of ['reviewableOrder', 'storeReviews', 'partnerReviews', 'ratingSummary']) {
      const start = reviews.indexOf(`export async function ${name}`);
      const body = reviews.slice(start, reviews.indexOf('export ', start + 30));
      expect(body, `${name} returns an author`).not.toMatch(/author: \{ select/);
    }
    for (const name of withAuthor) {
      const start = reviews.indexOf(`export async function ${name}`);
      expect(reviews.slice(start, start + 900)).toMatch(/author: \{ select/);
    }
  });

  it('never renders a comment on a public page', () => {
    // A free-text review on a shop page is a moderation burden and a
    // defamation risk. The same sentence is worth a great deal to the operator
    // and the merchant, who are the ones who can act on it.
    for (const file of [
      'src/app/stores/[slug]/page.tsx',
      'src/app/services/[key]/page.tsx',
      'src/components/home/RecentStores.tsx',
    ]) {
      expect(codeOnly(source(file)), file).not.toMatch(/\.comment/);
    }
  });

  it('tells the customer where their words go, next to the box', () => {
    // People write differently when they think a shop will see their name, and
    // differently again when they think it will be published. Neither is what
    // happens.
    const form = source('src/components/orders/RatingForm.tsx');
    expect(form).toMatch(/not shown on their page/i);
    expect(form).toMatch(/not told who wrote it/i);
  });
});

// -----------------------------------------------------------------------------
// The form
// -----------------------------------------------------------------------------

describe('the rating control', () => {
  const form = codeOnly(source('src/components/orders/RatingForm.tsx'));

  it('is a radio group, not a row of buttons', () => {
    // Which is what a five-point scale is. A keyboard gets arrow keys, a
    // screen reader announces "3 out of 5, okay", and the value is in the form
    // whether or not any of the JavaScript ran.
    expect(form).toMatch(/type="radio"/);
    expect(form).toMatch(/<fieldset/);
    expect(form).toMatch(/<legend/);
  });

  it('rates the shop and the rider separately', () => {
    // The food and the ride are two different people's work, and one number
    // tells neither of them anything.
    expect(form).toMatch(/name="storeStars"/);
    expect(form).toMatch(/name="partnerStars"/);
  });

  it('waits for hydration, like every other form here', () => {
    expect(form).toMatch(/setHydrated\(true\)/);
    expect(form).toMatch(/disabled=\{pending \|\| !hydrated\}/);
    expect(source('src/components/orders/RatingForm.tsx')).toMatch(/<noscript>/);
  });

  it('only offers what the order actually has', () => {
    // A vertical with no merchant leg has no shop to rate; an order nobody was
    // dispatched to has no rider. Decided on the server, from the registry.
    expect(form).toMatch(/store \? \(/);
    expect(form).toMatch(/partner \? \(/);
    expect(codeOnly(source('src/lib/ratings/reviews.ts'))).toMatch(
      /service\.requiresMerchant/,
    );
  });
});

// -----------------------------------------------------------------------------
// Telling the shop and the rider
// -----------------------------------------------------------------------------

describe('the ratings digest', () => {
  it('folds a batch into a count, an average and the WORST of them', () => {
    // The lowest is carried on purpose: a digest reporting only a count and an
    // average lets a single one-star hide inside a good afternoon, and the bad
    // one is the entire reason to open the screen.
    expect(foldRatingDigest([5, 4, 2, 5])).toEqual({
      count: 4,
      average: 4,
      lowest: 2,
    });
    expect(foldRatingDigest([3])).toEqual({ count: 1, average: 3, lowest: 3 });
  });

  it('is nothing for nothing', () => {
    expect(foldRatingDigest([])).toBeNull();
  });

  it('waits, and the waiting is the feature', () => {
    // A notification per rating is a buzz per star: a shop with a good lunch
    // gets thirty, learns to swipe them away, and misses the one that
    // mattered. Nothing is urgent about a rating.
    expect(RATING_DIGEST_DELAY_MINUTES).toBeGreaterThanOrEqual(15);

    const oldestAt = new Date('2026-09-07T12:00:00Z');
    const tooSoon = new Date(oldestAt.getTime() + 5 * 60_000);
    const due = new Date(
      oldestAt.getTime() + RATING_DIGEST_DELAY_MINUTES * 60_000,
    );
    expect(digestIsDue({ oldestAt, now: tooSoon })).toBe(false);
    expect(digestIsDue({ oldestAt, now: due })).toBe(true);
  });

  it('is deferred overnight rather than waking somebody with bad news', () => {
    // INFORMATIONAL means quiet hours hold it to 6am. Here that is a feature:
    // nobody should learn they got one star at eleven at night, and it reads
    // no differently over breakfast.
    const policy = KIND_POLICY[NotificationKind.RATINGS_RECEIVED];
    expect(policy.urgency).toBe('INFORMATIONAL');
    expect(policy.unmutable).toBeUndefined();
  });

  it('never costs a peso', () => {
    // The volume is bounded by how many orders were delivered, which is the
    // number that spikes on a good day. A shop's best afternoon should not be
    // its biggest bill.
    expect(KIND_POLICY[NotificationKind.RATINGS_RECEIVED].channels).not.toContain(
      NotificationChannel.SMS,
    );
  });

  it('carries the numbers and never the words', () => {
    // A comment is text somebody typed about a person, and a notification
    // lands on a lock screen — the wrong place to read it, and the wrong place
    // for somebody else to read it.
    const rendered = renderNotification(NotificationKind.RATINGS_RECEIVED, {
      ratingCount: 3,
      ratingAverage: 4.33,
      ratingLowest: 2,
      ratingSubject: 'the food at Aling Nena',
    });
    expect(rendered.title).toContain('3');
    expect(rendered.body).toContain('4.3');
    expect(rendered.body).toContain('2');
    // Nothing in the context can hold a comment, so nothing downstream can
    // leak one.
    const context = source('src/lib/orders/maintenance.ts');
    const sweep = context.slice(context.indexOf('export async function sendRatingDigests'));
    const body = sweep.slice(0, sweep.indexOf('export async function runMaintenance'));
    expect(body).not.toMatch(/comment/);
  });

  it('names the worst score when one is poor, and does not when none is', () => {
    const bad = renderNotification(NotificationKind.RATINGS_RECEIVED, {
      ratingCount: 4,
      ratingAverage: 4,
      ratingLowest: 2,
    });
    const good = renderNotification(NotificationKind.RATINGS_RECEIVED, {
      ratingCount: 4,
      ratingAverage: 4.75,
      ratingLowest: 4,
    });
    expect(bad.body).toMatch(/lowest was 2/i);
    expect(good.body).not.toMatch(/lowest/i);
  });

  it('reads properly for a single rating', () => {
    const one = renderNotification(NotificationKind.RATINGS_RECEIVED, {
      ratingCount: 1,
      ratingAverage: 5,
      ratingLowest: 5,
    });
    expect(one.title).toBe('A 5-star rating');
    expect(one.body).toMatch(/1 new rating\b/);
  });

  it('tells a shop’s managers, not everybody working the queue', () => {
    // A review of the cooking is not a thing to push at somebody mid-shift,
    // and it is not theirs to answer.
    const reviews = codeOnly(source('src/lib/ratings/reviews.ts'));
    expect(reviews).toMatch(/roleSatisfies\(member\.role, StoreRole\.MANAGER\)/);
  });

  it('skips a shop with nobody to tell rather than marking it told', () => {
    // A shop whose last manager left should still have its ratings waiting
    // when somebody is given the keys. Marking them told loses them silently.
    const reviews = codeOnly(source('src/lib/ratings/reviews.ts'));
    expect(reviews).toMatch(/if \(recipients\.length === 0\) continue;/);
  });

  it('marks only the half the digest was about', () => {
    // A review that rates the food and the rider is told to two different
    // people at two different times.
    const reviews = codeOnly(source('src/lib/ratings/reviews.ts'));
    expect(reviews).toMatch(/\? \{ storeNotifiedAt: at \}/);
    expect(reviews).toMatch(/: \{ partnerNotifiedAt: at \}/);
  });

  it('cannot send the same summary twice', () => {
    // Keyed on the newest review in the batch, so a retried pass collapses and
    // a later batch is a different key rather than a collision.
    const maintenance = codeOnly(source('src/lib/orders/maintenance.ts'));
    expect(maintenance).toMatch(/dedupeKey: `ratings:\$\{batch\.subject\}/);
    expect(maintenance).toMatch(/reviewIds\[batch\.reviewIds\.length - 1\]/);
  });

  it('leaves a failed batch for the next pass', () => {
    // A rating nobody hears about is a missed message; telling them twice
    // about the same one is worse. So the mark happens after the enqueues.
    const maintenance = source('src/lib/orders/maintenance.ts');
    const sweep = maintenance.slice(maintenance.indexOf('export async function sendRatingDigests'));
    const body = sweep.slice(0, sweep.indexOf('export async function runMaintenance'));
    expect(body.indexOf('markRatingsNotified')).toBeGreaterThan(
      body.indexOf('enqueueNotification'),
    );
    expect(body).toMatch(/reportError/);
  });

  it('is actually wired into the cron pass', () => {
    const maintenance = codeOnly(source('src/lib/orders/maintenance.ts'));
    expect(maintenance).toMatch(/const ratingDigests = await sendRatingDigests\(\)/);
    expect(codeOnly(source('scripts/run-order-maintenance.ts'))).toMatch(
      /ratingDigests\.digests/,
    );
  });
});
