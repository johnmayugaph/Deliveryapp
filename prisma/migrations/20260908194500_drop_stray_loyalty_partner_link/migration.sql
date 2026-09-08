-- DropForeignKey
ALTER TABLE "LoyaltyEntry" DROP CONSTRAINT "LoyaltyEntry_fleetPartnerId_fkey";

-- AlterTable
ALTER TABLE "LoyaltyEntry" DROP COLUMN "fleetPartnerId";

