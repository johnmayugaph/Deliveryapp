-- =============================================================================
-- Loyalty tier benefit guards
-- =============================================================================
-- A tier benefit is a row whose meaningful columns depend on its `type`, which
-- is the shape a check constraint exists for. `SubscriptionBenefit` has the
-- same shape and no such guard — `isBenefitUsable` skips a misconfigured row at
-- checkout rather than refusing it at write time, which is right for a live
-- pricing path and wrong for the row itself: a FREE_DELIVERY benefit with no
-- minimum is silently inert, and nothing tells the operator who created it.
--
-- So these guards refuse the row. The difference in posture is deliberate: the
-- checkout still skips anything unusable (a guard applied to an existing
-- database cannot retroactively fix rows), but nothing new can be written
-- inert.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A benefit carries the columns its own type needs, and no others.
--
--    The "and no others" half matters as much as the first. A DISPATCH_PRIORITY
--    row with a `percentBasisPoints` set is a row somebody edited from one type
--    to another and left a stale column on; the next reader cannot tell whether
--    the percentage means anything. Mirrors `isTierBenefitUsable` and
--    `TIER_BENEFIT_COLUMNS` in src/lib/loyalty/tier-benefits.ts, and a test
--    asserts the two agree.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyTierBenefit"
  DROP CONSTRAINT IF EXISTS loyalty_tier_benefit_columns_match_type;

ALTER TABLE "LoyaltyTierBenefit"
  ADD CONSTRAINT loyalty_tier_benefit_columns_match_type CHECK (
    CASE "type"
      WHEN 'FREE_DELIVERY' THEN
        "minimumOrderCentavos" IS NOT NULL
        AND "percentBasisPoints" IS NULL
        AND "maxDiscountCentavos" IS NULL
        AND "monthlyCeilingCentavos" IS NULL
        AND "priorityWeight" IS NULL
      WHEN 'DISCOUNT_PERCENT' THEN
        "percentBasisPoints" IS NOT NULL
        AND "percentBasisPoints" > 0
        AND "minimumOrderCentavos" IS NULL
        AND "monthlyUsageCap" IS NULL
        AND "monthlyCeilingCentavos" IS NULL
        AND "priorityWeight" IS NULL
      WHEN 'CREDIT_BACK_PERCENT' THEN
        "percentBasisPoints" IS NOT NULL
        AND "percentBasisPoints" > 0
        AND "minimumOrderCentavos" IS NULL
        AND "monthlyUsageCap" IS NULL
        AND "maxDiscountCentavos" IS NULL
        AND "priorityWeight" IS NULL
      WHEN 'DISPATCH_PRIORITY' THEN
        "priorityWeight" IS NOT NULL
        AND "priorityWeight" >= 1
        AND "percentBasisPoints" IS NULL
        AND "minimumOrderCentavos" IS NULL
        AND "monthlyUsageCap" IS NULL
        AND "maxDiscountCentavos" IS NULL
        AND "monthlyCeilingCentavos" IS NULL
      WHEN 'SUPPORT_PRIORITY' THEN
        "priorityWeight" IS NOT NULL
        AND "priorityWeight" >= 1
        AND "percentBasisPoints" IS NULL
        AND "minimumOrderCentavos" IS NULL
        AND "monthlyUsageCap" IS NULL
        AND "maxDiscountCentavos" IS NULL
        AND "monthlyCeilingCentavos" IS NULL
      WHEN 'POINTS_NEVER_EXPIRE' THEN
        "percentBasisPoints" IS NULL
        AND "minimumOrderCentavos" IS NULL
        AND "monthlyUsageCap" IS NULL
        AND "maxDiscountCentavos" IS NULL
        AND "monthlyCeilingCentavos" IS NULL
        AND "priorityWeight" IS NULL
      ELSE false
    END
  );

-- -----------------------------------------------------------------------------
-- 2. The numbers are in range.
--
--    A percentage above 100% is a bill that pays the customer; a priority
--    weight in the thousands is a suki whose order is always first however
--    long anybody else has waited. `MAX_TIER_PRIORITY_WEIGHT` and
--    `MAX_TIER_PERCENT_BASIS_POINTS` in tier-benefits.ts assert the same two
--    ceilings, and a test asserts they agree with these.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyTierBenefit"
  DROP CONSTRAINT IF EXISTS loyalty_tier_benefit_sane;

ALTER TABLE "LoyaltyTierBenefit"
  ADD CONSTRAINT loyalty_tier_benefit_sane CHECK (
    ("percentBasisPoints" IS NULL OR "percentBasisPoints" <= 5000)
    AND ("minimumOrderCentavos" IS NULL OR "minimumOrderCentavos" >= 0)
    AND ("monthlyUsageCap" IS NULL OR "monthlyUsageCap" >= 1)
    AND ("maxDiscountCentavos" IS NULL OR "maxDiscountCentavos" >= 1)
    AND ("monthlyCeilingCentavos" IS NULL OR "monthlyCeilingCentavos" >= 1)
    AND ("priorityWeight" IS NULL OR "priorityWeight" <= 100)
    AND length(btrim("displayLabel")) >= 3
  );

-- -----------------------------------------------------------------------------
-- 3. One benefit of a type per tier.
--
--    Two FREE_DELIVERY rows on Tapat is not "two free deliveries" — the
--    pricing engine takes the first that applies and breaks, so the second is
--    a row an operator created, can see on the screen, and which does
--    nothing. Two DISCOUNT_PERCENT rows, by contrast, WOULD both apply and
--    stack into a discount nobody meant to configure.
--
--    Service scoping is the reason this is not obviously right: a 10% discount
--    on FOOD and another on MART are two rows of the same type. They are also
--    a thing to do with one row and an empty `serviceKeys`, or with two tiers;
--    refusing them keeps every tier's benefit list readable, and readable is
--    what stops somebody double-configuring a giveaway.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS loyalty_tier_benefit_one_per_type;
CREATE UNIQUE INDEX loyalty_tier_benefit_one_per_type
  ON "LoyaltyTierBenefit" ("tierId", "type");

-- -----------------------------------------------------------------------------
-- 4. An applied-benefit line names exactly one source.
--
--    Both ids are nullable so a receipt survives the benefit row being
--    deleted, which means "both null" is a legal END STATE. What must never
--    happen is a line pointing at BOTH, or a line whose `source` disagrees
--    with the id it carries — either would make the receipt's own account of
--    where a discount came from unreliable, which is the whole reason the
--    column exists.
-- -----------------------------------------------------------------------------
ALTER TABLE "OrderAppliedBenefit"
  DROP CONSTRAINT IF EXISTS order_applied_benefit_names_one_source;

ALTER TABLE "OrderAppliedBenefit"
  ADD CONSTRAINT order_applied_benefit_names_one_source CHECK (
    NOT ("benefitId" IS NOT NULL AND "tierBenefitId" IS NOT NULL)
    AND ("source" <> 'SUBSCRIPTION' OR "tierBenefitId" IS NULL)
    AND ("source" <> 'LOYALTY_TIER' OR "benefitId" IS NULL)
  );

-- -----------------------------------------------------------------------------
-- 5. Usage counts only ever go up, and never below zero.
--
--    The same posture as the settlement ledger: a monthly allowance that can
--    be edited downwards is an allowance somebody can refill by hand. The
--    trigger allows the ordinary increment and refuses a decrement, with the
--    transaction-scoped `tara.allow_purge` escape hatch the erasure tools use.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyBenefitUsage"
  DROP CONSTRAINT IF EXISTS loyalty_benefit_usage_non_negative;

ALTER TABLE "LoyaltyBenefitUsage"
  ADD CONSTRAINT loyalty_benefit_usage_non_negative CHECK (
    "usageCount" >= 0
    AND "creditedCentavos" >= 0
    AND "discountedCentavos" >= 0
  );

CREATE OR REPLACE FUNCTION loyalty_benefit_usage_only_grows()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('tara.allow_purge', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW."usageCount" < OLD."usageCount"
     OR NEW."creditedCentavos" < OLD."creditedCentavos"
     OR NEW."discountedCentavos" < OLD."discountedCentavos" THEN
    RAISE EXCEPTION
      'LoyaltyBenefitUsage % may only grow: a monthly allowance that can be '
      'wound back is one somebody can refill by hand, which is the same '
      'mistake as editing a ledger balance.',
      OLD."id";
  END IF;

  IF NEW."userId" <> OLD."userId"
     OR NEW."tierBenefitId" <> OLD."tierBenefitId"
     OR NEW."periodStart" <> OLD."periodStart" THEN
    RAISE EXCEPTION
      'LoyaltyBenefitUsage % is keyed by who, which benefit and which month: '
      'moving a row between them would move somebody else''s allowance.',
      OLD."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS loyalty_benefit_usage_no_rollback ON "LoyaltyBenefitUsage";
CREATE TRIGGER loyalty_benefit_usage_no_rollback
  BEFORE UPDATE ON "LoyaltyBenefitUsage"
  FOR EACH ROW EXECUTE FUNCTION loyalty_benefit_usage_only_grows();
