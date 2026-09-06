-- CreateTable
CREATE TABLE "DeliveryFeeRule" (
    "id" TEXT NOT NULL,
    "serviceType" "ServiceKey" NOT NULL,
    "cityId" TEXT,
    "baseFeeCentavos" INTEGER NOT NULL,
    "includedMeters" INTEGER NOT NULL DEFAULT 0,
    "perKilometreCentavos" INTEGER NOT NULL,
    "minimumFeeCentavos" INTEGER NOT NULL DEFAULT 0,
    "maximumFeeCentavos" INTEGER,
    "freeAboveSubtotalCentavos" INTEGER,
    "smallOrderThresholdCentavos" INTEGER,
    "smallOrderFeeCentavos" INTEGER NOT NULL DEFAULT 0,
    "serviceFeeCentavos" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryFeeRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryFeeRule_serviceType_isActive_idx" ON "DeliveryFeeRule"("serviceType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryFeeRule_serviceType_cityId_key" ON "DeliveryFeeRule"("serviceType", "cityId");

-- AddForeignKey
ALTER TABLE "DeliveryFeeRule" ADD CONSTRAINT "DeliveryFeeRule_serviceType_fkey" FOREIGN KEY ("serviceType") REFERENCES "Service"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryFeeRule" ADD CONSTRAINT "DeliveryFeeRule_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;
