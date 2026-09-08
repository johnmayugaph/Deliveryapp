-- =============================================================================
-- Payment ledger guards
-- =============================================================================
-- The credits ledger's guards, applied to the other ledger. Application code
-- routes every payment event through recordPaymentEvent() in
-- src/lib/payments/events.ts; these make the same rules true at the database
-- level, so a console session or a future service in another language cannot
-- quietly break them.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The payment ledger is APPEND-ONLY.
--    Money that moved cannot be edited into not having moved. A mistake is
--    corrected by a compensating row — a refund, or a refusal after a
--    confirmation — so the history keeps saying what happened.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION payment_event_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  -- The same transaction-scoped escape hatch the credits ledger has, for the
  -- same reason: without it, `onDelete: Cascade` from Order makes an order
  -- undeletable and no test database can be reset. `SET LOCAL` cannot leak
  -- past COMMIT.
  --
  --     BEGIN;
  --     SET LOCAL tara.allow_purge = 'on';
  --     DELETE FROM "Order" WHERE id = '...';
  --     COMMIT;
  IF current_setting('tara.allow_purge', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    'PaymentEvent is append-only: % is not permitted. Write a compensating row instead. A lawful purge sets tara.allow_purge for one transaction.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_event_no_update ON "PaymentEvent";
CREATE TRIGGER payment_event_no_update
  BEFORE UPDATE ON "PaymentEvent"
  FOR EACH ROW EXECUTE FUNCTION payment_event_is_append_only();

DROP TRIGGER IF EXISTS payment_event_no_delete ON "PaymentEvent";
CREATE TRIGGER payment_event_no_delete
  BEFORE DELETE ON "PaymentEvent"
  FOR EACH ROW EXECUTE FUNCTION payment_event_is_append_only();

-- -----------------------------------------------------------------------------
-- 2. Signs are forced by type.
--    Must agree with EVENT_DIRECTION in src/lib/payments/policy.ts. Money in
--    is positive, money out negative, and an event that records intent rather
--    than movement carries nothing at all.
-- -----------------------------------------------------------------------------
ALTER TABLE "PaymentEvent"
  DROP CONSTRAINT IF EXISTS payment_event_sign_matches_type;

ALTER TABLE "PaymentEvent"
  ADD CONSTRAINT payment_event_sign_matches_type CHECK (
    ("type" IN ('CHARGE_CONFIRMED', 'CASH_COLLECTED') AND "amountCentavos" > 0)
    OR ("type" = 'REFUND_ISSUED' AND "amountCentavos" < 0)
    OR (
      "type" IN ('CHARGE_REQUESTED', 'CHARGE_SUBMITTED', 'CHARGE_REFUSED', 'CHARGE_EXPIRED')
      AND "amountCentavos" = 0
    )
  );

-- -----------------------------------------------------------------------------
-- 3. A refusal and a refund must say why.
--    Both are visible to the customer, and either without a reason is
--    unanswerable — they cannot tell whether to try again or complain.
-- -----------------------------------------------------------------------------
ALTER TABLE "PaymentEvent"
  DROP CONSTRAINT IF EXISTS payment_event_reason_required;

ALTER TABLE "PaymentEvent"
  ADD CONSTRAINT payment_event_reason_required CHECK (
    "type" NOT IN ('CHARGE_REFUSED', 'REFUND_ISSUED')
    OR ("note" IS NOT NULL AND length(btrim("note")) >= 3)
  );

-- -----------------------------------------------------------------------------
-- 4. Real money never lands in the credits ledger.
--
--    This is the no-top-up rule, in the database, and it is the one guard here
--    worth the most. A refund of a MANUAL_TRANSFER or of cash goes back to the
--    instrument it came from; if it were instead written as a credits REFUND
--    row, a customer could pay us ₱500, cancel, and hold ₱500 of spendable
--    balance. That is a top-up, which this product does not have.
--
--    Enforced by looking at the order: a credits REFUND row may only exist for
--    an order that actually spent credits. An order paid by transfer has no
--    ORDER_PAYMENT row, so a REFUND against it has nothing to return and is
--    rejected.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wallet_refund_needs_credits_spent()
RETURNS TRIGGER AS $$
DECLARE
  spent integer;
BEGIN
  IF NEW."type" <> 'REFUND' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(SUM("amountCentavos"), 0)
    INTO spent
    FROM "WalletTransaction"
   WHERE "relatedOrderId" = NEW."relatedOrderId"
     AND "type" = 'ORDER_PAYMENT';

  -- ORDER_PAYMENT rows are negative, so anything spent makes this < 0.
  IF spent >= 0 THEN
    RAISE EXCEPTION
      'Refusing to credit order %: it never spent credits, so a credits REFUND would be turning real money into spendable balance. Refund it to its source instead.',
      NEW."relatedOrderId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_refund_requires_credits_spent ON "WalletTransaction";
CREATE TRIGGER wallet_refund_requires_credits_spent
  BEFORE INSERT ON "WalletTransaction"
  FOR EACH ROW EXECUTE FUNCTION wallet_refund_needs_credits_spent();

-- -----------------------------------------------------------------------------
-- 5. A confirmation is idempotent by construction.
--    Prisma already makes `idempotencyKey` unique; this states the intent next
--    to the rest of the rules. A provider retrying a webhook and an admin
--    double-tapping Confirm are the same event twice, and the second must
--    bounce rather than charge again.
-- -----------------------------------------------------------------------------
