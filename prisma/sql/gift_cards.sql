-- =============================================================================
-- Gift card guards
-- =============================================================================
-- A gift card is the first BEARER instrument in this app: the string is worth
-- money to whoever holds it. Application code in src/lib/gift-cards/ already
-- enforces all of this; these guards make the same rules true at the database
-- level, so a console session, a migration script, or a future service in
-- another language cannot quietly break them.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A redemption is ALL or NOTHING.
--
--    `redeemedAt` set and no ledger row means credits nobody can account for;
--    a ledger row with no `redeemedAt` means a card that can be redeemed
--    twice. Both halves, or neither.
--
--    Deliberately does NOT mention `redeemedById`. Purging an account nulls
--    that column (onDelete: SetNull) while the redemption remains a fact, so
--    including it would make this constraint fire during a lawful erasure —
--    and a guard that blocks the thing it was never meant to block is a guard
--    somebody drops.
-- -----------------------------------------------------------------------------
ALTER TABLE "GiftCard"
  DROP CONSTRAINT IF EXISTS gift_card_redemption_is_complete;

ALTER TABLE "GiftCard"
  ADD CONSTRAINT gift_card_redemption_is_complete CHECK (
    ("redeemedAt" IS NULL) = ("walletTransactionId" IS NULL)
  );

-- -----------------------------------------------------------------------------
-- 2. A card cannot be both redeemed and void.
--
--    Voiding exists to cancel a card BEFORE anybody uses it. Once the credits
--    are in somebody's balance there is nothing left to cancel — the money is
--    spendable, and taking it back is a signed ADJUSTMENT with a reason, not a
--    flag on a different table.
-- -----------------------------------------------------------------------------
ALTER TABLE "GiftCard"
  DROP CONSTRAINT IF EXISTS gift_card_not_redeemed_and_void;

ALTER TABLE "GiftCard"
  ADD CONSTRAINT gift_card_not_redeemed_and_void CHECK (
    "redeemedAt" IS NULL OR "voidedAt" IS NULL
  );

-- -----------------------------------------------------------------------------
-- 3. Voiding names its reason.
--    Cancelling money owed to somebody is a decision, and a decision with no
--    reason is indistinguishable from a mistake.
-- -----------------------------------------------------------------------------
ALTER TABLE "GiftCard"
  DROP CONSTRAINT IF EXISTS gift_card_void_has_a_reason;

ALTER TABLE "GiftCard"
  ADD CONSTRAINT gift_card_void_has_a_reason CHECK (
    ("voidedAt" IS NULL) = ("voidReason" IS NULL)
  );

-- -----------------------------------------------------------------------------
-- 4. The face value is a sane, whole, positive amount.
--
--    ₱5,000 is the ceiling for one card. Not because a larger gift is
--    unthinkable, but because a single bearer instrument worth more than that
--    is almost always a decimal point in the wrong place — and the recovery
--    from issuing one is finding whoever holds the paper. Issue several, or
--    use a signed adjustment against a known account.
-- -----------------------------------------------------------------------------
ALTER TABLE "GiftCard"
  DROP CONSTRAINT IF EXISTS gift_card_amount_is_sane;

ALTER TABLE "GiftCard"
  ADD CONSTRAINT gift_card_amount_is_sane CHECK (
    "amountCentavos" > 0 AND "amountCentavos" <= 500000
  );

-- -----------------------------------------------------------------------------
-- 5. An expiry is in the future of the issue, and a reason is not blank.
-- -----------------------------------------------------------------------------
ALTER TABLE "GiftCard"
  DROP CONSTRAINT IF EXISTS gift_card_terms_are_sane;

ALTER TABLE "GiftCard"
  ADD CONSTRAINT gift_card_terms_are_sane CHECK (
    ("expiresAt" IS NULL OR "expiresAt" > "createdAt")
    AND btrim("issuedReason") <> ''
    AND btrim("reference") <> ''
    AND length("codeHash") = 64
  );

-- -----------------------------------------------------------------------------
-- 6. The TERMS are immutable, and an outcome cannot be rewritten.
--
--    This is the guard that matters most, and it is the one an application
--    bug is most likely to need. Three separate promises:
--
--      * `codeHash`, `amountCentavos` and `issuedById` never change. A card
--        whose value can be edited after it is printed is not a gift card, it
--        is a suggestion — and rewriting the hash would let somebody point an
--        issued card at a code of their own choosing.
--
--      * once `redeemedAt` is set, it and its ledger reference are frozen.
--        This is what makes DOUBLE REDEMPTION impossible in the database and
--        not merely unlikely in the application. The redeem path uses a
--        compare-and-set (`WHERE "redeemedAt" IS NULL`) so two concurrent
--        taps cannot both win; this is the backstop for the day somebody
--        writes a third redeem path and forgets.
--
--      * once `voidedAt` is set, the void is frozen too. Un-voiding a card
--        would put a cancelled instrument back into circulation.
--
--    `updatedAt` and the *ById columns are free to change — the latter
--    because a lawful purge nulls them.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gift_card_terms_are_immutable()
RETURNS TRIGGER AS $$
BEGIN
  -- The same transaction-scoped escape hatch as the ledgers. A lawful erasure
  -- request has to be able to null the *ById columns, and a test database has
  -- to be resettable.
  --
  --     BEGIN;
  --     SET LOCAL tara.allow_purge = 'on';
  --     ...
  --     COMMIT;
  IF current_setting('tara.allow_purge', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW."codeHash" <> OLD."codeHash" THEN
    RAISE EXCEPTION
      'GiftCard.codeHash is immutable: repointing an issued card at a different code is indistinguishable from forging one.';
  END IF;

  IF NEW."amountCentavos" <> OLD."amountCentavos" THEN
    RAISE EXCEPTION
      'GiftCard.amountCentavos is immutable: % was issued at % centavos and somebody may be holding it on paper. Void it and issue another.',
      OLD."reference", OLD."amountCentavos";
  END IF;

  IF NEW."issuedById" IS DISTINCT FROM OLD."issuedById"
     AND OLD."issuedById" IS NOT NULL
     AND NEW."issuedById" IS NOT NULL THEN
    RAISE EXCEPTION
      'GiftCard.issuedById is immutable: who gave the money away is not editable.';
  END IF;

  IF OLD."redeemedAt" IS NOT NULL
     AND (NEW."redeemedAt" IS DISTINCT FROM OLD."redeemedAt"
          OR NEW."walletTransactionId" IS DISTINCT FROM OLD."walletTransactionId") THEN
    RAISE EXCEPTION
      'GiftCard % is already redeemed: a second redemption would credit the same money twice. This is the database backstop for the compare-and-set in redeemGiftCard().',
      OLD."reference";
  END IF;

  IF OLD."voidedAt" IS NOT NULL
     AND (NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt"
          OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason") THEN
    RAISE EXCEPTION
      'GiftCard % is already void: un-voiding it would put a cancelled instrument back into circulation.',
      OLD."reference";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gift_card_no_rewrite ON "GiftCard";
CREATE TRIGGER gift_card_no_rewrite
  BEFORE UPDATE ON "GiftCard"
  FOR EACH ROW EXECUTE FUNCTION gift_card_terms_are_immutable();

-- -----------------------------------------------------------------------------
-- 7. One card per ledger row — ASSERTED, not duplicated.
--
--    The schema's `@unique` on walletTransactionId already does this, and it
--    is the other half of what makes redemption idempotent: the ledger row is
--    keyed `gift-card:<id>`, so a retry replays rather than credits again, and
--    this index means two cards can never claim the same row.
--
--    Asserted rather than restated as a second index — the promo work learned
--    that two unique indexes on one column cost two writes per row and give
--    one failure two possible names.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
    WHERE t.relname = 'GiftCard'
      AND i.indisunique
      AND i.indnatts = 1
      AND a.attname = 'walletTransactionId'
  ) THEN
    RAISE EXCEPTION
      'GiftCard has no unique index on ("walletTransactionId"). Without it two cards can name the same credits row, which is one gift card''s money counted as two.';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 8. The plaintext code is nowhere in this table.
--
--    Not a constraint Postgres can express, so it is asserted instead: the
--    only code-shaped column is a 64-character hex hash (checked in guard 5),
--    and there is no column that could hold the code itself. If somebody adds
--    one, this fails and they have to read the comment.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(column_name, ', ')
    INTO offending
  FROM information_schema.columns
  WHERE table_name = 'GiftCard'
    AND column_name IN ('code', 'plainCode', 'codePlain', 'secret', 'token');

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'GiftCard has a column that looks like it holds the code in plaintext (%). A gift card is a bearer instrument: a leaked backup would be drainable. Store only the hash — see GiftCard.codeHash.',
      offending;
  END IF;
END $$;
