-- CreateTable
CREATE TABLE "vin_cache" (
    "vin" VARCHAR(17) NOT NULL,
    "payload" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'nhtsa-vpic',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vin_cache_pkey" PRIMARY KEY ("vin")
);

-- CreateTable
CREATE TABLE "device_quota" (
    "device_id" TEXT NOT NULL,
    "free_reports_used" INTEGER NOT NULL DEFAULT 0,
    "free_reports_limit" INTEGER NOT NULL DEFAULT 3,
    "is_pro" BOOLEAN NOT NULL DEFAULT false,
    "pro_activated_at" TIMESTAMP(3),
    "pro_platform" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_quota_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "lrg" TEXT NOT NULL,
    "vin" VARCHAR(17),
    "s3_key" TEXT NOT NULL,
    "size_bytes" INTEGER,
    "hash" TEXT,
    "tier" TEXT NOT NULL,
    "uploaded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vin_cache_fetchedAt_idx" ON "vin_cache"("fetchedAt");

-- CreateIndex
CREATE INDEX "report_device_id_created_at_idx" ON "report"("device_id", "created_at");

-- CreateIndex
CREATE INDEX "report_vin_idx" ON "report"("vin");
