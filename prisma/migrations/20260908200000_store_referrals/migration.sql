-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAction" ADD VALUE 'STORE_REFERRAL_PROGRAMME_CHANGED';
ALTER TYPE "AdminAction" ADD VALUE 'STORE_REFERRAL_ATTRIBUTED';

-- CreateTable
CREATE TABLE "StoreReferralProgramme" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "referrerCentavos" INTEGER NOT NULL DEFAULT 0,
    "refereeCentavos" INTEGER NOT NULL DEFAULT 0,
    "qualifyingEarningsCentavos" INTEGER NOT NULL DEFAULT 0,
    "monthlyRewardCap" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRewardCap" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreReferralProgramme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreReferral" (
    "id" TEXT NOT NULL,
    "referrerStoreId" TEXT NOT NULL,
    "refereeStoreId" TEXT NOT NULL,
    "attributedById" TEXT NOT NULL,
    "attributionNote" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'ATTRIBUTED',
    "referrerRewardCentavos" INTEGER NOT NULL DEFAULT 0,
    "refereeRewardCentavos" INTEGER NOT NULL DEFAULT 0,
    "rewardedAt" TIMESTAMP(3),
    "qualifyingEarningsCentavos" INTEGER,
    "blockedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreReferral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreReferral_refereeStoreId_key" ON "StoreReferral"("refereeStoreId");

-- CreateIndex
CREATE INDEX "StoreReferral_referrerStoreId_status_idx" ON "StoreReferral"("referrerStoreId", "status");

-- CreateIndex
CREATE INDEX "StoreReferral_status_createdAt_idx" ON "StoreReferral"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "StoreReferral" ADD CONSTRAINT "StoreReferral_referrerStoreId_fkey" FOREIGN KEY ("referrerStoreId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreReferral" ADD CONSTRAINT "StoreReferral_refereeStoreId_fkey" FOREIGN KEY ("refereeStoreId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreReferral" ADD CONSTRAINT "StoreReferral_attributedById_fkey" FOREIGN KEY ("attributedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

