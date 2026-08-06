-- The paid artefact moves from the shared provider cache onto the purchase.
--
-- `vin_history_report` is one row per (vin, provider), shared by every buyer so
-- the provider is billed once per lookup. Its refresh path overwrote the payload
-- and the R2 object in place, destroying the report an earlier buyer had paid
-- for. These two columns hold that buyer's own immutable snapshot.
--
-- NOTE: `prisma migrate diff` also proposes DROP INDEX for the three PostGIS
-- GIST indexes on every run. Those lines are deliberately NOT included here.
ALTER TABLE "vin_history_purchase" ADD COLUMN     "payload" JSONB,
ADD COLUMN     "s3_key" TEXT;

-- Backfill already-fulfilled purchases from the report they were sold from.
-- Without this every existing `ready` purchase loses its payload and its
-- download the moment the application starts reading from the purchase.
--
-- The R2 object itself is not copied: the legacy key
-- `vin-history/<provider>/<VIN>.json` stays where it is and a signed URL works
-- for any key. Only new purchases get a per-purchase key.
UPDATE "vin_history_purchase" p
SET "payload" = r."payload",
    "s3_key"  = r."raw_s3_key"
FROM "vin_history_report" r
WHERE p."report_id" = r."id"
  AND p."status" = 'ready'
  AND p."payload" IS NULL;
