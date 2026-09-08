-- =============================================================================
-- Settlement ledger guards
-- =============================================================================
-- The third ledger, and the third set of these. Application code routes every
-- entry through recordSettlementEntry() in src/lib/settlement/ledger.ts; these
-- make the same rules true at the database level, so a console session or a
-- future service in another language cannot quietly break them.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The settlement ledger is APPEND-ONLY.
--    A payout that was recorded cannot be edited into not having happened. A
--    mistake is corrected with a compensating ADJUSTMENT, so the history keeps
--    saying what somebody claimed and when.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION settlement_entry_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  -- The same transaction-scoped escape hatch the other two ledgers have, for
  -- the same reason: without it `onDelete` cascades make a store or a partner
  -- undeletable and no test database can be reset. `SET LOCAL` cannot leak
  -- past COMMIT.
  IF current_setting('tara.allow_purge', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    'SettlementEntry is append-only: % is not permitted. Write a compensating ADJUSTMENT row instead. A lawful purge sets tara.allow_purge for one transaction.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS settlement_entry_no_update ON "SettlementEntry";
CREATE TRIGGER settlement_entry_no_update
  BEFORE UPDATE ON "SettlementEntry"
  FOR EACH ROW EXECUTE FUNCTION settlement_entry_is_append_only();

DROP TRIGGER IF EXISTS settlement_entry_no_delete ON "SettlementEntry";
CREATE TRIGGER settlement_entry_no_delete
  BEFORE DELETE ON "SettlementEntry"
  FOR EACH ROW EXECUTE FUNCTION settlement_entry_is_append_only();

-- -----------------------------------------------------------------------------
-- 2. Exactly one party, and it agrees with the `party` column.
--
--    A row that names both a store and a rider, or neither, is a row nobody
--    can settle. And a row whose `party` says STORE while carrying a
--    fleetPartnerId would net into the wrong person's balance — which is the
--    kind of error that surfaces as somebody being underpaid.
-- -----------------------------------------------------------------------------
ALTER TABLE "SettlementEntry"
  DROP CONSTRAINT IF EXISTS settlement_entry_exactly_one_party;

ALTER TABLE "SettlementEntry"
  ADD CONSTRAINT settlement_entry_exactly_one_party CHECK (
    ("party" = 'STORE' AND "storeId" IS NOT NULL AND "fleetPartnerId" IS NULL)
    OR ("party" = 'FLEET_PARTNER' AND "fleetPartnerId" IS NOT NULL AND "storeId" IS NULL)
  );

-- -----------------------------------------------------------------------------
-- 3. Signs are forced by type.
--    Must agree with ENTRY_DIRECTION in src/lib/settlement/policy.ts. A
--    balance here is what TARA owes the partner: earnings and remittances
--    increase it, cash they collected and payouts we sent decrease it, and an
--    adjustment may go either way but never nowhere.
-- -----------------------------------------------------------------------------
ALTER TABLE "SettlementEntry"
  DROP CONSTRAINT IF EXISTS settlement_entry_sign_matches_type;

ALTER TABLE "SettlementEntry"
  ADD CONSTRAINT settlement_entry_sign_matches_type CHECK (
    ("type" IN ('ORDER_EARNINGS', 'CASH_REMITTED') AND "amountCentavos" > 0)
    OR ("type" IN ('CASH_COLLECTED', 'PAYOUT_SENT') AND "amountCentavos" < 0)
    OR ("type" = 'ADJUSTMENT' AND "amountCentavos" <> 0)
  );

-- -----------------------------------------------------------------------------
-- 4. Money that moved in the real world names a reference.
--
--    A payout, a remittance and an adjustment are all a PERSON asserting that
--    something happened outside this system. Nothing here can send money, so
--    the reference is the only thing that makes the claim checkable against a
--    bank statement later. Accruals need none: the order is the reference.
-- -----------------------------------------------------------------------------
ALTER TABLE "SettlementEntry"
  DROP CONSTRAINT IF EXISTS settlement_entry_reference_required;

ALTER TABLE "SettlementEntry"
  ADD CONSTRAINT settlement_entry_reference_required CHECK (
    "type" NOT IN ('PAYOUT_SENT', 'CASH_REMITTED', 'ADJUSTMENT')
    OR ("reference" IS NOT NULL AND length(btrim("reference")) >= 3)
  );

-- -----------------------------------------------------------------------------
-- 5. A human's claim is attributable.
--    Accruals are written by the system on completion and have no actor. Every
--    other type is somebody's decision and must carry their id.
-- -----------------------------------------------------------------------------
ALTER TABLE "SettlementEntry"
  DROP CONSTRAINT IF EXISTS settlement_entry_actor_required;

ALTER TABLE "SettlementEntry"
  ADD CONSTRAINT settlement_entry_actor_required CHECK (
    "type" IN ('ORDER_EARNINGS', 'CASH_COLLECTED')
    OR "actorUserId" IS NOT NULL
  );

-- -----------------------------------------------------------------------------
-- 6. An accrual names the order it came from.
--    Earnings and collected cash arise FROM an order; a payout settles many at
--    once and names none.
-- -----------------------------------------------------------------------------
ALTER TABLE "SettlementEntry"
  DROP CONSTRAINT IF EXISTS settlement_entry_accrual_needs_order;

ALTER TABLE "SettlementEntry"
  ADD CONSTRAINT settlement_entry_accrual_needs_order CHECK (
    "type" NOT IN ('ORDER_EARNINGS', 'CASH_COLLECTED') OR "orderId" IS NOT NULL
  );

-- -----------------------------------------------------------------------------
-- 7. Commission is a rate, not a number somebody typed wrong.
--    Basis points, so 10000 would be the whole subtotal. Capped well below
--    that: a commission over half the food is not a deal, it is a typo.
-- -----------------------------------------------------------------------------
ALTER TABLE "Store"
  DROP CONSTRAINT IF EXISTS store_commission_in_range;

ALTER TABLE "Store"
  ADD CONSTRAINT store_commission_in_range CHECK (
    "commissionBasisPoints" >= 0 AND "commissionBasisPoints" <= 5000
  );
