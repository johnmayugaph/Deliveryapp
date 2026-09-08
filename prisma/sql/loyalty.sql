-- =============================================================================
-- Loyalty points guards
-- =============================================================================
-- The fourth append-only ledger, and the same reasoning as the first three: the
-- application already routes every points change through one function, and
-- these guards make the same rules true for a console session, a migration, or
-- a future service in another language.
--
-- One thing is specific to points. Redemption is the only place in this app
-- where a CUSTOMER causes credits to come into existence. Referrals need
-- somebody else to sign up and order; a promo needs an administrator. This
-- needs nothing but a tap. So the constraint that matters most is not that the
-- table is tidy — it is that a redemption can never exceed what was earned,
-- which is `loyalty_account_balance_non_negative` plus a serializable read in
-- `loyalty/ledger.ts`.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The ledger is APPEND-ONLY, with the same escape hatch as the other three.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION loyalty_entry_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('tara.allow_purge', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    'LoyaltyEntry is append-only: % is not permitted. Write a compensating ADJUSTED row instead. A lawful purge sets tara.allow_purge for one transaction.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS loyalty_entry_no_update ON "LoyaltyEntry";
CREATE TRIGGER loyalty_entry_no_update
  BEFORE UPDATE ON "LoyaltyEntry"
  FOR EACH ROW EXECUTE FUNCTION loyalty_entry_is_append_only();

DROP TRIGGER IF EXISTS loyalty_entry_no_delete ON "LoyaltyEntry";
CREATE TRIGGER loyalty_entry_no_delete
  BEFORE DELETE ON "LoyaltyEntry"
  FOR EACH ROW EXECUTE FUNCTION loyalty_entry_is_append_only();

-- -----------------------------------------------------------------------------
-- 2. Signs are forced by type, and nothing may be zero.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyEntry"
  DROP CONSTRAINT IF EXISTS loyalty_entry_sign_matches_type;

ALTER TABLE "LoyaltyEntry"
  ADD CONSTRAINT loyalty_entry_sign_matches_type CHECK (
    ("type" = 'EARNED' AND "points" > 0)
    OR ("type" IN ('REDEEMED', 'EXPIRED') AND "points" < 0)
    OR ("type" = 'ADJUSTED' AND "points" <> 0)
  );

-- -----------------------------------------------------------------------------
-- 3. Points come from orders.
--    An EARNED row that cannot name the order it came from is points from
--    nowhere, which is the shape of every invented balance.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyEntry"
  DROP CONSTRAINT IF EXISTS loyalty_entry_earned_needs_order;

ALTER TABLE "LoyaltyEntry"
  ADD CONSTRAINT loyalty_entry_earned_needs_order CHECK (
    "type" <> 'EARNED' OR "relatedOrderId" IS NOT NULL
  );

-- -----------------------------------------------------------------------------
-- 4. Points become money only through the credits ledger.
--    A REDEEMED row names the WalletTransaction it produced. Without this, a
--    redemption could take points and grant nothing — or, worse, appear to
--    have granted something nobody can find.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyEntry"
  DROP CONSTRAINT IF EXISTS loyalty_entry_redeemed_names_its_credit;

ALTER TABLE "LoyaltyEntry"
  ADD CONSTRAINT loyalty_entry_redeemed_names_its_credit CHECK (
    "type" <> 'REDEEMED' OR "walletTransactionId" IS NOT NULL
  );

-- And nothing else may claim one: an EARNED or EXPIRED row pointing at a
-- credits transaction would mean points had been paid out twice.
ALTER TABLE "LoyaltyEntry"
  DROP CONSTRAINT IF EXISTS loyalty_entry_only_redemption_has_credit;

ALTER TABLE "LoyaltyEntry"
  ADD CONSTRAINT loyalty_entry_only_redemption_has_credit CHECK (
    "type" = 'REDEEMED' OR "walletTransactionId" IS NULL
  );

-- -----------------------------------------------------------------------------
-- 5. An ADJUSTED row is always attributable to an administrator.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyEntry"
  DROP CONSTRAINT IF EXISTS loyalty_entry_adjustment_needs_admin;

ALTER TABLE "LoyaltyEntry"
  ADD CONSTRAINT loyalty_entry_adjustment_needs_admin CHECK (
    "type" <> 'ADJUSTED' OR "adminUserId" IS NOT NULL
  );

-- -----------------------------------------------------------------------------
-- 6. Only earned points expire.
--    An expiry date on a redemption or an expiry row is meaningless, and a
--    sweep that read one would double-count.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyEntry"
  DROP CONSTRAINT IF EXISTS loyalty_entry_only_earned_expires;

ALTER TABLE "LoyaltyEntry"
  ADD CONSTRAINT loyalty_entry_only_earned_expires CHECK (
    "type" = 'EARNED' OR "expiresAt" IS NULL
  );

-- -----------------------------------------------------------------------------
-- 7. A points balance can never go negative.
--    This is the one that stops redemption creating credits out of nothing.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyAccount"
  DROP CONSTRAINT IF EXISTS loyalty_account_balance_non_negative;

ALTER TABLE "LoyaltyAccount"
  ADD CONSTRAINT loyalty_account_balance_non_negative CHECK ("pointsBalance" >= 0);

-- -----------------------------------------------------------------------------
-- 8. One programme, ever.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS loyalty_programme_singleton;
CREATE UNIQUE INDEX loyalty_programme_singleton
  ON "LoyaltyProgramme" ((true));

-- -----------------------------------------------------------------------------
-- 9. The programme's own numbers have to be usable.
--
--    A live programme with a zero earn rate or a zero redemption rate would
--    show customers a balance that can never grow or never be spent. And
--    redemption in blocks of zero is a division by zero waiting for its first
--    customer.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyProgramme"
  DROP CONSTRAINT IF EXISTS loyalty_programme_sane;

ALTER TABLE "LoyaltyProgramme"
  ADD CONSTRAINT loyalty_programme_sane CHECK (
    "pointsPerPesoBasisPoints" >= 0
    AND "pointsPerPesoRedeemed" >= 0
    AND "redemptionBlockPoints" >= 0
    AND "expiryMonths" >= 0
    AND "tierWindowMonths" > 0
    -- A guard against a typo, not a policy: a hundred points per peso earned
    -- is a decimal point in the wrong place, and one that multiplies across
    -- every order on the platform.
    AND "pointsPerPesoBasisPoints" <= 1000000
    AND (
      "isActive" = false
      OR (
        "pointsPerPesoBasisPoints" > 0
        AND "pointsPerPesoRedeemed" > 0
        AND "redemptionBlockPoints" > 0
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 10. Tiers have to form a ladder that means something.
-- -----------------------------------------------------------------------------
ALTER TABLE "LoyaltyTier"
  DROP CONSTRAINT IF EXISTS loyalty_tier_sane;

ALTER TABLE "LoyaltyTier"
  ADD CONSTRAINT loyalty_tier_sane CHECK (
    "thresholdPoints" >= 0
    -- Never below 1.0: a tier that earns SLOWER than the base rate is a
    -- punishment for ordering, which cannot be what anybody meant.
    AND "earnMultiplierBasisPoints" >= 10000
    -- And a guard against the same decimal-point typo as above.
    AND "earnMultiplierBasisPoints" <= 100000
    AND length(btrim("name")) > 0
    AND length(btrim("blurb")) > 0
  );
