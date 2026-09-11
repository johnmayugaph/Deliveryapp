-- The price this dish is normally sold at, when it is on sale.
--
-- Display only. Checkout prices every line from `priceCentavos` and always
-- has; nothing in `quoteCheckout` reads this column, which is what makes a
-- struck-through price on the storefront unable to overcharge anybody.
--
-- Nullable with no default and no backfill: a dish that is not on sale has no
-- "was" price, and writing `priceCentavos` into it for every existing row
-- would put a struck-through price identical to the real one on every dish in
-- the country.
--
-- The CHECK is the point of doing this in SQL rather than only in the action.
-- A "was" price at or below the real price is not a discount, it is a claim
-- that the shop is charging more than usual — and a sale price is exactly the
-- kind of number that gets written by an import script one day.
ALTER TABLE "MenuItem" ADD COLUMN "compareAtPriceCentavos" INTEGER;

ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_compareAtPrice_is_higher"
  CHECK ("compareAtPriceCentavos" IS NULL OR "compareAtPriceCentavos" > "priceCentavos");
