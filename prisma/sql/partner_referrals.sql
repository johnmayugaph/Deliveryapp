-- =============================================================================
-- Partner referral guards
-- =============================================================================
-- The customer programme's guards protect credits: money that can only ever
-- reduce a future bill. These protect something stricter — a partner referral
-- accrues REAL MONEY to what TARA owes a rider, and that balance is what
-- somebody pays out of a bank account on a Friday.
--
-- So every rule here has a sharper version of the same justification. A
-- duplicated credit is discounted food; a duplicated bonus is a transfer.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. One programme, ever.
--
--    Same reason as `referral_programme_singleton`: two rows would make what an
--    invite is worth depend on which one a query read, and the rider's screen
--    and the console would advertise different numbers for the same offer.
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS partner_referral_programme_singleton;
CREATE UNIQUE INDEX partner_referral_programme_singleton
  ON "PartnerReferralProgramme" ((true));

-- -----------------------------------------------------------------------------
-- 2. Nobody refers themselves.
--
--    The naive attack, and the only version a constraint can see. Two accounts
--    held by one person is a different problem, and here the defence is not the
--    caps but the WORK: `qualifyingDeliveries` real deliveries, each of which
--    already paid the rider its own fee. A farmer's second SIM has to go out
--    and do the job.
-- -----------------------------------------------------------------------------
ALTER TABLE "PartnerReferral"
  DROP CONSTRAINT IF EXISTS partner_referral_not_self;

ALTER TABLE "PartnerReferral"
  ADD CONSTRAINT partner_referral_not_self CHECK ("referrerId" <> "refereeId");

-- -----------------------------------------------------------------------------
-- 3. Money and its timestamp travel together.
--
--    One `rewardedAt` covers both sides, because both are accrued in the same
--    transaction on the same event — unlike the customer programme, where the
--    referee is granted at attribution and the referrer much later, and which
--    therefore needs two timestamps.
--
--    A REWARDED row has to have paid somebody: both sides at zero with a
--    timestamp is a row claiming a payment that never happened.
-- -----------------------------------------------------------------------------
ALTER TABLE "PartnerReferral"
  DROP CONSTRAINT IF EXISTS partner_referral_amounts_have_times;

ALTER TABLE "PartnerReferral"
  ADD CONSTRAINT partner_referral_amounts_have_times CHECK (
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
-- 4. A paid referral names the delivery that earned it, and counts it.
--
--    This is the sharper one. The settlement entry carries NO order — a bonus
--    arises from somebody else's delivery, so putting it on the rider's own
--    statement line would be a lie — which means this row is the only place a
--    payment can be traced back to the thing it was for. A REWARDED row
--    without both is a transfer nobody can justify, which is exactly the shape
--    of a fraudulent one.
-- -----------------------------------------------------------------------------
ALTER TABLE "PartnerReferral"
  DROP CONSTRAINT IF EXISTS partner_referral_reward_names_its_delivery;

ALTER TABLE "PartnerReferral"
  ADD CONSTRAINT partner_referral_reward_names_its_delivery CHECK (
    "status" <> 'REWARDED'
    OR (
      "qualifyingOrderId" IS NOT NULL
      AND "qualifyingDeliveryCount" IS NOT NULL
      AND "qualifyingDeliveryCount" > 0
      AND "rewardedAt" IS NOT NULL
    )
  );

-- -----------------------------------------------------------------------------
-- 5. A refusal gives its reason.
--
--    NOT_REWARDED is terminal and the referrer is told about it. Without a
--    reason the message is "you were not paid" with nothing after it, and an
--    operator counting why would have nothing to count.
-- -----------------------------------------------------------------------------
ALTER TABLE "PartnerReferral"
  DROP CONSTRAINT IF EXISTS partner_referral_refusal_has_a_reason;

ALTER TABLE "PartnerReferral"
  ADD CONSTRAINT partner_referral_refusal_has_a_reason CHECK (
    "status" <> 'NOT_REWARDED'
    OR length(btrim(coalesce("blockedReason", ''))) > 0
  );

-- -----------------------------------------------------------------------------
-- 6. Attribution is written once and never rewritten.
--
--    Who invited whom is a record of how a rider arrived. An UPDATE would let a
--    second referrer claim a rider after their twentieth delivery — the whole
--    game — so the three attribution columns are frozen while the reward
--    columns stay writable, which is the only legitimate edit this row needs.
--
--    No `tara.allow_purge` escape hatch: unlike the ledgers, this table's rows
--    are deleted by cascade when a partner is deleted, so a lawful erasure
--    needs no exception here.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION partner_referral_attribution_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."referrerId" <> OLD."referrerId"
     OR NEW."refereeId" <> OLD."refereeId"
     OR NEW."codeUsed" <> OLD."codeUsed" THEN
    RAISE EXCEPTION
      'PartnerReferral attribution is immutable: who invited whom cannot be '
      'changed after the fact. Reward columns may be filled in; these three '
      'may not.';
  END IF;

  -- And a settled referral cannot be re-settled. The write path is idempotent
  -- on the referral id and the settlement ledger refuses a duplicate
  -- idempotency key, so this is the third lock on the same door — the one that
  -- holds against a hand-written UPDATE.
  IF OLD."status" = 'REWARDED'
     AND (NEW."referrerRewardCentavos" <> OLD."referrerRewardCentavos"
          OR NEW."refereeRewardCentavos" <> OLD."refereeRewardCentavos"
          OR NEW."rewardedAt" IS DISTINCT FROM OLD."rewardedAt") THEN
    RAISE EXCEPTION
      'PartnerReferral % is already rewarded: changing what it paid would '
      'leave the settlement ledger and this row disagreeing about real money.',
      OLD."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS partner_referral_no_reattribution ON "PartnerReferral";
CREATE TRIGGER partner_referral_no_reattribution
  BEFORE UPDATE ON "PartnerReferral"
  FOR EACH ROW EXECUTE FUNCTION partner_referral_attribution_is_immutable();

-- -----------------------------------------------------------------------------
-- 7. The programme's own numbers have to be sane.
--
--    Mirrors `referral_programme_sane`, and `MAX_PARTNER_REWARD_CENTAVOS` in
--    src/lib/referrals/partner-policy.ts asserts the same ceiling. ₱2,000 per
--    side rather than the customer programme's ₱500: a rider is worth far more
--    than a customer to a delivery business, and the number that guards a typo
--    should be above what an operator might legitimately choose. It is still a
--    typo guard — a bonus larger than this is a decimal point in the wrong
--    place, and here that is a decimal point in a real payout.
--
--    `qualifyingDeliveries` must be at least one when the programme is on. Zero
--    would pay for creating an account, which is paying for owning a SIM card.
-- -----------------------------------------------------------------------------
ALTER TABLE "PartnerReferralProgramme"
  DROP CONSTRAINT IF EXISTS partner_referral_programme_sane;

ALTER TABLE "PartnerReferralProgramme"
  ADD CONSTRAINT partner_referral_programme_sane CHECK (
    "referrerCentavos" >= 0
    AND "refereeCentavos" >= 0
    AND "referrerCentavos" <= 200000
    AND "refereeCentavos" <= 200000
    AND "qualifyingDeliveries" >= 0
    AND "monthlyRewardCap" >= 0
    AND "lifetimeRewardCap" >= 0
    AND (
      "isActive" = false
      OR (
        "qualifyingDeliveries" >= 1
        AND "monthlyRewardCap" >= 1
        AND "lifetimeRewardCap" >= 1
        AND "monthlyRewardCap" <= "lifetimeRewardCap"
      )
    )
  );
