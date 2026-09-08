-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AdminAction" ADD VALUE 'SUBSCRIPTION_INVOICE_CONFIRMED';
ALTER TYPE "AdminAction" ADD VALUE 'SUBSCRIPTION_INVOICE_REFUSED';
ALTER TYPE "AdminAction" ADD VALUE 'SUBSCRIPTION_INVOICE_VOIDED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'SUBSCRIPTION_PAYMENT_CONFIRMED';
ALTER TYPE "NotificationKind" ADD VALUE 'SUBSCRIPTION_PAYMENT_REFUSED';

