-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT,
    "sizeBytes" INTEGER,
    "checksum" TEXT,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifyNote" TEXT,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupRun_ok_startedAt_idx" ON "BackupRun"("ok", "startedAt");

-- CreateIndex
CREATE INDEX "BackupRun_startedAt_idx" ON "BackupRun"("startedAt");
