-- CreateEnum
CREATE TYPE "EmailCodePurpose" AS ENUM ('VERIFY_ADDRESS', 'ACCOUNT_RECOVERY');

-- CreateEnum
CREATE TYPE "RecoveryMethod" AS ENUM ('VERIFIED_EMAIL', 'SUPPORT_ASSISTED');

-- AlterEnum
ALTER TYPE "AdminAction" ADD VALUE 'ACCOUNT_RECOVERED';

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'SECURITY_ALERT';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "frozenUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailVerification" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "EmailCodePurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "requestIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountRecovery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" "RecoveryMethod" NOT NULL,
    "previousPhone" TEXT NOT NULL,
    "newPhone" TEXT NOT NULL,
    "viaEmail" TEXT,
    "assistedByUserId" TEXT,
    "reason" TEXT,
    "creditsFrozenUntil" TIMESTAMP(3) NOT NULL,
    "alertSentAt" TIMESTAMP(3),
    "alertError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailVerification_email_purpose_createdAt_idx" ON "EmailVerification"("email", "purpose", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EmailVerification_requestIpHash_createdAt_idx" ON "EmailVerification"("requestIpHash", "createdAt");

-- CreateIndex
CREATE INDEX "EmailVerification_expiresAt_idx" ON "EmailVerification"("expiresAt");

-- CreateIndex
CREATE INDEX "AccountRecovery_userId_createdAt_idx" ON "AccountRecovery"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AccountRecovery_previousPhone_idx" ON "AccountRecovery"("previousPhone");

-- CreateIndex
CREATE INDEX "AccountRecovery_alertSentAt_createdAt_idx" ON "AccountRecovery"("alertSentAt", "createdAt");

-- AddForeignKey
ALTER TABLE "AccountRecovery" ADD CONSTRAINT "AccountRecovery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountRecovery" ADD CONSTRAINT "AccountRecovery_assistedByUserId_fkey" FOREIGN KEY ("assistedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
