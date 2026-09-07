-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'SUPPORT_TICKET_WAITING';
ALTER TYPE "NotificationKind" ADD VALUE 'SUPPORT_REPLY';

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "alertedAt" TIMESTAMP(3),
ADD COLUMN     "firstRespondedAt" TIMESTAMP(3),
ADD COLUMN     "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "SupportTicket_status_firstRespondedAt_idx" ON "SupportTicket"("status", "firstRespondedAt");
