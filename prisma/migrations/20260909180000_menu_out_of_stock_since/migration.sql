-- When the shop marked this dish out of stock, cleared when it comes back.
--
-- Nullable with no default and no backfill: existing out-of-stock rows have no
-- honest answer for when they went out, and inventing `now()` for them would
-- say every one of them went out at deploy time. The screen reads a null as
-- "we do not know when", which is true.
ALTER TABLE "MenuItem" ADD COLUMN "outOfStockSince" TIMESTAMP(3);
