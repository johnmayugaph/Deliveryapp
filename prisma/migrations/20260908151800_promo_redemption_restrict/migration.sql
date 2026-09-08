-- DropForeignKey
ALTER TABLE "PromoRedemption" DROP CONSTRAINT "PromoRedemption_promoCodeId_fkey";

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

