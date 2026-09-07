-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'RATINGS_RECEIVED';

-- AlterTable
ALTER TABLE "OrderReview" ADD COLUMN     "partnerNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "storeNotifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OrderReview_storeNotifiedAt_createdAt_idx" ON "OrderReview"("storeNotifiedAt", "createdAt");

-- CreateIndex
CREATE INDEX "OrderReview_partnerNotifiedAt_createdAt_idx" ON "OrderReview"("partnerNotifiedAt", "createdAt");
