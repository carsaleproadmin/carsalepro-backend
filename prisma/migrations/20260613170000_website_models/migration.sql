-- PostGIS is required for geography columns (inspector/order/waitlist locations).
-- Created here (not via Prisma managed extensions) so the same migration works on
-- the dev DB, the migrate shadow DB, and Render production.
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'PAID', 'UNASSIGNED', 'ASSIGNED', 'EN_ROUTE', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'ACTIVE', 'EXPIRED', 'SOLD', 'HIDDEN', 'DELETED');

-- AlterTable
ALTER TABLE "report" ADD COLUMN     "body_type" TEXT,
ADD COLUMN     "color" TEXT,
ADD COLUMN     "drive_type" TEXT,
ADD COLUMN     "mileage_km" INTEGER,
ADD COLUMN     "order_id" TEXT,
ADD COLUMN     "photos_manifest" JSONB,
ADD COLUMN     "quality_score" INTEGER,
ADD COLUMN     "report_data" JSONB,
ADD COLUMN     "user_id" TEXT,
ADD COLUMN     "year" INTEGER;

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "passwordHash" TEXT,
    "name" TEXT,
    "phone" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'de',
    "countryCode" TEXT NOT NULL DEFAULT 'DE',
    "role" "Role" NOT NULL DEFAULT 'USER',
    "kycVerified" BOOLEAN NOT NULL DEFAULT false,
    "bannedAt" TIMESTAMP(3),
    "totpSecret" TEXT,
    "notificationPrefs" JSONB,
    "gdprConsentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_account" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_token" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "identifier" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspector_profile" (
    "user_id" TEXT NOT NULL,
    "company_name" TEXT,
    "tax_id" TEXT,
    "vat_id" TEXT,
    "base_address" TEXT NOT NULL,
    "location" geography(Point, 4326),
    "search_radius_km" INTEGER NOT NULL DEFAULT 50,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "stripe_account_id" TEXT,
    "stripe_onboarded" BOOLEAN NOT NULL DEFAULT false,
    "fcm_token" TEXT,
    "cancel_count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspector_profile_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "device_link" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "linked_via" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_application" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'DRAFT',
    "reject_reason" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_document" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "kyc_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "inspector_id" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "vin" VARCHAR(17),
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "listing_url" TEXT,
    "address" TEXT NOT NULL,
    "location" geography(Point, 4326) NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "country_code" TEXT NOT NULL DEFAULT 'DE',
    "base_fee_cents" INTEGER NOT NULL,
    "distance_km" DECIMAL(65,30) NOT NULL,
    "distance_fee_cents" INTEGER NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "platform_fee_cents" INTEGER NOT NULL,
    "inspector_share_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "contract_id" TEXT,
    "auto_approve_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_offer" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "inspector_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_event" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "order_id" TEXT,
    "purpose" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL,
    "stripe_payment_intent_id" TEXT,
    "stripe_checkout_session_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "stripe_refund_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "inspector_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "stripe_transfer_id" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_webhook_event" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
    "package" TEXT NOT NULL DEFAULT 'standard',
    "price_cents" INTEGER NOT NULL,
    "city" TEXT NOT NULL,
    "plz" TEXT,
    "description" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "color" TEXT,
    "body_type" TEXT,
    "drive_type" TEXT,
    "views_count" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_purchase" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_template" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_contract" (
    "id" TEXT NOT NULL,
    "template_key" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "rendered_html" TEXT NOT NULL,
    "pdf_s3_key" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "opened_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "read_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "waitlist_entry" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "city" TEXT,
    "location" geography(Point, 4326),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_role_idx" ON "user"("role");

-- CreateIndex
CREATE UNIQUE INDEX "auth_account_provider_provider_account_id_key" ON "auth_account"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "verification_token_token_hash_key" ON "verification_token"("token_hash");

-- CreateIndex
CREATE INDEX "verification_token_identifier_idx" ON "verification_token"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "inspector_profile_stripe_account_id_key" ON "inspector_profile"("stripe_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_link_device_id_key" ON "device_link"("device_id");

-- CreateIndex
CREATE INDEX "device_link_user_id_idx" ON "device_link"("user_id");

-- CreateIndex
CREATE INDEX "kyc_application_status_idx" ON "kyc_application"("status");

-- CreateIndex
CREATE INDEX "kyc_application_user_id_idx" ON "kyc_application"("user_id");

-- CreateIndex
CREATE INDEX "kyc_document_application_id_idx" ON "kyc_document"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_number_key" ON "order"("number");

-- CreateIndex
CREATE UNIQUE INDEX "order_contract_id_key" ON "order"("contract_id");

-- CreateIndex
CREATE INDEX "order_status_idx" ON "order"("status");

-- CreateIndex
CREATE INDEX "order_customer_id_idx" ON "order"("customer_id");

-- CreateIndex
CREATE INDEX "order_inspector_id_idx" ON "order"("inspector_id");

-- CreateIndex
CREATE INDEX "order_offer_order_id_idx" ON "order_offer"("order_id");

-- CreateIndex
CREATE INDEX "order_offer_inspector_id_status_idx" ON "order_offer"("inspector_id", "status");

-- CreateIndex
CREATE INDEX "order_event_order_id_idx" ON "order_event"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_order_id_key" ON "payment"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_stripe_payment_intent_id_key" ON "payment"("stripe_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_stripe_checkout_session_id_key" ON "payment"("stripe_checkout_session_id");

-- CreateIndex
CREATE INDEX "payment_user_id_idx" ON "payment"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_stripe_refund_id_key" ON "refund"("stripe_refund_id");

-- CreateIndex
CREATE INDEX "refund_order_id_idx" ON "refund"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_order_id_key" ON "payout"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_stripe_transfer_id_key" ON "payout"("stripe_transfer_id");

-- CreateIndex
CREATE INDEX "payout_inspector_id_idx" ON "payout"("inspector_id");

-- CreateIndex
CREATE UNIQUE INDEX "listing_report_id_key" ON "listing"("report_id");

-- CreateIndex
CREATE INDEX "listing_status_package_published_at_idx" ON "listing"("status", "package", "published_at");

-- CreateIndex
CREATE INDEX "listing_seller_id_idx" ON "listing"("seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_purchase_payment_id_key" ON "report_purchase"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_purchase_user_id_report_id_key" ON "report_purchase"("user_id", "report_id");

-- CreateIndex
CREATE UNIQUE INDEX "legal_template_key_version_key" ON "legal_template"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_order_id_key" ON "dispute"("order_id");

-- CreateIndex
CREATE INDEX "notification_user_id_createdAt_idx" ON "notification"("user_id", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_entity_entity_id_idx" ON "admin_audit_log"("entity", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_order_id_key" ON "report"("order_id");

-- CreateIndex
CREATE INDEX "report_user_id_idx" ON "report"("user_id");

-- CreateIndex
CREATE INDEX "report_code_idx" ON "report"("code");

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_token" ADD CONSTRAINT "verification_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspector_profile" ADD CONSTRAINT "inspector_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_link" ADD CONSTRAINT "device_link_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_application" ADD CONSTRAINT "kyc_application_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_document" ADD CONSTRAINT "kyc_document_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "kyc_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_inspector_id_fkey" FOREIGN KEY ("inspector_id") REFERENCES "inspector_profile"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "order_contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_offer" ADD CONSTRAINT "order_offer_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_offer" ADD CONSTRAINT "order_offer_inspector_id_fkey" FOREIGN KEY ("inspector_id") REFERENCES "inspector_profile"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_event" ADD CONSTRAINT "order_event_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_inspector_id_fkey" FOREIGN KEY ("inspector_id") REFERENCES "inspector_profile"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing" ADD CONSTRAINT "listing_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing" ADD CONSTRAINT "listing_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "report"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_purchase" ADD CONSTRAINT "report_purchase_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_purchase" ADD CONSTRAINT "report_purchase_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute" ADD CONSTRAINT "dispute_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- GIST spatial indexes on geography columns (Prisma cannot model indexes on
-- Unsupported() columns). Required for KNN nearest-inspector search.
CREATE INDEX "inspector_profile_location_idx" ON "inspector_profile" USING GIST ("location");
CREATE INDEX "order_location_idx" ON "order" USING GIST ("location");
CREATE INDEX "waitlist_entry_location_idx" ON "waitlist_entry" USING GIST ("location");
