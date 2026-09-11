-- A shop's logo and banner, as bytes rather than as an address.
--
-- `Store.logoUrl` / `Store.coverUrl` are untouched and still the only columns
-- any page reads: an upload writes `/store-images/<id>` into one of them. So
-- every existing shop — including the seed's data: URLs and any hosted link —
-- keeps working exactly as it did.

-- CreateEnum
CREATE TYPE "StoreImageKind" AS ENUM ('LOGO', 'BANNER');

-- CreateTable
CREATE TABLE "StoreImage" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kind" "StoreImageKind" NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreImage_storeId_kind_key" ON "StoreImage"("storeId", "kind");

-- AddForeignKey
ALTER TABLE "StoreImage" ADD CONSTRAINT "StoreImage_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreImage" ADD CONSTRAINT "StoreImage_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
