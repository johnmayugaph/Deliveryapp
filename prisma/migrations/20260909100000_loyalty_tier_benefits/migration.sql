-- CreateEnum
CREATE TYPE "TierBenefitType" AS ENUM ('FREE_DELIVERY', 'DISCOUNT_PERCENT', 'CREDIT_BACK_PERCENT', 'DISPATCH_PRIORITY', 'SUPPORT_PRIORITY', 'POINTS_NEVER_EXPIRE');

-- CreateEnum
CREATE TYPE "BenefitSource" AS ENUM ('SUBSCRIPTION', 'LOYALTY_TIER');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "loyaltyDiscountCentavos" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderAppliedBenefit" ADD COLUMN     "source" "BenefitSource" NOT NULL DEFAULT 'SUBSCRIPTION',
ADD COLUMN     "tierBenefitId" TEXT;

-- CreateTable
CREATE TABLE "LoyaltyTierBenefit" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "type" "TierBenefitType" NOT NULL,
    "serviceKeys" "ServiceKey"[] DEFAULT ARRAY[]::"ServiceKey"[],
    "percentBasisPoints" INTEGER,
    "minimumOrderCentavos" INTEGER,
    "monthlyUsageCap" INTEGER,
    "maxDiscountCentavos" INTEGER,
    "monthlyCeilingCentavos" INTEGER,
    "priorityWeight" INTEGER,
    "displayLabel" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyTierBenefit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyBenefitUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tierBenefitId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "creditedCentavos" INTEGER NOT NULL DEFAULT 0,
    "discountedCentavos" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyBenefitUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoyaltyTierBenefit_tierId_type_idx" ON "LoyaltyTierBenefit"("tierId", "type");

-- CreateIndex
CREATE INDEX "LoyaltyBenefitUsage_tierBenefitId_periodStart_idx" ON "LoyaltyBenefitUsage"("tierBenefitId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyBenefitUsage_userId_tierBenefitId_periodStart_key" ON "LoyaltyBenefitUsage"("userId", "tierBenefitId", "periodStart");

-- CreateIndex
CREATE INDEX "OrderAppliedBenefit_tierBenefitId_createdAt_idx" ON "OrderAppliedBenefit"("tierBenefitId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrderAppliedBenefit" ADD CONSTRAINT "OrderAppliedBenefit_tierBenefitId_fkey" FOREIGN KEY ("tierBenefitId") REFERENCES "LoyaltyTierBenefit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTierBenefit" ADD CONSTRAINT "LoyaltyTierBenefit_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "LoyaltyTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyBenefitUsage" ADD CONSTRAINT "LoyaltyBenefitUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyBenefitUsage" ADD CONSTRAINT "LoyaltyBenefitUsage_tierBenefitId_fkey" FOREIGN KEY ("tierBenefitId") REFERENCES "LoyaltyTierBenefit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

