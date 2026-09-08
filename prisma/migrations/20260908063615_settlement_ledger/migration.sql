-- CreateEnum
CREATE TYPE "SettlementParty" AS ENUM ('STORE', 'FLEET_PARTNER');

-- CreateEnum
CREATE TYPE "SettlementEntryType" AS ENUM ('ORDER_EARNINGS', 'CASH_COLLECTED', 'PAYOUT_SENT', 'CASH_REMITTED', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "commissionBasisPoints" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "SettlementEntry" (
    "id" TEXT NOT NULL,
    "party" "SettlementParty" NOT NULL,
    "storeId" TEXT,
    "fleetPartnerId" TEXT,
    "type" "SettlementEntryType" NOT NULL,
    "amountCentavos" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "orderId" TEXT,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "actorUserId" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SettlementEntry_idempotencyKey_key" ON "SettlementEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SettlementEntry_storeId_createdAt_idx" ON "SettlementEntry"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "SettlementEntry_fleetPartnerId_createdAt_idx" ON "SettlementEntry"("fleetPartnerId", "createdAt");

-- CreateIndex
CREATE INDEX "SettlementEntry_party_type_idx" ON "SettlementEntry"("party", "type");

-- CreateIndex
CREATE INDEX "SettlementEntry_orderId_idx" ON "SettlementEntry"("orderId");

-- AddForeignKey
ALTER TABLE "SettlementEntry" ADD CONSTRAINT "SettlementEntry_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementEntry" ADD CONSTRAINT "SettlementEntry_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementEntry" ADD CONSTRAINT "SettlementEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementEntry" ADD CONSTRAINT "SettlementEntry_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
