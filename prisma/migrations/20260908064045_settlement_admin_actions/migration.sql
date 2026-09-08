-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAction" ADD VALUE 'SETTLEMENT_PAYOUT_RECORDED';
ALTER TYPE "AdminAction" ADD VALUE 'SETTLEMENT_REMITTANCE_RECORDED';
ALTER TYPE "AdminAction" ADD VALUE 'SETTLEMENT_ADJUSTED';
ALTER TYPE "AdminAction" ADD VALUE 'STORE_COMMISSION_CHANGED';
