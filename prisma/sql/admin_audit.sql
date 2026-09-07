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
  RAISE EXCEPTION
    'AdminAuditEvent is append-only: % is not permitted. Record a corrected event instead.',
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
