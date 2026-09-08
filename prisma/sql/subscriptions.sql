-- =============================================================================
-- Subscription guards
-- =============================================================================
-- Two invariants the schema language cannot state.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- One live subscription per person.
--
-- THREE statuses are live. ACTIVE is the paid-up case. PAST_DUE is one whose
-- renewal has not been paid. PENDING_PAYMENT is one whose FIRST period has not
-- been paid — it confers nothing, but it still occupies the slot, because
-- somebody with an unpaid enrolment starting a second one is how you end up
-- with two bills and two rows competing to supply benefits.
--
-- CANCELLED and EXPIRED rows are history and may accumulate freely, which is
-- why this is a partial index.
DROP INDEX IF EXISTS user_subscription_one_live_per_user;
CREATE UNIQUE INDEX user_subscription_one_live_per_user
  ON "UserSubscription" ("userId")
  WHERE "status" IN ('PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE');

-- A grant needs a grantor.
--
-- COMPED and PROMOTIONAL subscriptions are money we choose not to collect. A
-- row with no `grantedByUserId` is an unattributable decision, and those are how
-- a comp list grows until nobody can say who is on it or why.
ALTER TABLE "UserSubscription"
  DROP CONSTRAINT IF EXISTS user_subscription_grant_has_grantor;

ALTER TABLE "UserSubscription"
  ADD CONSTRAINT user_subscription_grant_has_grantor CHECK (
    "origin" = 'PAID' OR "grantedByUserId" IS NOT NULL
  );

-- A subscription that has ended says when.
--
-- The live statuses are exempt; everything else has to name the moment. Kept
-- in step with the partial index above — a status that is live for one and
-- terminal for the other would make an enrolment unsavable.
ALTER TABLE "UserSubscription"
  DROP CONSTRAINT IF EXISTS user_subscription_ended_when_terminal;

ALTER TABLE "UserSubscription"
  ADD CONSTRAINT user_subscription_ended_when_terminal CHECK (
    "status" IN ('PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE') OR "endedAt" IS NOT NULL
  );

-- A PAID subscription is never a grant, and a grant is never billed.
--
-- The existing grant-has-a-grantor check says a non-PAID subscription names
-- who gave it. This says the converse: a PAID one must NOT, because a
-- subscription that is both billed and comped is one nobody can answer
-- questions about — and because the invoice sweep decides what to bill from
-- `origin` alone.
ALTER TABLE "UserSubscription"
  DROP CONSTRAINT IF EXISTS user_subscription_paid_is_not_granted;

ALTER TABLE "UserSubscription"
  ADD CONSTRAINT user_subscription_paid_is_not_granted CHECK (
    "origin" <> 'PAID' OR "grantedByUserId" IS NULL
  );

-- Only a PAID subscription can be waiting for a first payment.
--
-- A comp that sat in PENDING_PAYMENT would confer nothing and never be
-- billed, so it would be a grant that silently does not exist.
ALTER TABLE "UserSubscription"
  DROP CONSTRAINT IF EXISTS user_subscription_only_paid_awaits_payment;

ALTER TABLE "UserSubscription"
  ADD CONSTRAINT user_subscription_only_paid_awaits_payment CHECK (
    "status" <> 'PENDING_PAYMENT' OR "origin" = 'PAID'
  );

-- Benefit usage is never negative, and a usage row cannot claim to have
-- credited money it did not.
ALTER TABLE "SubscriptionBenefitUsage"
  DROP CONSTRAINT IF EXISTS subscription_benefit_usage_non_negative;

ALTER TABLE "SubscriptionBenefitUsage"
  ADD CONSTRAINT subscription_benefit_usage_non_negative CHECK (
    "usageCount" >= 0
    AND "creditedCentavos" >= 0
    AND "discountedCentavos" >= 0
  );
