/*
  Warnings:

  - You are about to drop the column `imageUrl` on the `MenuItem` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "MenuItem" DROP COLUMN "imageUrl";

-- CreateTable
CREATE TABLE "MenuItemImage" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItemImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemImage_menuItemId_key" ON "MenuItemImage"("menuItemId");

-- AddForeignKey
ALTER TABLE "MenuItemImage" ADD CONSTRAINT "MenuItemImage_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemImage" ADD CONSTRAINT "MenuItemImage_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
