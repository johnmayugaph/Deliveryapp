-- AlterEnum
ALTER TYPE "AdminAction" ADD VALUE 'ADMIN_ROLE_CHANGED';

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;
