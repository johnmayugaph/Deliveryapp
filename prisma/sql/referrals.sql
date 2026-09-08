-- =============================================================================
-- Referral guards
-- =============================================================================
-- Referrals are the ONLY path by which credits come into existence at the
-- invitation of a user. Every other grant is caused by an order completing or
-- by an administrator acting with a reason. That makes this the one place where
-- a stranger with a drawer of SIM cards can make credits appear, so the
-- constraints below are not internal tidiness — they are the boundary of that.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- One programme, ever.
--
-- Two rows would make what a referral is worth depend on which one a query
-- happened to read, and the two screens that read it — the customer's invite
-- page and the console — would disagree about the same offer.
DROP INDEX IF EXISTS referral_programme_singleton;
CREATE UNIQUE INDEX referral_programme_singleton
  ON "ReferralProgramme" ((true));

-- Nobody refers themselves.
--
-- The first thing anybody tries, and the only version of it this constraint can
-- see: one account using its own code. Two accounts held by one person is a
-- different problem, and the caps rather than a CHECK are what bound it — see
-- `monthlyRewardCap`.
ALTER TABLE "Referral"
  DROP CONSTRAINT IF EXISTS referral_not_self;

ALTER TABLE "Referral"
  ADD CONSTRAINT referral_not_self CHECK ("referrerId" <> "refereeId");

-- Money and its timestamp travel together, in both directions.
--
-- The same rule as the surge label and its charge: an amount with no time
-- means nobody can say when it was paid, and a time with no amount is a row
-- claiming a payment that never happened. Either both or neither.
ALTER TABLE "Referral"
  DROP CONSTRAINT IF EXISTS referral_amounts_have_times;

ALTER TABLE "Referral"
  ADD CONSTRAINT referral_amounts_have_times CHECK (
    ("refereeGrantedCentavos" = 0) = ("refereeGrantedAt" IS NULL)
    AND ("referrerRewardCentavos" = 0) = ("referrerRewardedAt" IS NULL)
    AND "refereeGrantedCentavos" >= 0
    AND "referrerRewardCentavos" >= 0
  );

-- A paid referral names the order that earned it.
--
-- The referrer is paid because a real order completed. A REWARDED row with no
-- `qualifyingOrderId` is a payment nobody can trace to the thing it was for,
-- which is exactly the shape of a fraudulent one.
ALTER TABLE "Referral"
  DROP CONSTRAINT IF EXISTS referral_reward_names_its_order;

ALTER TABLE "Referral"
  ADD CONSTRAINT referral_reward_names_its_order CHECK (
    "status" <> 'REWARDED'
    OR ("qualifyingOrderId" IS NOT NULL AND "referrerRewardedAt" IS NOT NULL)
  );

-- A refusal gives its reason.
--
-- NOT_REWARDED is a terminal state, and one the referrer is told about. Without
-- a reason the message would be "you were not paid" with nothing after it, and
-- an operator counting why would have nothing to count.
ALTER TABLE "Referral"
  DROP CONSTRAINT IF EXISTS referral_refusal_has_a_reason;

ALTER TABLE "Referral"
  ADD CONSTRAINT referral_refusal_has_a_reason CHECK (
    "status" <> 'NOT_REWARDED' OR length(btrim(coalesce("blockedReason", ''))) > 0
  );

-- Attribution is written once and never rewritten.
--
-- The referrer, the referee and the code are a record of how somebody arrived.
-- Allowing an UPDATE would let a second referrer claim an account after its
-- first order completed, which is the whole game — so the trigger refuses to
-- let those three columns change while allowing the reward columns to be
-- filled in, which is the only legitimate edit this row ever needs.
CREATE OR REPLACE FUNCTION referral_attribution_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."referrerId" <> OLD."referrerId"
     OR NEW."refereeId" <> OLD."refereeId"
     OR NEW."codeUsed" <> OLD."codeUsed" THEN
    RAISE EXCEPTION
      'Referral attribution is immutable: who invited whom cannot be changed '
      'after the fact. Reward columns may be filled in; these three may not.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS referral_no_reattribution ON "Referral";
CREATE TRIGGER referral_no_reattribution
  BEFORE UPDATE ON "Referral"
  FOR EACH ROW EXECUTE FUNCTION referral_attribution_is_immutable();

-- The programme's own numbers have to be sane.
--
-- The ₱500 ceiling per side is a guard against a typo, not a policy: a referral
-- worth more than a large order is a decimal point in the wrong place, and a
-- typo here is a liability against every account on the platform at once. The
-- caps must be positive when the programme is on, because a cap of zero with
-- the programme active would advertise a code that can never pay.
ALTER TABLE "ReferralProgramme"
  DROP CONSTRAINT IF EXISTS referral_programme_sane;

ALTER TABLE "ReferralProgramme"
  ADD CONSTRAINT referral_programme_sane CHECK (
    "refereeCentavos" >= 0
    AND "referrerCentavos" >= 0
    AND "refereeCentavos" <= 50000
    AND "referrerCentavos" <= 50000
    AND "minimumOrderCentavos" >= 0
    AND "monthlyRewardCap" >= 0
    AND "lifetimeRewardCap" >= 0
    AND ("lifetimeRewardCap" = 0 OR "lifetimeRewardCap" >= "monthlyRewardCap")
    AND (
      "isActive" = false
      OR ("monthlyRewardCap" > 0 AND "lifetimeRewardCap" > 0)
    )
  );
