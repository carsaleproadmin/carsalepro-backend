-- Regional pricing: bands, plus per-country overrides (DEN-108).
--
-- Both tables ship EMPTY. Tariff resolution falls through to the global
-- PlatformSetting values, so this migration changes no price anywhere; a price
-- moves only when an operator puts numbers in a row.
--
-- The three PostGIS GIST indexes that `prisma migrate diff` proposes to drop on
-- every run are deliberately NOT dropped here.
-- CreateEnum
CREATE TYPE "RateDerivation" AS ENUM ('TAX_RATE', 'FUEL_DERIVED', 'REPRESENTATIVE');

-- CreateTable
CREATE TABLE "pricing_zone" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseFeeCents" INTEGER,
    "perKmCents" INTEGER,
    "ratePerMinuteCents" INTEGER,
    "minimumFareCents" INTEGER,
    "freeRadiusKm" DECIMAL(6,2),
    "capKm" DECIMAL(7,2),
    "returnTripFactor" DECIMAL(4,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "country_tariff" (
    "country_code" TEXT NOT NULL,
    "zone_id" TEXT,
    "baseFeeCents" INTEGER,
    "perKmCents" INTEGER,
    "ratePerMinuteCents" INTEGER,
    "minimumFareCents" INTEGER,
    "freeRadiusKm" DECIMAL(6,2),
    "capKm" DECIMAL(7,2),
    "returnTripFactor" DECIMAL(4,2),
    "derivation" "RateDerivation",
    "sourceRate" DECIMAL(10,4),
    "sourceCurrency" VARCHAR(3),
    "sourcePerMile" BOOLEAN NOT NULL DEFAULT false,
    "fxRate" DECIMAL(12,6),
    "fxDate" TIMESTAMP(3),
    "sourceUrl" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "country_tariff_pkey" PRIMARY KEY ("country_code")
);

-- CreateIndex
CREATE UNIQUE INDEX "pricing_zone_key_key" ON "pricing_zone"("key");

-- CreateIndex
CREATE INDEX "country_tariff_zone_id_idx" ON "country_tariff"("zone_id");

-- AddForeignKey
ALTER TABLE "country_tariff" ADD CONSTRAINT "country_tariff_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "pricing_zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
