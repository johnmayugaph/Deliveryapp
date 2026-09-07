-- =============================================================================
-- Review guards
-- =============================================================================
-- A rating is not money, so this file is shorter than the ledger's. But two
-- properties are worth putting where no code path can miss them, because
-- `FleetPartner.ratingAvg` is what dispatch ranking scores on: a review with a
-- nonsense score, or one that rates nothing at all, silently misroutes work
-- rather than failing.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A star is one to five.
--    Checked here as well as in `normaliseStars` because the aggregate is an
--    average: a single stray 0 or 11 does not error anywhere, it just moves the
--    number a shop is judged on.
-- -----------------------------------------------------------------------------
ALTER TABLE "OrderReview" DROP CONSTRAINT IF EXISTS order_review_store_stars_range;
ALTER TABLE "OrderReview" ADD CONSTRAINT order_review_store_stars_range
  CHECK ("storeStars" IS NULL OR ("storeStars" >= 1 AND "storeStars" <= 5));

ALTER TABLE "OrderReview" DROP CONSTRAINT IF EXISTS order_review_partner_stars_range;
ALTER TABLE "OrderReview" ADD CONSTRAINT order_review_partner_stars_range
  CHECK ("partnerStars" IS NULL OR ("partnerStars" >= 1 AND "partnerStars" <= 5));

-- -----------------------------------------------------------------------------
-- 2. A review rates SOMETHING.
--    Both scores are nullable because which ones apply depends on the vertical
--    and on whether anybody was dispatched. Neither being set is a different
--    thing: a row that rates nothing, which would sit in the table looking like
--    feedback and count towards nothing.
--
--    A comment on its own is not a review either — that is a support ticket,
--    and there is a whole screen for those.
-- -----------------------------------------------------------------------------
ALTER TABLE "OrderReview" DROP CONSTRAINT IF EXISTS order_review_rates_something;
ALTER TABLE "OrderReview" ADD CONSTRAINT order_review_rates_something
  CHECK ("storeStars" IS NOT NULL OR "partnerStars" IS NOT NULL);

-- -----------------------------------------------------------------------------
-- 3. A score implying a subject is NOT enforced here, and the reason is worth
--    writing down because the constraint was tried first.
--
--    `storeId` is `ON DELETE SET NULL`, so that removing a shop does not erase
--    the RIDER's half of the same review. A check of the form
--
--        CHECK ("storeStars" IS NULL OR "storeId" IS NOT NULL)
--
--    therefore makes a shop with any review on it undeletable: the cascade
--    nulls the id, the stars stay, and the DELETE fails with a check
--    violation. Verified, not assumed — it is the same shape of mistake as a
--    RESTRICT foreign key blocking the demo purge.
--
--    The invariant is real, but it is a WRITE-time one: `submitReview` sets an
--    id and its score together or neither, and a source-level test asserts it.
--    After a subject is deleted, an orphaned score counts towards nothing —
--    the recompute filters on the id — which is untidy rather than wrong, and
--    much better than a shop that cannot be removed.
-- -----------------------------------------------------------------------------
