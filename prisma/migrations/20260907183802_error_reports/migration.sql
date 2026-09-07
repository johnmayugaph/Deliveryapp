-- CreateEnum
CREATE TYPE "ErrorSource" AS ENUM ('SERVER_REQUEST', 'SERVER_ACTION', 'CRON', 'CLIENT', 'BACKGROUND');

-- AlterEnum
ALTER TYPE "AdminAction" ADD VALUE 'ERROR_REPORT_RESOLVED';

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'ERROR_DETECTED';

-- CreateTable
CREATE TABLE "ErrorReport" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "source" "ErrorSource" NOT NULL,
    "route" TEXT,
    "digest" TEXT,
    "userId" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "alertedAt" TIMESTAMP(3),

    CONSTRAINT "ErrorReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ErrorReport_fingerprint_key" ON "ErrorReport"("fingerprint");

-- CreateIndex
CREATE INDEX "ErrorReport_resolvedAt_lastSeenAt_idx" ON "ErrorReport"("resolvedAt", "lastSeenAt");

-- CreateIndex
CREATE INDEX "ErrorReport_alertedAt_idx" ON "ErrorReport"("alertedAt");

-- AddForeignKey
ALTER TABLE "ErrorReport" ADD CONSTRAINT "ErrorReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorReport" ADD CONSTRAINT "ErrorReport_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
