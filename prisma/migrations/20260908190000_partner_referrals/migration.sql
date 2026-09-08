-- AlterEnum
ALTER TYPE "SettlementEntryType" ADD VALUE 'REFERRAL_BONUS';

-- DropForeignKey
ALTER TABLE "Referral" DROP CONSTRAINT "Referral_fleetPartnerId_fkey";

-- AlterTable
ALTER TABLE "Referral" DROP COLUMN "fleetPartnerId";

-- CreateTable
CREATE TABLE "PartnerReferralProgramme" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "referrerCentavos" INTEGER NOT NULL DEFAULT 0,
    "refereeCentavos" INTEGER NOT NULL DEFAULT 0,
    "qualifyingDeliveries" INTEGER NOT NULL DEFAULT 0,
    "monthlyRewardCap" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRewardCap" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerReferralProgramme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerReferral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "codeUsed" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'ATTRIBUTED',
    "referrerRewardCentavos" INTEGER NOT NULL DEFAULT 0,
    "refereeRewardCentavos" INTEGER NOT NULL DEFAULT 0,
    "rewardedAt" TIMESTAMP(3),
    "qualifyingOrderId" TEXT,
    "qualifyingDeliveryCount" INTEGER,
    "blockedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerReferral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerReferral_refereeId_key" ON "PartnerReferral"("refereeId");

-- CreateIndex
CREATE INDEX "PartnerReferral_referrerId_status_idx" ON "PartnerReferral"("referrerId", "status");

-- CreateIndex
CREATE INDEX "PartnerReferral_status_createdAt_idx" ON "PartnerReferral"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "PartnerReferral" ADD CONSTRAINT "PartnerReferral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerReferral" ADD CONSTRAINT "PartnerReferral_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerReferral" ADD CONSTRAINT "PartnerReferral_qualifyingOrderId_fkey" FOREIGN KEY ("qualifyingOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

