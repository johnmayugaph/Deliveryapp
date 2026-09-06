-- =============================================================================
-- Credits ledger guards
-- =============================================================================
-- Application code already routes every balance change through
-- recordWalletTransaction() in src/lib/wallet/ledger.ts. These guards make the
-- same rules true at the database level, so a console session, a migration
-- script, or a future service in another language cannot quietly break them.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The ledger is APPEND-ONLY.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wallet_transaction_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'WalletTransaction is append-only: % is not permitted. Write a compensating ADJUSTMENT row instead.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_transaction_no_update ON "WalletTransaction";
CREATE TRIGGER wallet_transaction_no_update
  BEFORE UPDATE ON "WalletTransaction"
  FOR EACH ROW EXECUTE FUNCTION wallet_transaction_is_append_only();

DROP TRIGGER IF EXISTS wallet_transaction_no_delete ON "WalletTransaction";
CREATE TRIGGER wallet_transaction_no_delete
  BEFORE DELETE ON "WalletTransaction"
  FOR EACH ROW EXECUTE FUNCTION wallet_transaction_is_append_only();

-- -----------------------------------------------------------------------------
-- 2. Signs are forced by type.
--    Credits are positive, ORDER_PAYMENT is negative, ADJUSTMENT may be either,
--    and nothing may be zero.
-- -----------------------------------------------------------------------------
ALTER TABLE "WalletTransaction"
  DROP CONSTRAINT IF EXISTS wallet_transaction_sign_matches_type;

ALTER TABLE "WalletTransaction"
  ADD CONSTRAINT wallet_transaction_sign_matches_type CHECK (
    ("type" IN ('PROMO_CREDIT', 'REFUND', 'REFERRAL_BONUS') AND "amountCentavos" > 0)
    OR ("type" = 'ORDER_PAYMENT' AND "amountCentavos" < 0)
    OR ("type" = 'ADJUSTMENT' AND "amountCentavos" <> 0)
  );

-- -----------------------------------------------------------------------------
-- 3. Money leaves a balance only towards an order.
--    ORDER_PAYMENT and REFUND must name the order they belong to. This is the
--    "spendable only on orders in the app" constraint, in the database.
-- -----------------------------------------------------------------------------
ALTER TABLE "WalletTransaction"
  DROP CONSTRAINT IF EXISTS wallet_transaction_order_link_required;

ALTER TABLE "WalletTransaction"
  ADD CONSTRAINT wallet_transaction_order_link_required CHECK (
    "type" NOT IN ('ORDER_PAYMENT', 'REFUND') OR "relatedOrderId" IS NOT NULL
  );

-- -----------------------------------------------------------------------------
-- 4. An ADJUSTMENT is always attributable to an admin.
-- -----------------------------------------------------------------------------
ALTER TABLE "WalletTransaction"
  DROP CONSTRAINT IF EXISTS wallet_transaction_adjustment_needs_admin;

ALTER TABLE "WalletTransaction"
  ADD CONSTRAINT wallet_transaction_adjustment_needs_admin CHECK (
    "type" <> 'ADJUSTMENT' OR "adminUserId" IS NOT NULL
  );

-- -----------------------------------------------------------------------------
-- 5. A balance can never go negative.
-- -----------------------------------------------------------------------------
ALTER TABLE "Wallet"
  DROP CONSTRAINT IF EXISTS wallet_balance_non_negative;

ALTER TABLE "Wallet"
  ADD CONSTRAINT wallet_balance_non_negative CHECK ("balanceCentavos" >= 0);

-- -----------------------------------------------------------------------------
-- 6. Fees and totals are whole, non-negative centavos.
--    Cheap insurance against a float creeping in through a raw query.
-- -----------------------------------------------------------------------------
ALTER TABLE "Order"
  DROP CONSTRAINT IF EXISTS order_amounts_non_negative;

ALTER TABLE "Order"
  ADD CONSTRAINT order_amounts_non_negative CHECK (
    "subtotalCentavos" >= 0
    AND "deliveryFeeCentavos" >= 0
    AND "serviceFeeCentavos" >= 0
    AND "smallOrderFeeCentavos" >= 0
    AND "surgeCentavos" >= 0
    AND "tipCentavos" >= 0
    AND "promoDiscountCentavos" >= 0
    AND "subscriptionDiscountCentavos" >= 0
    AND "walletCreditAppliedCentavos" >= 0
    AND "totalCentavos" >= 0
  );
