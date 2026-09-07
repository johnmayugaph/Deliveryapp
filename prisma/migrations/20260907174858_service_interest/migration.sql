-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'SERVICE_NOW_AVAILABLE';

-- CreateTable
CREATE TABLE "ServiceInterest" (
    "id" TEXT NOT NULL,
    "serviceKey" "ServiceKey" NOT NULL,
    "cityId" TEXT NOT NULL,
    "userId" TEXT,
    "askCount" INTEGER NOT NULL DEFAULT 1,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAskedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceInterest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceInterest_serviceKey_cityId_idx" ON "ServiceInterest"("serviceKey", "cityId");

-- CreateIndex
CREATE INDEX "ServiceInterest_notifiedAt_serviceKey_idx" ON "ServiceInterest"("notifiedAt", "serviceKey");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceInterest_serviceKey_cityId_userId_key" ON "ServiceInterest"("serviceKey", "cityId", "userId");

-- AddForeignKey
ALTER TABLE "ServiceInterest" ADD CONSTRAINT "ServiceInterest_serviceKey_fkey" FOREIGN KEY ("serviceKey") REFERENCES "Service"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceInterest" ADD CONSTRAINT "ServiceInterest_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceInterest" ADD CONSTRAINT "ServiceInterest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
