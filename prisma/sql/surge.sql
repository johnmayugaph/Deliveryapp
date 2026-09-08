-- =============================================================================
-- Surge pricing guards
-- =============================================================================
-- Surge is the one number in this app that a busy market raises on a customer
-- who did nothing but open the app at the wrong moment. So the constraints here
-- are not about internal consistency — they are about what a mistyped row is
-- allowed to cost that customer.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- One ladder per service per city, and one FALLBACK ladder per service.
--
-- `SurgeBand.cityId` is nullable, NULL meaning "any city where this service is
-- live". Postgres treats NULLs as distinct, so `@@unique([serviceType, cityId,
-- minOrdersPerRider])` does not stop two fallback steps at the same threshold —
-- and two steps at one threshold makes which surge applies a coin flip. Same
-- reasoning as `delivery_fee_rule_one_fallback_per_service`; a partial unique
-- index is the fix, and Prisma's schema language cannot express one.
DROP INDEX IF EXISTS surge_band_one_fallback_per_threshold;
CREATE UNIQUE INDEX surge_band_one_fallback_per_threshold
  ON "SurgeBand" ("serviceType", "minOrdersPerRider")
  WHERE "cityId" IS NULL;

-- A step has to be a step, and it has to be small.
--
-- The ₱100 ceiling is deliberately below the ₱250 fee cap the seed ships: a
-- surge larger than the whole fare is not a busy market, it is a decimal point
-- in the wrong place — someone typing "1000" meaning ₱10. The cap cannot know
-- which, so it refuses the row and someone reads the error.
--
-- `minOrdersPerRider > 0` because a step at zero applies when nothing is
-- happening, which is a permanent price rise wearing a surge label.
--
-- `surgeCentavos > 0` because a step that adds nothing is not a step; it is a
-- row that silently swallows the steps below it (band selection takes the
-- highest threshold met, so a zero at 2.0 would cancel a real surge at 1.5).
ALTER TABLE "SurgeBand"
  DROP CONSTRAINT IF EXISTS surge_band_step_sane;

ALTER TABLE "SurgeBand"
  ADD CONSTRAINT surge_band_step_sane CHECK (
    "minOrdersPerRider" > 0
    AND "minOrdersPerRider" <= 100
    AND "surgeCentavos" > 0
    AND "surgeCentavos" <= 10000
    AND length(btrim("label")) > 0
  );

-- A snapshot is a measurement, so its parts have to be measurable.
ALTER TABLE "SurgeSnapshot"
  DROP CONSTRAINT IF EXISTS surge_snapshot_counts_sane;

ALTER TABLE "SurgeSnapshot"
  ADD CONSTRAINT surge_snapshot_counts_sane CHECK (
    "ordersWaiting" >= 0
    AND "ridersAvailable" >= 0
    AND "ratio" >= 0
    AND "surgeCentavos" >= 0
    AND "surgeCentavos" <= 10000
  );

-- The snapshot's surge and its reason travel together.
--
-- `bandLabel` is what the customer is shown next to the charge. A charge with no
-- label is an unexplained fee, and a label with no charge is a screen saying
-- "Busy" over a zero. Neither is allowed to reach anybody: a snapshot either
-- has both or has neither.
ALTER TABLE "SurgeSnapshot"
  DROP CONSTRAINT IF EXISTS surge_snapshot_surge_has_a_reason;

ALTER TABLE "SurgeSnapshot"
  ADD CONSTRAINT surge_snapshot_surge_has_a_reason CHECK (
    ("surgeCentavos" = 0) = ("bandLabel" IS NULL)
  );

-- On the ORDER, too: the charge and its reason travel together.
--
-- Same rule as `surge_snapshot_surge_has_a_reason`, applied where it matters
-- most — the receipt. `surgeLabel` is copied from the band at placement, so a
-- row with money and no name means something wrote a surge without going
-- through the quote, and a row with a name and no money means a receipt that
-- says "Busy" over nothing.
ALTER TABLE "Order"
  DROP CONSTRAINT IF EXISTS order_surge_has_a_reason;

ALTER TABLE "Order"
  ADD CONSTRAINT order_surge_has_a_reason CHECK (
    ("surgeCentavos" = 0) = ("surgeLabel" IS NULL)
  );
