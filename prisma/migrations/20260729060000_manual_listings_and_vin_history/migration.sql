-- BE-S2 (listings without an inspection report) + BE-S3 (paid VIN history).
--
-- LISTING
-- `report_id` becomes NULLABLE so a private seller with no inspection can list a
-- car. It STAYS UNIQUE: Postgres treats NULLs as distinct in a unique index, so
-- any number of manual listings coexist while the single-use Report-ID claim
-- (one listing per report, ever) keeps working untouched — that unique index is
-- still the only claim marker there is.
--
-- The vehicle columns are denormalised onto the listing so showroom search can
-- filter one table regardless of provenance. For source='report' they are copied
-- from the report; for source='manual' they are seller-declared. The backfill at
-- the bottom populates every existing row — `prisma migrate diff` does not and
-- cannot generate it, so it is written by hand here.
--
-- The report_id foreign key is recreated as ON DELETE SET NULL (it was
-- RESTRICT). A hard-deleted report — GDPR erasure does exactly that — used to
-- make the delete fail; now the listing survives with report_id NULL, which
-- every read path treats as "not verified". A listing must never keep claiming
-- an inspection whose report no longer exists.
--
-- REFUND
-- `order_id` becomes nullable and `payment_id` is added. A paid VIN history
-- whose provider fails after capture is refunded automatically and has no order
-- to hang the refund off; keeping the money would be the alternative.
--
-- NOTE: `prisma migrate diff` again proposed dropping inspector_profile_location_idx,
-- order_location_idx and waitlist_entry_location_idx — the PostGIS GIST indexes
-- behind the KNN nearest-inspector search, which Prisma cannot model and therefore
-- proposes removing on every single run. They are deliberately NOT dropped here.

-- DropForeignKey
ALTER TABLE "listing" DROP CONSTRAINT "listing_report_id_fkey";

-- DropForeignKey
ALTER TABLE "refund" DROP CONSTRAINT "refund_order_id_fkey";

-- AlterTable
ALTER TABLE "listing" ADD COLUMN     "first_registration" TIMESTAMP(3),
ADD COLUMN     "fuel_type" TEXT,
ADD COLUMN     "hu_valid_until" TEXT,
ADD COLUMN     "make" TEXT,
ADD COLUMN     "mileage_km" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "power_kw" INTEGER,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'report',
ADD COLUMN     "transmission" TEXT,
ADD COLUMN     "vehicle_data" JSONB,
ADD COLUMN     "vin" VARCHAR(17),
ADD COLUMN     "year" INTEGER,
ALTER COLUMN "report_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "refund" ADD COLUMN     "payment_id" TEXT,
ALTER COLUMN "order_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "listing_photo" (
    "id" TEXT NOT NULL,
    "listing_id" TEXT NOT NULL,
    "r2_key" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "source_bytes" INTEGER,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'jpeg',
    "hash" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "caption" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listing_photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vin_history_report" (
    "id" TEXT NOT NULL,
    "vin" VARCHAR(17) NOT NULL,
    "provider" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "raw_s3_key" TEXT,
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vin_history_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vin_history_purchase" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "vin" VARCHAR(17) NOT NULL,
    "report_id" TEXT,
    "payment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3),

    CONSTRAINT "vin_history_purchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "listing_photo_r2_key_key" ON "listing_photo"("r2_key");

-- CreateIndex
CREATE INDEX "listing_photo_listing_id_order_idx" ON "listing_photo"("listing_id", "order");

-- CreateIndex
CREATE INDEX "vin_history_report_expires_at_idx" ON "vin_history_report"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "vin_history_report_vin_provider_key" ON "vin_history_report"("vin", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "vin_history_purchase_payment_id_key" ON "vin_history_purchase"("payment_id");

-- CreateIndex
CREATE INDEX "vin_history_purchase_user_id_created_at_idx" ON "vin_history_purchase"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vin_history_purchase_user_id_vin_key" ON "vin_history_purchase"("user_id", "vin");

-- CreateIndex
CREATE INDEX "listing_make_model_year_idx" ON "listing"("make", "model", "year");

-- CreateIndex
CREATE UNIQUE INDEX "refund_payment_id_key" ON "refund"("payment_id");

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing" ADD CONSTRAINT "listing_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_photo" ADD CONSTRAINT "listing_photo_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vin_history_purchase" ADD CONSTRAINT "vin_history_purchase_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vin_history_purchase" ADD CONSTRAINT "vin_history_purchase_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "vin_history_report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vin_history_purchase" ADD CONSTRAINT "vin_history_purchase_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- BACKFILL (hand-written — migrate diff never generates data moves)
--
-- Showroom search now reads listing.make/model/year/mileage_km instead of
-- joining the report. Without this, every listing that exists today drops out
-- of every filtered search the moment the new code deploys.
-- ============================================================

UPDATE "listing" l
SET
  "vin"        = r."vin",
  "make"       = r."make",
  "model"      = r."model",
  "year"       = r."year",
  "mileage_km" = r."mileage_km",
  -- Re-copy the three that were already denormalised: rows created before the
  -- claim path started copying them, or whose report was edited afterwards,
  -- currently hold NULL.
  "color"      = COALESCE(l."color", r."color"),
  "body_type"  = COALESCE(l."body_type", r."body_type"),
  "drive_type" = COALESCE(l."drive_type", r."drive_type")
FROM "report" r
WHERE l."report_id" = r."id";

-- The remaining attributes only ever existed inside the structured reportData
-- payload (contract v1), never as report columns.
UPDATE "listing" l
SET
  "fuel_type"      = NULLIF(r."report_data" -> 'vehicle' ->> 'fuelType', ''),
  "transmission"   = NULLIF(r."report_data" -> 'vehicle' ->> 'transmission', ''),
  "hu_valid_until" = NULLIF(r."report_data" -> 'vehicle' ->> 'tuvDate', ''),
  -- Guarded cast: the field is validated as ISO-8601 on write, but legacy rows
  -- predate that validator and a bad value here would abort the migration.
  "first_registration" = CASE
    WHEN r."report_data" -> 'vehicle' ->> 'firstRegistration' ~ '^\d{4}-\d{2}-\d{2}'
      THEN (substring(r."report_data" -> 'vehicle' ->> 'firstRegistration' FROM 1 FOR 10))::timestamp
    ELSE NULL
  END
FROM "report" r
WHERE l."report_id" = r."id"
  AND r."report_data" IS NOT NULL
  AND jsonb_typeof(r."report_data" -> 'vehicle') = 'object';
