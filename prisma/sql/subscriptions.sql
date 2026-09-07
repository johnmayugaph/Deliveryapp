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
-- ACTIVE and PAST_DUE are both live: a PAST_DUE subscription is one whose
-- renewal has not been paid, and enrolling again while it stands would leave
-- two rows competing to supply benefits. CANCELLED and EXPIRED rows are history
-- and may accumulate freely, which is why this is a partial index.
DROP INDEX IF EXISTS user_subscription_one_live_per_user;
CREATE UNIQUE INDEX user_subscription_one_live_per_user
  ON "UserSubscription" ("userId")
  WHERE "status" IN ('ACTIVE', 'PAST_DUE');

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
ALTER TABLE "UserSubscription"
  DROP CONSTRAINT IF EXISTS user_subscription_ended_when_terminal;

ALTER TABLE "UserSubscription"
  ADD CONSTRAINT user_subscription_ended_when_terminal CHECK (
    "status" IN ('ACTIVE', 'PAST_DUE') OR "endedAt" IS NOT NULL
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
