-- CreateEnum
CREATE TYPE "ServiceKey" AS ENUM ('FOOD', 'MART', 'PARCEL', 'PABILI', 'RIDE');

-- CreateEnum
CREATE TYPE "IntentGroup" AS ENUM ('GO', 'EAT', 'GET', 'PAY');

-- CreateEnum
CREATE TYPE "FulfilmentType" AS ENUM ('MERCHANT_TO_DOOR', 'SHOPPER_TO_DOOR', 'POINT_TO_POINT', 'PASSENGER');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'FLEET_PARTNER', 'MERCHANT_OWNER', 'SUPPORT_AGENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'PENDING_MERCHANT_ACCEPTANCE', 'MERCHANT_ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'AWAITING_RIDER_ASSIGNMENT', 'RIDER_ASSIGNED', 'RIDER_AT_PICKUP', 'SHOPPING_IN_PROGRESS', 'AWAITING_BUDGET_APPROVAL', 'PASSENGER_ONBOARD', 'PICKED_UP', 'IN_TRANSIT', 'ARRIVED_AT_DROPOFF', 'DELIVERED', 'DROPPED_OFF', 'COMPLETED', 'FAILED_DELIVERY', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_MERCHANT', 'CANCELLED_BY_RIDER', 'CANCELLED_BY_SYSTEM');

-- CreateEnum
CREATE TYPE "OrderActor" AS ENUM ('CUSTOMER', 'MERCHANT', 'FLEET_PARTNER', 'SUPPORT_AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH_ON_DELIVERY', 'WALLET_CREDIT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('PROMO_CREDIT', 'REFUND', 'REFERRAL_BONUS', 'ORDER_PAYMENT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('ON_FOOT', 'BICYCLE', 'MOTORCYCLE', 'TRICYCLE', 'CAR', 'MPV', 'VAN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BenefitType" AS ENUM ('FREE_DELIVERY', 'DISCOUNT_PERCENT', 'CREDIT_BACK_PERCENT');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'AWAITING_CUSTOMER', 'ESCALATED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportTicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "FulfilmentAddressRole" AS ENUM ('PICKUP', 'DROPOFF');

-- CreateTable
CREATE TABLE "Service" (
    "key" "ServiceKey" NOT NULL,
    "displayName" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "intentGroup" "IntentGroup" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isComingSoon" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL,
    "fulfilmentType" "FulfilmentType" NOT NULL,
    "requiresMerchant" BOOLEAN NOT NULL,
    "requiresRider" BOOLEAN NOT NULL,
    "availableCityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accentToken" TEXT NOT NULL DEFAULT 'brand',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "centroidLat" DOUBLE PRECISION,
    "centroidLng" DOUBLE PRECISION,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "fullName" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "phoneVerifiedAt" TIMESTAMP(3),
    "roles" "UserRole"[] DEFAULT ARRAY['CUSTOMER']::"UserRole"[],
    "preferredCityId" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'fil-PH',
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Address" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "barangay" TEXT,
    "cityId" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "postalCode" TEXT,
    "landmark" TEXT,
    "deliveryNotes" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "isPickupCapable" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "serviceKeys" "ServiceKey"[] DEFAULT ARRAY[]::"ServiceKey"[],
    "ownerUserId" TEXT,
    "description" TEXT,
    "logoUrl" TEXT,
    "coverUrl" TEXT,
    "cityId" TEXT NOT NULL,
    "addressLine" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "contactPhone" TEXT,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "preparationMinutes" INTEGER NOT NULL DEFAULT 20,
    "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'Main',
    "priceCentavos" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "serviceType" "ServiceKey" NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotalCentavos" INTEGER NOT NULL DEFAULT 0,
    "deliveryFeeCentavos" INTEGER NOT NULL DEFAULT 0,
    "serviceFeeCentavos" INTEGER NOT NULL DEFAULT 0,
    "smallOrderFeeCentavos" INTEGER NOT NULL DEFAULT 0,
    "surgeCentavos" INTEGER NOT NULL DEFAULT 0,
    "tipCentavos" INTEGER NOT NULL DEFAULT 0,
    "promoDiscountCentavos" INTEGER NOT NULL DEFAULT 0,
    "subscriptionDiscountCentavos" INTEGER NOT NULL DEFAULT 0,
    "walletCreditAppliedCentavos" INTEGER NOT NULL DEFAULT 0,
    "totalCentavos" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "paymentMethod" "PaymentMethod" NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "assignedRiderId" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "placedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "etaAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "cancelledBy" "OrderActor",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAddress" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "role" "FulfilmentAddressRole" NOT NULL,
    "sourceAddressId" TEXT,
    "label" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "barangay" TEXT,
    "cityId" TEXT NOT NULL,
    "cityName" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "postalCode" TEXT,
    "landmark" TEXT,
    "deliveryNotes" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStatusEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actor" "OrderActor" NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetPartner" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabledServices" "ServiceKey"[] DEFAULT ARRAY[]::"ServiceKey"[],
    "vehicleType" "VehicleType" NOT NULL,
    "vehiclePlate" TEXT,
    "vehicleModel" TEXT,
    "equipment" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "homeCityId" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "currentLatitude" DOUBLE PRECISION,
    "currentLongitude" DOUBLE PRECISION,
    "locationUpdatedAt" TIMESTAMP(3),
    "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "completedOrderCount" INTEGER NOT NULL DEFAULT 0,
    "acceptanceRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetPartnerServiceVerification" (
    "id" TEXT NOT NULL,
    "fleetPartnerId" TEXT NOT NULL,
    "serviceType" "ServiceKey" NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "submittedDocuments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "rejectionReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetPartnerServiceVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balanceCentavos" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "isFrozen" BOOLEAN NOT NULL DEFAULT false,
    "frozenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "amountCentavos" INTEGER NOT NULL,
    "balanceAfterCentavos" INTEGER NOT NULL,
    "relatedOrderId" TEXT,
    "description" TEXT NOT NULL,
    "adminUserId" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "tagline" TEXT,
    "monthlyPriceCentavos" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionBenefit" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "type" "BenefitType" NOT NULL,
    "serviceKeys" "ServiceKey"[] DEFAULT ARRAY[]::"ServiceKey"[],
    "percentBasisPoints" INTEGER,
    "minimumOrderCentavos" INTEGER,
    "monthlyUsageCap" INTEGER,
    "maxDiscountCentavos" INTEGER,
    "monthlyCeilingCentavos" INTEGER,
    "displayLabel" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionBenefit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewsAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionBenefitUsage" (
    "id" TEXT NOT NULL,
    "userSubscriptionId" TEXT NOT NULL,
    "benefitId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "creditedCentavos" INTEGER NOT NULL DEFAULT 0,
    "discountedCentavos" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionBenefitUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAppliedBenefit" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "benefitId" TEXT,
    "type" "BenefitType" NOT NULL,
    "displayLabel" TEXT NOT NULL,
    "amountCentavos" INTEGER NOT NULL,
    "creditBackCentavos" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAppliedBenefit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "ticketNumber" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceType" "ServiceKey",
    "relatedOrderId" TEXT,
    "categorySlug" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "SupportTicketPriority" NOT NULL DEFAULT 'NORMAL',
    "assignedAgentId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "isFromSupport" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportTicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaqCategory" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "serviceType" "ServiceKey",
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaqCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaqArticle" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaqArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "imageUrl" TEXT,
    "ctaHref" TEXT,
    "serviceKeys" "ServiceKey"[] DEFAULT ARRAY[]::"ServiceKey"[],
    "cityIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Service_isActive_sortOrder_idx" ON "Service"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "Service_intentGroup_sortOrder_idx" ON "Service"("intentGroup", "sortOrder");

-- CreateIndex
CREATE INDEX "City_isActive_name_idx" ON "City"("isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_roles_idx" ON "User" USING GIN ("roles");

-- CreateIndex
CREATE INDEX "User_preferredCityId_idx" ON "User"("preferredCityId");

-- CreateIndex
CREATE INDEX "Address_userId_archivedAt_usageCount_idx" ON "Address"("userId", "archivedAt", "usageCount" DESC);

-- CreateIndex
CREATE INDEX "Address_userId_isPickupCapable_idx" ON "Address"("userId", "isPickupCapable");

-- CreateIndex
CREATE INDEX "Address_userId_lastUsedAt_idx" ON "Address"("userId", "lastUsedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Store_slug_key" ON "Store"("slug");

-- CreateIndex
CREATE INDEX "Store_cityId_isVisible_isOpen_idx" ON "Store"("cityId", "isVisible", "isOpen");

-- CreateIndex
CREATE INDEX "Store_serviceKeys_idx" ON "Store" USING GIN ("serviceKeys");

-- CreateIndex
CREATE INDEX "MenuItem_storeId_isAvailable_sortOrder_idx" ON "MenuItem"("storeId", "isAvailable", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE INDEX "Order_customerId_createdAt_idx" ON "Order"("customerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Order_customerId_status_idx" ON "Order"("customerId", "status");

-- CreateIndex
CREATE INDEX "Order_serviceType_status_idx" ON "Order"("serviceType", "status");

-- CreateIndex
CREATE INDEX "Order_assignedRiderId_status_idx" ON "Order"("assignedRiderId", "status");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderAddress_cityId_idx" ON "OrderAddress"("cityId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAddress_orderId_role_key" ON "OrderAddress"("orderId", "role");

-- CreateIndex
CREATE INDEX "OrderStatusEvent_orderId_createdAt_idx" ON "OrderStatusEvent"("orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FleetPartner_userId_key" ON "FleetPartner"("userId");

-- CreateIndex
CREATE INDEX "FleetPartner_isOnline_isSuspended_homeCityId_idx" ON "FleetPartner"("isOnline", "isSuspended", "homeCityId");

-- CreateIndex
CREATE INDEX "FleetPartner_enabledServices_idx" ON "FleetPartner" USING GIN ("enabledServices");

-- CreateIndex
CREATE INDEX "FleetPartnerServiceVerification_serviceType_status_idx" ON "FleetPartnerServiceVerification"("serviceType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FleetPartnerServiceVerification_fleetPartnerId_serviceType_key" ON "FleetPartnerServiceVerification"("fleetPartnerId", "serviceType");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_idempotencyKey_key" ON "WalletTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WalletTransaction_walletId_createdAt_idx" ON "WalletTransaction"("walletId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "WalletTransaction_relatedOrderId_idx" ON "WalletTransaction"("relatedOrderId");

-- CreateIndex
CREATE INDEX "WalletTransaction_type_createdAt_idx" ON "WalletTransaction"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_slug_key" ON "SubscriptionPlan"("slug");

-- CreateIndex
CREATE INDEX "SubscriptionPlan_isActive_sortOrder_idx" ON "SubscriptionPlan"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "SubscriptionBenefit_planId_type_idx" ON "SubscriptionBenefit"("planId", "type");

-- CreateIndex
CREATE INDEX "UserSubscription_userId_status_idx" ON "UserSubscription"("userId", "status");

-- CreateIndex
CREATE INDEX "UserSubscription_status_renewsAt_idx" ON "UserSubscription"("status", "renewsAt");

-- CreateIndex
CREATE INDEX "SubscriptionBenefitUsage_periodStart_idx" ON "SubscriptionBenefitUsage"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionBenefitUsage_userSubscriptionId_benefitId_perio_key" ON "SubscriptionBenefitUsage"("userSubscriptionId", "benefitId", "periodStart");

-- CreateIndex
CREATE INDEX "OrderAppliedBenefit_orderId_idx" ON "OrderAppliedBenefit"("orderId");

-- CreateIndex
CREATE INDEX "OrderAppliedBenefit_benefitId_createdAt_idx" ON "OrderAppliedBenefit"("benefitId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_ticketNumber_key" ON "SupportTicket"("ticketNumber");

-- CreateIndex
CREATE INDEX "SupportTicket_userId_createdAt_idx" ON "SupportTicket"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SupportTicket_status_priority_createdAt_idx" ON "SupportTicket"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicket_serviceType_status_idx" ON "SupportTicket"("serviceType", "status");

-- CreateIndex
CREATE INDEX "SupportTicket_relatedOrderId_idx" ON "SupportTicket"("relatedOrderId");

-- CreateIndex
CREATE INDEX "SupportTicketMessage_ticketId_createdAt_idx" ON "SupportTicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FaqCategory_slug_key" ON "FaqCategory"("slug");

-- CreateIndex
CREATE INDEX "FaqCategory_serviceType_sortOrder_idx" ON "FaqCategory"("serviceType", "sortOrder");

-- CreateIndex
CREATE INDEX "FaqCategory_isActive_sortOrder_idx" ON "FaqCategory"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "FaqArticle_categoryId_sortOrder_idx" ON "FaqArticle"("categoryId", "sortOrder");

-- CreateIndex
CREATE INDEX "Promotion_isActive_sortOrder_idx" ON "Promotion"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "Promotion_serviceKeys_idx" ON "Promotion" USING GIN ("serviceKeys");

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Address" ADD CONSTRAINT "Address_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_serviceType_fkey" FOREIGN KEY ("serviceType") REFERENCES "Service"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_assignedRiderId_fkey" FOREIGN KEY ("assignedRiderId") REFERENCES "FleetPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAddress" ADD CONSTRAINT "OrderAddress_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusEvent" ADD CONSTRAINT "OrderStatusEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusEvent" ADD CONSTRAINT "OrderStatusEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetPartner" ADD CONSTRAINT "FleetPartner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetPartnerServiceVerification" ADD CONSTRAINT "FleetPartnerServiceVerification_fleetPartnerId_fkey" FOREIGN KEY ("fleetPartnerId") REFERENCES "FleetPartner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetPartnerServiceVerification" ADD CONSTRAINT "FleetPartnerServiceVerification_serviceType_fkey" FOREIGN KEY ("serviceType") REFERENCES "Service"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetPartnerServiceVerification" ADD CONSTRAINT "FleetPartnerServiceVerification_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_relatedOrderId_fkey" FOREIGN KEY ("relatedOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionBenefit" ADD CONSTRAINT "SubscriptionBenefit_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSubscription" ADD CONSTRAINT "UserSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionBenefitUsage" ADD CONSTRAINT "SubscriptionBenefitUsage_userSubscriptionId_fkey" FOREIGN KEY ("userSubscriptionId") REFERENCES "UserSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionBenefitUsage" ADD CONSTRAINT "SubscriptionBenefitUsage_benefitId_fkey" FOREIGN KEY ("benefitId") REFERENCES "SubscriptionBenefit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAppliedBenefit" ADD CONSTRAINT "OrderAppliedBenefit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAppliedBenefit" ADD CONSTRAINT "OrderAppliedBenefit_benefitId_fkey" FOREIGN KEY ("benefitId") REFERENCES "SubscriptionBenefit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_serviceType_fkey" FOREIGN KEY ("serviceType") REFERENCES "Service"("key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_relatedOrderId_fkey" FOREIGN KEY ("relatedOrderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketMessage" ADD CONSTRAINT "SupportTicketMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaqCategory" ADD CONSTRAINT "FaqCategory_serviceType_fkey" FOREIGN KEY ("serviceType") REFERENCES "Service"("key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaqArticle" ADD CONSTRAINT "FaqArticle_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "FaqCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
