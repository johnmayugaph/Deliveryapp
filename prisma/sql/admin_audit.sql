-- =============================================================================
-- Admin audit guards
-- =============================================================================
-- The console's whole claim to being safe is that everything privileged is
-- written down. That claim is worth nothing if the log can be edited by the
-- same person the log is about, so the same treatment the credits ledger gets
-- applies here: append-only at the database level, not just in the code.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The audit trail is APPEND-ONLY.
--    A wrong entry is corrected by a later entry, exactly as a wrong ledger row
--    is corrected by a compensating one.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_audit_is_append_only()
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

  RAISE EXCEPTION
    'AdminAuditEvent is append-only: % is not permitted. Record a corrected event instead. A lawful purge sets tara.allow_purge for one transaction.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_audit_no_update ON "AdminAuditEvent";
CREATE TRIGGER admin_audit_no_update
  BEFORE UPDATE ON "AdminAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION admin_audit_is_append_only();

DROP TRIGGER IF EXISTS admin_audit_no_delete ON "AdminAuditEvent";
CREATE TRIGGER admin_audit_no_delete
  BEFORE DELETE ON "AdminAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION admin_audit_is_append_only();

-- -----------------------------------------------------------------------------
-- 2. Every entry carries a real reason.
--    Not merely NOT NULL: "." satisfies NOT NULL and answers nothing. Eight
--    characters is short enough for "tkt 4821" and long enough to exclude a
--    keystroke somebody used to get past the form.
-- -----------------------------------------------------------------------------
ALTER TABLE "AdminAuditEvent"
  DROP CONSTRAINT IF EXISTS admin_audit_reason_is_substantive;

ALTER TABLE "AdminAuditEvent"
  ADD CONSTRAINT admin_audit_reason_is_substantive CHECK (
    char_length(btrim("reason")) >= 8
  );

-- -----------------------------------------------------------------------------
-- 3. A subject is always identified twice: by id, and by something a person
--    recognises. The label is what makes the log readable after the subject
--    has been renamed or removed.
-- -----------------------------------------------------------------------------
ALTER TABLE "AdminAuditEvent"
  DROP CONSTRAINT IF EXISTS admin_audit_subject_identified;

ALTER TABLE "AdminAuditEvent"
  ADD CONSTRAINT admin_audit_subject_identified CHECK (
    char_length(btrim("subjectType")) > 0
    AND char_length(btrim("subjectId")) > 0
    AND char_length(btrim("subjectLabel")) > 0
  );
