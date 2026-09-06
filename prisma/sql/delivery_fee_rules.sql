-- =============================================================================
-- Delivery fee rule guards
-- =============================================================================
-- `DeliveryFeeRule.cityId` is nullable, where NULL means "the fallback rule for
-- this service in any city". Postgres treats NULLs as distinct, so the
-- `@@unique([serviceType, cityId])` constraint does NOT prevent two fallback
-- rows for the same service — and two fallbacks would make which rate applies
-- a coin flip.
--
-- A partial unique index fixes it. Prisma's schema language cannot express one,
-- which is why it lives here alongside the ledger guards.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- One fallback rule per service.
DROP INDEX IF EXISTS delivery_fee_rule_one_fallback_per_service;
CREATE UNIQUE INDEX delivery_fee_rule_one_fallback_per_service
  ON "DeliveryFeeRule" ("serviceType")
  WHERE "cityId" IS NULL;

-- Rates must be sane: no negative money, and a ceiling above its floor.
ALTER TABLE "DeliveryFeeRule"
  DROP CONSTRAINT IF EXISTS delivery_fee_rule_amounts_sane;

ALTER TABLE "DeliveryFeeRule"
  ADD CONSTRAINT delivery_fee_rule_amounts_sane CHECK (
    "baseFeeCentavos" >= 0
    AND "includedMeters" >= 0
    AND "perKilometreCentavos" >= 0
    AND "minimumFeeCentavos" >= 0
    AND "smallOrderFeeCentavos" >= 0
    AND "serviceFeeCentavos" >= 0
    AND ("maximumFeeCentavos" IS NULL OR "maximumFeeCentavos" >= "minimumFeeCentavos")
    AND ("freeAboveSubtotalCentavos" IS NULL OR "freeAboveSubtotalCentavos" > 0)
    AND ("smallOrderThresholdCentavos" IS NULL OR "smallOrderThresholdCentavos" > 0)
  );
