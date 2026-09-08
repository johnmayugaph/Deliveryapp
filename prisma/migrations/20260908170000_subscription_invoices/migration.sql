-- AlterEnum
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PENDING_PAYMENT';

-- CreateTable
CREATE TABLE "SubscriptionInvoice" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amountCentavos" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "lastFailureReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedReference" TEXT,
    "settledAt" TIMESTAMP(3),
    "settledVia" TEXT,
    "settledReference" TEXT,
    "settledById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInvoice_reference_key" ON "SubscriptionInvoice"("reference");

-- CreateIndex
CREATE INDEX "SubscriptionInvoice_dueAt_settledAt_idx" ON "SubscriptionInvoice"("dueAt", "settledAt");

-- CreateIndex
CREATE INDEX "SubscriptionInvoice_submittedAt_idx" ON "SubscriptionInvoice"("submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInvoice_subscriptionId_periodStart_key" ON "SubscriptionInvoice"("subscriptionId", "periodStart");

-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "UserSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionInvoice" ADD CONSTRAINT "SubscriptionInvoice_settledById_fkey" FOREIGN KEY ("settledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

