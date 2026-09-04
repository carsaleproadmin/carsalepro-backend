-- Drop the paid VIN history tables - DEN-246.
--
-- The feature was withdrawn in DEN-243/244/245: the site sends the visitor to a
-- partner and `src/vin-history/` is deleted. These two tables were the last
-- thing left, and the owner decided to drop them rather than keep an archive of
-- a product that no longer exists.
--
-- IRREVERSIBLE. Two things had to happen BEFORE this reached production, and
-- both are recorded on DEN-246:
--
--   1. Count the rows on the production database. The expectation is zero real
--      buyers; the expectation is not the evidence.
--   2. Delete the `vin-history/` prefix in the reports bucket, or accept losing
--      it. `s3_key`, `pdf_s3_key` and `raw_s3_key` were the ONLY index of those
--      objects - after this migration nothing can find them again.
--
-- `payment` rows with purpose = 'vin_history' are deliberately UNTOUCHED. They
-- are financial records that the admin finance area and DAC7 reporting read,
-- and the foreign key ran from the purchase to the payment, never the reverse.
--
-- `vin_cache` is a DIFFERENT table and is not dropped here: it belongs to the
-- free NHTSA decode behind the frozen mobile route GET /vin/:vin.
--
-- NOTE for whoever regenerates a migration next: `prisma migrate diff` also
-- proposed DROP INDEX on the three PostGIS GIST indexes
-- (inspector_profile_location_idx, order_location_idx,
-- waitlist_entry_location_idx) and a rename of listing_make_model_search_idx.
-- None of those belong to this change and all were stripped - see CLAUDE.md.

-- DropForeignKey
ALTER TABLE "vin_history_purchase" DROP CONSTRAINT "vin_history_purchase_payment_id_fkey";

-- DropForeignKey
ALTER TABLE "vin_history_purchase" DROP CONSTRAINT "vin_history_purchase_report_id_fkey";

-- DropForeignKey
ALTER TABLE "vin_history_purchase" DROP CONSTRAINT "vin_history_purchase_user_id_fkey";

-- DropTable
DROP TABLE "vin_history_purchase";

-- DropTable
DROP TABLE "vin_history_report";
