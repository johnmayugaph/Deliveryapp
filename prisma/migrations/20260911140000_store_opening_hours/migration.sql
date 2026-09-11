-- Posted opening hours, as minutes from midnight in Manila time.
--
-- Nullable, and null means "no schedule" — which is how every existing store
-- behaves today, so this migration changes no shop's behaviour on the day it
-- lands.

ALTER TABLE "Store" ADD COLUMN "opensAtMinute"    INTEGER;
ALTER TABLE "Store" ADD COLUMN "closesAtMinute"   INTEGER;
ALTER TABLE "Store" ADD COLUMN "breakStartMinute" INTEGER;
ALTER TABLE "Store" ADD COLUMN "breakEndMinute"   INTEGER;

-- Both halves of a window, or neither. A shop with an opening time and no
-- closing time is a schedule nothing can evaluate, and the application would
-- have to invent an answer for it.
ALTER TABLE "Store" ADD CONSTRAINT "Store_opening_window_is_whole"
  CHECK (("opensAtMinute" IS NULL) = ("closesAtMinute" IS NULL));
ALTER TABLE "Store" ADD CONSTRAINT "Store_break_window_is_whole"
  CHECK (("breakStartMinute" IS NULL) = ("breakEndMinute" IS NULL));

-- Inside a day. 1440 would be midnight tomorrow, which is 0.
ALTER TABLE "Store" ADD CONSTRAINT "Store_opening_minutes_in_range" CHECK (
  ("opensAtMinute"    IS NULL OR ("opensAtMinute"    >= 0 AND "opensAtMinute"    < 1440)) AND
  ("closesAtMinute"   IS NULL OR ("closesAtMinute"   >= 0 AND "closesAtMinute"   < 1440)) AND
  ("breakStartMinute" IS NULL OR ("breakStartMinute" >= 0 AND "breakStartMinute" < 1440)) AND
  ("breakEndMinute"   IS NULL OR ("breakEndMinute"   >= 0 AND "breakEndMinute"   < 1440))
);

-- A break only means something inside a posted window.
ALTER TABLE "Store" ADD CONSTRAINT "Store_break_needs_opening_hours"
  CHECK ("breakStartMinute" IS NULL OR "opensAtMinute" IS NOT NULL);
