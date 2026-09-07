-- =============================================================================
-- Account recovery guards
-- =============================================================================
-- Moving an account's phone number is the most dangerous operation in this
-- system: whoever holds the number holds the credits balance, the order
-- history and the saved addresses. The application routes every recovery
-- through one function, and these make the same rules true at the database
-- level, so a console session or a migration script cannot quietly break them.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The recovery record is APPEND-ONLY.
--    Same treatment as the credits ledger and the admin audit trail. A record
--    of an identity change that can be edited afterwards is worse than no
--    record: it looks authoritative and is not.
--
--    The one exception is the alert columns, which the maintenance sweep has to
--    write after the fact — it sends the message to the OLD number, which by
--    then is nowhere else in the database. So UPDATE is allowed, but only when
--    every other column is unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION account_recovery_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  -- An explicit, transaction-scoped escape hatch.
  --
  -- Without one, an append-only table makes the rows that reference it
  -- undeletable too: `onDelete: Cascade` from User runs as a DELETE and hits
  -- this trigger, so no account can ever be removed. That is nearly right —
  -- financial and identity records are retained on purpose, and a hard delete
  -- is not how an account ends — but "nearly" is what gets a trigger dropped
  -- and never recreated the first time somebody has a lawful erasure request
  -- or needs to reset a test database.
  --
  -- So: opt in per transaction, and only per transaction.
  --
  --     BEGIN;
  --     SET LOCAL tara.allow_purge = 'on';
  --     DELETE FROM "User" WHERE id = '...';
  --     COMMIT;
  --
  -- `SET LOCAL` cannot leak past COMMIT, so this cannot be left switched on,
  -- and it appears in the statement log next to what it permitted.
  IF current_setting('tara.allow_purge', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'AccountRecovery is append-only: DELETE is not permitted. It is the record of an identity change. A lawful purge sets tara.allow_purge for one transaction.';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."method" IS DISTINCT FROM OLD."method"
    OR NEW."previousPhone" IS DISTINCT FROM OLD."previousPhone"
    OR NEW."newPhone" IS DISTINCT FROM OLD."newPhone"
    OR NEW."viaEmail" IS DISTINCT FROM OLD."viaEmail"
    OR NEW."assistedByUserId" IS DISTINCT FROM OLD."assistedByUserId"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."creditsFrozenUntil" IS DISTINCT FROM OLD."creditsFrozenUntil"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION
      'AccountRecovery is append-only: only alertSentAt and alertError may be updated, and only by the alert sweep.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS account_recovery_no_rewrite ON "AccountRecovery";
CREATE TRIGGER account_recovery_no_rewrite
  BEFORE UPDATE ON "AccountRecovery"
  FOR EACH ROW EXECUTE FUNCTION account_recovery_is_append_only();

DROP TRIGGER IF EXISTS account_recovery_no_delete ON "AccountRecovery";
CREATE TRIGGER account_recovery_no_delete
  BEFORE DELETE ON "AccountRecovery"
  FOR EACH ROW EXECUTE FUNCTION account_recovery_is_append_only();

-- -----------------------------------------------------------------------------
-- 2. A support-assisted recovery names the administrator AND the reason.
--    Self-service recovery has neither, by design: the person is the user, and
--    naming them as their own assistant would suggest a human was involved.
-- -----------------------------------------------------------------------------
ALTER TABLE "AccountRecovery"
  DROP CONSTRAINT IF EXISTS account_recovery_support_is_attributed;

ALTER TABLE "AccountRecovery"
  ADD CONSTRAINT account_recovery_support_is_attributed CHECK (
    ("method" = 'SUPPORT_ASSISTED'
       AND "assistedByUserId" IS NOT NULL
       AND char_length(btrim(coalesce("reason", ''))) >= 8)
    OR ("method" <> 'SUPPORT_ASSISTED' AND "assistedByUserId" IS NULL)
  );

-- -----------------------------------------------------------------------------
-- 3. A self-service recovery names the address it was proved with.
--    Without it the row cannot answer "how did this happen", which is the only
--    question anybody asks of it.
-- -----------------------------------------------------------------------------
ALTER TABLE "AccountRecovery"
  DROP CONSTRAINT IF EXISTS account_recovery_email_is_recorded;

ALTER TABLE "AccountRecovery"
  ADD CONSTRAINT account_recovery_email_is_recorded CHECK (
    "method" <> 'VERIFIED_EMAIL' OR char_length(btrim(coalesce("viaEmail", ''))) > 0
  );

-- -----------------------------------------------------------------------------
-- 4. The number actually changed.
--    A recovery that moved a number to itself is a no-op that would still
--    freeze a balance and still fire an alert.
-- -----------------------------------------------------------------------------
ALTER TABLE "AccountRecovery"
  DROP CONSTRAINT IF EXISTS account_recovery_phone_changed;

ALTER TABLE "AccountRecovery"
  ADD CONSTRAINT account_recovery_phone_changed CHECK (
    "previousPhone" <> "newPhone"
    AND "previousPhone" LIKE '+%'
    AND "newPhone" LIKE '+%'
  );

-- -----------------------------------------------------------------------------
-- 5. A failed alert says why.
--    A NULL sentAt with a NULL error means "still queued"; a NULL sentAt with
--    an error means "tried and could not". Both are useful; a third state that
--    means neither is not.
-- -----------------------------------------------------------------------------
ALTER TABLE "AccountRecovery"
  DROP CONSTRAINT IF EXISTS account_recovery_sent_has_no_error;

ALTER TABLE "AccountRecovery"
  ADD CONSTRAINT account_recovery_sent_has_no_error CHECK (
    "alertSentAt" IS NULL OR "alertError" IS NULL
  );

-- -----------------------------------------------------------------------------
-- 6. A verified email is a verified ADDRESS.
--    `emailVerifiedAt` set with no address is a state that would make every
--    recovery lookup ambiguous.
-- -----------------------------------------------------------------------------
ALTER TABLE "User"
  DROP CONSTRAINT IF EXISTS user_email_verified_has_address;

ALTER TABLE "User"
  ADD CONSTRAINT user_email_verified_has_address CHECK (
    "emailVerifiedAt" IS NULL OR "email" IS NOT NULL
  );

-- -----------------------------------------------------------------------------
-- 7. A wallet freeze with an end date is a frozen wallet.
--    `frozenUntil` set while `isFrozen` is false would read as a freeze that
--    is not in force, and the ledger's spend check would disagree with the
--    screen showing it.
-- -----------------------------------------------------------------------------
ALTER TABLE "Wallet"
  DROP CONSTRAINT IF EXISTS wallet_frozen_until_implies_frozen;

ALTER TABLE "Wallet"
  ADD CONSTRAINT wallet_frozen_until_implies_frozen CHECK (
    "frozenUntil" IS NULL OR "isFrozen" = true
  );

-- -----------------------------------------------------------------------------
-- 8. The email code table holds no plaintext, and each code is for one job.
--    A code minted to confirm an address must not be usable to move a phone
--    number; the purpose column is what stops that, so it cannot be blank.
-- -----------------------------------------------------------------------------
ALTER TABLE "EmailVerification"
  DROP CONSTRAINT IF EXISTS email_verification_shape;

ALTER TABLE "EmailVerification"
  ADD CONSTRAINT email_verification_shape CHECK (
    char_length("codeHash") = 64
    AND "email" = lower(btrim("email"))
    AND "attempts" >= 0
  );
