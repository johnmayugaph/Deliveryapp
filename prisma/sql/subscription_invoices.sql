-- =============================================================================
-- Subscription invoice guards
-- =============================================================================
-- An invoice is a claim on somebody's money, so the rules that keep it honest
-- are here as well as in src/lib/subscriptions/. Application code cannot be
-- the only thing standing between a price change and a rewritten bill.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A settlement is ALL or NOTHING.
--
--    `settledAt` with no rail means money nobody can trace; a rail with no
--    `settledAt` means an invoice that still reads as outstanding while
--    somebody's payment sits against it.
--
--    It also demands a `settledReference`, which the first version of this
--    guard did not — found by a guard exercise that inserted a settled row
--    with no reference and watched the database accept it. A settled month
--    with nothing to point at cannot be reconciled against a statement, and
--    reconciliation is the entire reason this rail is auditable at all: the
--    money arrives in somebody's e-wallet and a person says it did. The
--    console already refuses to confirm without one; this is the backstop.
--
--    Deliberately does NOT mention `settledById`. It is NULL for a provider
--    settlement, and a lawful purge nulls it (onDelete: SetNull) while the
--    settlement remains a fact — so including it would make this constraint
--    fire during an erasure request, which is how a guard gets dropped.
-- -----------------------------------------------------------------------------
ALTER TABLE "SubscriptionInvoice"
  DROP CONSTRAINT IF EXISTS subscription_invoice_settlement_is_complete;

ALTER TABLE "SubscriptionInvoice"
  ADD CONSTRAINT subscription_invoice_settlement_is_complete CHECK (
    ("settledAt" IS NULL) = ("settledVia" IS NULL)
    AND ("settledAt" IS NULL OR btrim(coalesce("settledReference", '')) <> '')
  );

-- -----------------------------------------------------------------------------
-- 2. An invoice cannot be both settled and void.
--
--    Voiding exists to cancel a bill nobody has paid. Once the money has
--    arrived there is nothing left to cancel, and taking it back is a refund —
--    which this app does not have a rail for, and will not fake with a flag.
-- -----------------------------------------------------------------------------
ALTER TABLE "SubscriptionInvoice"
  DROP CONSTRAINT IF EXISTS subscription_invoice_not_settled_and_void;

ALTER TABLE "SubscriptionInvoice"
  ADD CONSTRAINT subscription_invoice_not_settled_and_void CHECK (
    "settledAt" IS NULL OR "voidedAt" IS NULL
  );

-- -----------------------------------------------------------------------------
-- 3. Voiding names its reason, and so does a failed attempt.
-- -----------------------------------------------------------------------------
ALTER TABLE "SubscriptionInvoice"
  DROP CONSTRAINT IF EXISTS subscription_invoice_void_has_a_reason;

ALTER TABLE "SubscriptionInvoice"
  ADD CONSTRAINT subscription_invoice_void_has_a_reason CHECK (
    ("voidedAt" IS NULL) = ("voidReason" IS NULL)
  );

-- -----------------------------------------------------------------------------
-- 4. A customer's claim is all-or-nothing too.
--    "They say they sent it" and "when they said so" are one fact.
-- -----------------------------------------------------------------------------
ALTER TABLE "SubscriptionInvoice"
  DROP CONSTRAINT IF EXISTS subscription_invoice_submission_is_complete;

ALTER TABLE "SubscriptionInvoice"
  ADD CONSTRAINT subscription_invoice_submission_is_complete CHECK (
    ("submittedAt" IS NULL) = ("submittedReference" IS NULL)
  );

-- -----------------------------------------------------------------------------
-- 5. The amount and the dates are sane.
--
--    ₱5,000 a month is the ceiling for a plan fee. Not because a more
--    expensive product is unthinkable, but because this one is a delivery
--    subscription in the Philippines, and a monthly fee above that is a
--    decimal point in the wrong place — one that would go out as a bill to
--    every subscriber at once.
-- -----------------------------------------------------------------------------
ALTER TABLE "SubscriptionInvoice"
  DROP CONSTRAINT IF EXISTS subscription_invoice_terms_are_sane;

ALTER TABLE "SubscriptionInvoice"
  ADD CONSTRAINT subscription_invoice_terms_are_sane CHECK (
    "amountCentavos" > 0
    AND "amountCentavos" <= 500000
    AND "periodEnd" > "periodStart"
    AND "dueAt" >= "issuedAt"
    AND "attemptCount" >= 0
    AND btrim("reference") <> ''
  );

-- -----------------------------------------------------------------------------
-- 6. The same guard on the PLAN, since the invoice copies from it.
--
--    An invoice's amount is checked above, but it is copied from
--    `SubscriptionPlan.monthlyPriceCentavos` — so a mistyped plan price would
--    fail at issue time, in a cron, for every subscriber, rather than at the
--    moment somebody typed it. Better to refuse the typo.
--
--    Zero is allowed: a free tier is a legitimate thing to model. What is
--    refused is enrolling somebody PAID on one, which the application does
--    with a sentence, because a ₱0 bill is not a bill.
-- -----------------------------------------------------------------------------
ALTER TABLE "SubscriptionPlan"
  DROP CONSTRAINT IF EXISTS subscription_plan_price_is_sane;

ALTER TABLE "SubscriptionPlan"
  ADD CONSTRAINT subscription_plan_price_is_sane CHECK (
    "monthlyPriceCentavos" >= 0 AND "monthlyPriceCentavos" <= 500000
  );

-- -----------------------------------------------------------------------------
-- 7. The TERMS are immutable, and an outcome cannot be rewritten.
--
--    This is the guard the whole table exists for. A bill that can be edited
--    after it is sent is not a bill, and the specific temptation is real: the
--    day somebody raises the plan price, the obvious-looking fix for "the
--    outstanding invoices show the old amount" is to update them.
--
--    Three promises:
--
--      * `amountCentavos`, `periodStart`, `periodEnd`, `subscriptionId` and
--        `reference` never change. Whoever was quoted ₱99 for September owes
--        ₱99 for September.
--      * once `settledAt` is set, it and its rail are frozen. This is what
--        makes DOUBLE SETTLEMENT impossible in the database rather than merely
--        unlikely in the application — the confirm path compare-and-sets on
--        `settledAt IS NULL`, and this is the backstop for the day somebody
--        writes a second confirm path.
--      * once `voidedAt` is set, the void is frozen. Un-voiding would put a
--        cancelled bill back in front of a customer.
--
--    `attemptCount`, the submission columns and `updatedAt` are free to move —
--    they are the parts that legitimately change while a bill is chased.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION subscription_invoice_terms_are_immutable()
RETURNS TRIGGER AS $$
BEGIN
  -- The same transaction-scoped escape hatch as the ledgers, for a lawful
  -- erasure and for resetting a test database.
  IF current_setting('tara.allow_purge', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW."amountCentavos" <> OLD."amountCentavos" THEN
    RAISE EXCEPTION
      'SubscriptionInvoice.amountCentavos is immutable: % was issued for % centavos and the customer was quoted that. Raising the plan price changes future invoices, not this one. Void it and issue another if it was wrong.',
      OLD."reference", OLD."amountCentavos";
  END IF;

  IF NEW."periodStart" <> OLD."periodStart" OR NEW."periodEnd" <> OLD."periodEnd" THEN
    RAISE EXCEPTION
      'SubscriptionInvoice period is immutable: % bills a named month, and moving it would change what was bought after it was sold.',
      OLD."reference";
  END IF;

  IF NEW."subscriptionId" <> OLD."subscriptionId" OR NEW."reference" <> OLD."reference" THEN
    RAISE EXCEPTION
      'SubscriptionInvoice identity is immutable: repointing a bill at a different subscription is indistinguishable from inventing one.';
  END IF;

  IF OLD."settledAt" IS NOT NULL
     AND (NEW."settledAt" IS DISTINCT FROM OLD."settledAt"
          OR NEW."settledVia" IS DISTINCT FROM OLD."settledVia") THEN
    RAISE EXCEPTION
      'SubscriptionInvoice % is already settled: a second settlement would take the same month''s money twice. This is the database backstop for the compare-and-set in settleInvoice().',
      OLD."reference";
  END IF;

  IF OLD."voidedAt" IS NOT NULL
     AND (NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
          OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason") THEN
    RAISE EXCEPTION
      'SubscriptionInvoice % is already void: un-voiding it would put a cancelled bill back in front of a customer.',
      OLD."reference";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS subscription_invoice_no_rewrite ON "SubscriptionInvoice";
CREATE TRIGGER subscription_invoice_no_rewrite
  BEFORE UPDATE ON "SubscriptionInvoice"
  FOR EACH ROW EXECUTE FUNCTION subscription_invoice_terms_are_immutable();

-- -----------------------------------------------------------------------------
-- 8. One invoice per period — ASSERTED, not duplicated.
--
--    The schema's `@@unique([subscriptionId, periodStart])` already does this,
--    and it is what makes the issuing sweep safe to run every minute: a second
--    pass finds the row already there rather than raising a duplicate bill.
--
--    Asserted rather than restated as a second index, for the reason the promo
--    work learned: two unique indexes on one thing cost two writes per row and
--    give one failure two possible names.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE t.relname = 'SubscriptionInvoice'
      AND i.indisunique
      AND i.indnatts = 2
      -- Two casts, both of which this assertion needed and neither of which
      -- is obvious. `indkey` is an int2vector, so `= ANY` over it silently
      -- matches nothing without `::int2[]`. And `attname` is a `name`, so
      -- `array_agg` of it yields `name[]`, which does not compare equal to a
      -- `text[]` literal. The first version had neither, so it fired against
      -- a database that DID have the index — a guard failing for its own bug
      -- rather than for the thing it guards, which is the most useless kind.
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM pg_attribute a
        WHERE a.attrelid = t.oid AND a.attnum = ANY(i.indkey::int2[])
      ) = ARRAY['periodStart', 'subscriptionId']
  ) THEN
    RAISE EXCEPTION
      'SubscriptionInvoice has no unique index on ("subscriptionId", "periodStart"). Without it the issuing sweep bills the same month again on every run.';
  END IF;
END $$;
