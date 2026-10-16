-- Mobile PRO: which devices each store purchase unlocked. Caps one purchase at
-- IAP_MAX_DEVICES_PER_PURCHASE devices (src/quota/iap/iap.types.ts).

-- CreateTable
CREATE TABLE "iap_grant" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "store_transaction_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iap_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "iap_grant_device_id_idx" ON "iap_grant"("device_id");

-- CreateIndex
CREATE UNIQUE INDEX "iap_grant_platform_store_transaction_id_device_id_key" ON "iap_grant"("platform", "store_transaction_id", "device_id");
