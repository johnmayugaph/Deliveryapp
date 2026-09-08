-- =============================================================================
-- Promo code guards
-- =============================================================================
-- A promo code is the only one of the three code-shaped features that is
-- PUBLIC. A referral code belongs to one person; a loyalty balance belongs to
-- one person; a promo code goes on a tarpaulin and into a Facebook group, and
-- a code meant for a hundred people is used by ten thousand within the hour.
--
-- So these constraints are about bounds, not tidiness. The application checks
-- the same rules inside the placement transaction; these make them true for a
-- console session, a migration, or a marketing script somebody writes in a
-- hurry on a Friday.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A percentage code MUST have a ceiling.
--
--    The classic way a campaign becomes a story: 20% off with no cap, and one
--    corporate order for two hundred people costs more than the whole
--    campaign budget. A fixed amount is its own ceiling, and a free-delivery
--    code is bounded by the fee, so this applies only to PERCENTAGE.
-- -----------------------------------------------------------------------------
ALTER TABLE "PromoCode"
  DROP CONSTRAINT IF EXISTS promo_percentage_needs_a_ceiling;

ALTER TABLE "PromoCode"
  ADD CONSTRAINT promo_percentage_needs_a_ceiling CHECK (
    "kind" <> 'PERCENTAGE'
    OR (
      "percentBasisPoints" IS NOT NULL
      AND "percentBasisPoints" > 0
      AND "percentBasisPoints" <= 10000
      AND "maxDiscountCentavos" IS NOT NULL
      AND "maxDiscountCentavos" > 0
    )
  );

-- -----------------------------------------------------------------------------
-- 2. Each kind carries the field it needs, and nothing it does not.
--
--    A FIXED_AMOUNT with a percentage set, or a PERCENTAGE with an amount,
--    is a row where two readers could reasonably disagree about the discount.
-- -----------------------------------------------------------------------------
ALTER TABLE "PromoCode"
  DROP CONSTRAINT IF EXISTS promo_kind_carries_its_own_fields;

ALTER TABLE "PromoCode"
  ADD CONSTRAINT promo_kind_carries_its_own_fields CHECK (
    ("kind" = 'PERCENTAGE' AND "amountCentavos" IS NULL)
    OR (
      "kind" = 'FIXED_AMOUNT'
      AND "percentBasisPoints" IS NULL
      AND "amountCentavos" IS NOT NULL
      AND "amountCentavos" > 0
    )
    OR (
      "kind" = 'FREE_DELIVERY'
      AND "percentBasisPoints" IS NULL
      AND "amountCentavos" IS NULL
    )
  );

-- -----------------------------------------------------------------------------
-- 3. The window has to be a window, and the limits have to be limits.
--
--    `endsAt` after `startsAt`, a per-customer limit of at least one, and
--    nothing negative. A cap of zero on a live code would advertise something
--    that refuses everybody, which is worse than an expired code because it
--    gives no reason.
-- -----------------------------------------------------------------------------
ALTER TABLE "PromoCode"
  DROP CONSTRAINT IF EXISTS promo_bounds_are_sane;

ALTER TABLE "PromoCode"
  ADD CONSTRAINT promo_bounds_are_sane CHECK (
    "endsAt" > "startsAt"
    AND "perCustomerLimit" >= 1
    AND "minimumOrderCentavos" >= 0
    AND ("totalRedemptionLimit" IS NULL OR "totalRedemptionLimit" > 0)
    AND ("budgetCentavos" IS NULL OR "budgetCentavos" > 0)
    AND ("maxDiscountCentavos" IS NULL OR "maxDiscountCentavos" > 0)
    -- A guard against a typo rather than a policy: ₱5,000 off one order is a
    -- decimal point in the wrong place, and this one is public.
    AND ("maxDiscountCentavos" IS NULL OR "maxDiscountCentavos" <= 500000)
    AND ("amountCentavos" IS NULL OR "amountCentavos" <= 500000)
    AND length(btrim("code")) >= 3
    AND length(btrim("label")) > 0
    AND "code" = upper(btrim("code"))
  );

-- -----------------------------------------------------------------------------
-- 4. A budget cannot be smaller than one order's discount.
--
--    Otherwise the first redemption exceeds the whole campaign budget, which
--    means the budget was never a budget — and the failure is silent, because
--    every individual check passes.
-- -----------------------------------------------------------------------------
ALTER TABLE "PromoCode"
  DROP CONSTRAINT IF EXISTS promo_budget_covers_one_order;

ALTER TABLE "PromoCode"
  ADD CONSTRAINT promo_budget_covers_one_order CHECK (
    "budgetCentavos" IS NULL
    OR "budgetCentavos" >= coalesce("maxDiscountCentavos", "amountCentavos", 0)
  );

-- -----------------------------------------------------------------------------
-- 5. A redemption takes something off.
-- -----------------------------------------------------------------------------
ALTER TABLE "PromoRedemption"
  DROP CONSTRAINT IF EXISTS promo_redemption_takes_something_off;

ALTER TABLE "PromoRedemption"
  ADD CONSTRAINT promo_redemption_takes_something_off CHECK (
    "discountCentavos" > 0
  );

-- -----------------------------------------------------------------------------
-- 6. Redemptions are never rewritten.
--
--    What a code took off an order is a fact about that order, and the receipt
--    shows it forever. Allowing an UPDATE would let a campaign's later edit
--    restate what somebody already paid — the same failure the settlement
--    ledger and the rider-earnings fix exist to prevent, arriving through a
--    marketing screen.
--
--    DELETE is allowed WITHOUT the escape hatch here, unlike the four ledgers:
--    `onDelete: Cascade` from Order and User has to keep working for a lawful
--    account erasure, and a redemption is not a financial record in its own
--    right — the money it describes lives on the Order and in settlement.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION promo_redemption_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('tara.allow_purge', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'PromoRedemption is not updatable: what a code took off an order is a fact '
    'about that order. A correction is a credits ADJUSTMENT, not an edit here.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS promo_redemption_no_update ON "PromoRedemption";
CREATE TRIGGER promo_redemption_no_update
  BEFORE UPDATE ON "PromoRedemption"
  FOR EACH ROW EXECUTE FUNCTION promo_redemption_is_immutable();

-- -----------------------------------------------------------------------------
-- 7. One redemption per order — ASSERTED, not duplicated.
--
--    The schema's `@unique` on orderId already does this, and it is what makes
--    consuming a code idempotent under a retried placement. The first draft of
--    this file restated it as a second unique index, which was worse than
--    useless: two indexes on one column cost two writes per redemption and
--    give one failure two possible names, so the error a caller sees depends
--    on which index Postgres happened to check first.
--
--    What is actually worth guarding is the thing the comment claimed to
--    guard: a future migration quietly dropping it. So assert that SOME unique
--    index on ("orderId") exists and fail the guard run if it does not. This
--    writes nothing and costs nothing per row.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
    WHERE t.relname = 'PromoRedemption'
      AND i.indisunique
      AND i.indnatts = 1
      AND a.attname = 'orderId'
  ) THEN
    RAISE EXCEPTION
      'PromoRedemption has no unique index on ("orderId"). Consuming a promo code is only idempotent because of it: without it a retried placement records the use twice and the campaign''s cap is wrong by however many retries happened.';
  END IF;
END $$;
