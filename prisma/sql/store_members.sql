-- =============================================================================
-- Store staff guards
-- =============================================================================
-- One invariant, and it is the one that would otherwise need a database edit to
-- repair: A STORE ALWAYS HAS AT LEAST ONE OWNER.
--
-- Lose the last owner and the store is stranded. Nobody can invite staff,
-- nobody can change the menu, nobody can hand ownership on — and the only way
-- back is somebody with psql. The application enforces this in
-- `lib/merchant/staff.ts`, but the whole point of putting it here as well is
-- that this cannot be forgotten by a future code path, a console action, or a
-- hand-written UPDATE at 2am.
--
-- Run after `prisma migrate deploy`:
--     npm run prisma:guards
-- =============================================================================

CREATE OR REPLACE FUNCTION store_keeps_an_owner()
RETURNS TRIGGER AS $$
DECLARE
  affected_store TEXT;
  owner_count INTEGER;
BEGIN
  -- The same explicit, transaction-scoped escape hatch the ledger and the
  -- audit log use. `npm run db:purge-demo` and `npm run db:purge-user` remove
  -- accounts, which cascades to their memberships, and a purge is a lawful
  -- reason to leave a store without an owner on the way to deleting it.
  --
  --     BEGIN;
  --     SET LOCAL tara.allow_purge = 'on';
  --     DELETE FROM "User" WHERE id = '...';
  --     COMMIT;
  --
  -- `SET LOCAL` cannot outlive the transaction, so it cannot be left on.
  IF current_setting('tara.allow_purge', true) = 'on' THEN
    RETURN NULL;
  END IF;

  affected_store := COALESCE(OLD."storeId", NEW."storeId");

  -- The store may be on its way out itself. Deleting a Store cascades to its
  -- members, and complaining that a store being deleted has no owner would
  -- make stores undeletable.
  IF NOT EXISTS (SELECT 1 FROM "Store" WHERE id = affected_store) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO owner_count
  FROM "StoreMember"
  WHERE "storeId" = affected_store AND role = 'OWNER';

  IF owner_count = 0 THEN
    RAISE EXCEPTION
      'Store % would be left with no OWNER. Promote somebody else first, or delete the store. (A lawful purge sets tara.allow_purge for one transaction.)',
      affected_store
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- DEFERRABLE INITIALLY DEFERRED, which is what makes handing ownership over
-- possible at all: promoting the new owner and demoting the old one are two
-- statements, and a non-deferred check would reject whichever order they were
-- written in. Deferred, the pair is judged once, at COMMIT, on the end state.
DROP TRIGGER IF EXISTS store_member_keeps_an_owner ON "StoreMember";
CREATE CONSTRAINT TRIGGER store_member_keeps_an_owner
  AFTER UPDATE OR DELETE ON "StoreMember"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION store_keeps_an_owner();

-- Note what is NOT guarded here: INSERT. A store's FIRST member is created
-- before it can possibly have an owner — by the seed, or by the console
-- bootstrapping a new partner store — and a store with no members at all is a
-- store nobody has been given yet rather than a stranded one.
