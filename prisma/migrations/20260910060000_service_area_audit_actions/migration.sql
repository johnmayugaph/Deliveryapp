-- Three audit actions for managing the serving area from the console.
--
-- Hand-written rather than generated. `prisma migrate diff --from-url` against
-- a live database wants to DROP the indexes the SQL guards created, and
-- `migrate dev` needs a TTY this container does not have. Adding a value to a
-- Postgres enum is one statement, so there is nothing here worth generating.
--
-- IF NOT EXISTS so re-running this on a database that already has them is a
-- no-op rather than an error.
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'SERVICE_AREA_CREATED';
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'SERVICE_AREA_CHANGED';
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'DELIVERY_FEE_RULE_CHANGED';
