-- =============================================================================
-- Store referral guards
-- =============================================================================
-- The third referral programme, and the one where the attribution is a PERSON'S
-- CLAIM rather than a code somebody typed. A shop does not sign itself up, so
-- nothing in the system can know who introduced whom — an administrator says
-- so, and money follows.
--
-- That shifts what the guards are for. The rider guards protect a payment
-- against a race; these protect a payment against an unattributable assertion.
-- Hence guard 2: an attribution with no actor and no note is a shop being owed
-- money because somebody typed something, and there is no way back from that to
-- a question anybody can answer.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. One programme, ever.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS store_referral_programme_singleton;
CREATE UNIQUE INDEX store_referral_programme_singleton
  ON "StoreReferralProgramme" ((true));

-- -----------------------------------------------------------------------------
-- 2. An attribution names who made it, and why.
--
--    `attributedById` is NOT NULL in the schema, so what this adds is the NOTE:
--    a non-blank reason. The console requires eight characters through
--    `normaliseReason`; the database requires that it is not whitespace, which
--    is the part a script bypassing the console would otherwise skip.
-- -----------------------------------------------------------------------------
ALTER TABLE "StoreReferral"
  DROP CONSTRAINT IF EXISTS store_referral_attribution_is_justified;

ALTER TABLE "StoreReferral"
  ADD CONSTRAINT store_referral_attribution_is_justified CHECK (
    length(btrim("attributionNote")) >= 8
  );

-- -----------------------------------------------------------------------------
-- 3. No shop refers itself.
--
--    The naive version, and here it is the whole of what a constraint can see:
--    two shops owned by the same person is a real thing and not something the
--    database can detect — nor should it refuse it, because a person who opens
--    a second branch and puts it on TARA has genuinely brought a second shop.
--    The caps bound that, and the earnings threshold means the second shop has
--    to trade before anybody is paid.
-- -----------------------------------------------------------------------------
ALTER TABLE "StoreReferral"
  DROP CONSTRAINT IF EXISTS store_referral_not_self;

ALTER TABLE "StoreReferral"
  ADD CONSTRAINT store_referral_not_self CHECK (
    "referrerStoreId" <> "refereeStoreId"
  );

-- -----------------------------------------------------------------------------
-- 4. Money and its timestamp travel together.
--
--    One `rewardedAt` for both sides, as with a rider referral: both are
--    accrued in the same transaction on the same event.
-- -----------------------------------------------------------------------------
ALTER TABLE "StoreReferral"
  DROP CONSTRAINT IF EXISTS store_referral_amounts_have_times;

ALTER TABLE "StoreReferral"
  ADD CONSTRAINT store_referral_amounts_have_times CHECK (
    "referrerRewardCentavos" >= 0
    AND "refereeRewardCentavos" >= 0
    AND (
      ("rewardedAt" IS NULL
        AND "referrerRewardCentavos" = 0
        AND "refereeRewardCentavos" = 0)
      OR ("rewardedAt" IS NOT NULL
        AND "referrerRewardCentavos" + "refereeRewardCentavos" > 0)
    )
  );

-- -----------------------------------------------------------------------------
-- 5. A paid referral names what the new shop had earned.
--
--    The settlement entries carry no order — a bonus arises from the OTHER
--    shop's trading — so this column is the only place a payment can be traced
--    to the thing that earned it. A REWARDED row without it is money owed for
--    a reason nobody can reconstruct.
-- -----------------------------------------------------------------------------
ALTER TABLE "StoreReferral"
  DROP CONSTRAINT IF EXISTS store_referral_reward_names_its_earnings;

ALTER TABLE "StoreReferral"
  ADD CONSTRAINT store_referral_reward_names_its_earnings CHECK (
    "status" <> 'REWARDED'
    OR (
      "qualifyingEarningsCentavos" IS NOT NULL
      AND "qualifyingEarningsCentavos" > 0
      AND "rewardedAt" IS NOT NULL
    )
  );

-- -----------------------------------------------------------------------------
-- 6. A refusal gives its reason.
-- -----------------------------------------------------------------------------
ALTER TABLE "StoreReferral"
  DROP CONSTRAINT IF EXISTS store_referral_refusal_has_a_reason;

ALTER TABLE "StoreReferral"
  ADD CONSTRAINT store_referral_refusal_has_a_reason CHECK (
    "status" <> 'NOT_REWARDED'
    OR length(btrim(coalesce("blockedReason", ''))) > 0
  );

-- -----------------------------------------------------------------------------
-- 7. Attribution is written once and never rewritten.
--
--    Sharper here than for a rider, because there is no code to appeal to. If
--    the three attribution columns could change, the audit row would describe
--    a claim the table no longer makes — and the audit row is the only
--    evidence this programme has.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION store_referral_attribution_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."referrerStoreId" <> OLD."referrerStoreId"
     OR NEW."refereeStoreId" <> OLD."refereeStoreId"
     OR NEW."attributedById" <> OLD."attributedById"
     OR NEW."attributionNote" <> OLD."attributionNote" THEN
    RAISE EXCEPTION
      'StoreReferral attribution is immutable: who brought whom, who said so '
      'and why cannot be changed after the fact. The audit row would then '
      'describe a claim this table no longer makes. Reward columns may be '
      'filled in; these four may not.';
  END IF;

  IF OLD."status" = 'REWARDED'
     AND (NEW."referrerRewardCentavos" <> OLD."referrerRewardCentavos"
          OR NEW."refereeRewardCentavos" <> OLD."refereeRewardCentavos"
          OR NEW."rewardedAt" IS DISTINCT FROM OLD."rewardedAt") THEN
    RAISE EXCEPTION
      'StoreReferral % is already rewarded: changing what it paid would leave '
      'the settlement ledger and this row disagreeing about real money.',
      OLD."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS store_referral_no_reattribution ON "StoreReferral";
CREATE TRIGGER store_referral_no_reattribution
  BEFORE UPDATE ON "StoreReferral"
  FOR EACH ROW EXECUTE FUNCTION store_referral_attribution_is_immutable();

-- -----------------------------------------------------------------------------
-- 8. The programme's own numbers have to be sane.
--
--    `MAX_STORE_REWARD_CENTAVOS` in src/lib/referrals/store-policy.ts asserts
--    the same ceiling. ₱2,000 per side, the same number as a rider's and for
--    the same reason: it sits above anything an operator might legitimately
--    choose, so it guards a decimal point rather than setting policy.
--
--    A live programme needs a positive earnings threshold. Zero would pay for
--    a shop being ADDED — which somebody in the console does by hand, for a
--    shop that may never sell anything.
-- -----------------------------------------------------------------------------
ALTER TABLE "StoreReferralProgramme"
  DROP CONSTRAINT IF EXISTS store_referral_programme_sane;

ALTER TABLE "StoreReferralProgramme"
  ADD CONSTRAINT store_referral_programme_sane CHECK (
    "referrerCentavos" >= 0
    AND "refereeCentavos" >= 0
    AND "referrerCentavos" <= 200000
    AND "refereeCentavos" <= 200000
    AND "qualifyingEarningsCentavos" >= 0
    AND "monthlyRewardCap" >= 0
    AND "lifetimeRewardCap" >= 0
    AND (
      "isActive" = false
      OR (
        "qualifyingEarningsCentavos" >= 1
        AND "monthlyRewardCap" >= 1
        AND "lifetimeRewardCap" >= 1
        AND "monthlyRewardCap" <= "lifetimeRewardCap"
      )
    )
  );
