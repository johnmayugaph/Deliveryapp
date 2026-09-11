-- The consolidated store edit form writes one audit row under its own action,
-- rather than borrowing STORE_MEMBERSHIP_CHANGED, so a search for "who moved
-- this shop's address" does not return every staff change as well.
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'STORE_PROFILE_CHANGED';
