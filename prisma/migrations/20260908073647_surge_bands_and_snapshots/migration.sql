-- CreateTable
CREATE TABLE "SurgeBand" (
    "id" TEXT NOT NULL,
    "serviceType" "ServiceKey" NOT NULL,
    "cityId" TEXT,
    "minOrdersPerRider" DOUBLE PRECISION NOT NULL,
    "surgeCentavos" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurgeBand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurgeSnapshot" (
    "id" TEXT NOT NULL,
    "serviceType" "ServiceKey" NOT NULL,
    "cityId" TEXT NOT NULL,
    "ordersWaiting" INTEGER NOT NULL,
    "ridersAvailable" INTEGER NOT NULL,
    "ratio" DOUBLE PRECISION NOT NULL,
    "surgeCentavos" INTEGER NOT NULL DEFAULT 0,
    "bandLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurgeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SurgeBand_serviceType_isActive_idx" ON "SurgeBand"("serviceType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SurgeBand_serviceType_cityId_minOrdersPerRider_key" ON "SurgeBand"("serviceType", "cityId", "minOrdersPerRider");

-- CreateIndex
CREATE INDEX "SurgeSnapshot_serviceType_cityId_createdAt_idx" ON "SurgeSnapshot"("serviceType", "cityId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "SurgeBand" ADD CONSTRAINT "SurgeBand_serviceType_fkey" FOREIGN KEY ("serviceType") REFERENCES "Service"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurgeBand" ADD CONSTRAINT "SurgeBand_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurgeSnapshot" ADD CONSTRAINT "SurgeSnapshot_serviceType_fkey" FOREIGN KEY ("serviceType") REFERENCES "Service"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurgeSnapshot" ADD CONSTRAINT "SurgeSnapshot_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
