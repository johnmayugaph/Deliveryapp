-- CreateEnum
CREATE TYPE "DispatchOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "DispatchOffer" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fleetPartnerId" TEXT NOT NULL,
    "status" "DispatchOfferStatus" NOT NULL DEFAULT 'PENDING',
    "rank" INTEGER NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DispatchOffer_fleetPartnerId_status_expiresAt_idx" ON "DispatchOffer"("fleetPartnerId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "DispatchOffer_orderId_status_idx" ON "DispatchOffer"("orderId", "status");

-- CreateIndex
CREATE INDEX "DispatchOffer_status_expiresAt_idx" ON "DispatchOffer"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchOffer_orderId_fleetPartnerId_key" ON "DispatchOffer"("orderId", "fleetPartnerId");

-- AddForeignKey
ALTER TABLE "DispatchOffer" ADD CONSTRAINT "DispatchOffer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchOffer" ADD CONSTRAINT "DispatchOffer_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
