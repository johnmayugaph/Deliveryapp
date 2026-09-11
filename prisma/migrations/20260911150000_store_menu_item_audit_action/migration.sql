-- The console can now put a dish on a shop's menu. Its own action, so a search
-- for "who added this dish" does not return every store edit as well.
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'STORE_MENU_ITEM_ADDED';
