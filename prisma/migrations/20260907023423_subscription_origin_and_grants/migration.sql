/*
  Warnings:

  - Added the required column `origin` to the `UserSubscription` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SubscriptionOrigin" AS ENUM ('PAID', 'COMPED', 'PROMOTIONAL');

-- AlterTable
ALTER TABLE "UserSubscription" ADD COLUMN     "grantNote" TEXT,
ADD COLUMN     "grantedByUserId" TEXT,
ADD COLUMN     "origin" "SubscriptionOrigin" NOT NULL;

-- CreateIndex
CREATE INDEX "UserSubscription_grantedByUserId_idx" ON "UserSubscription"("grantedByUserId");

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
