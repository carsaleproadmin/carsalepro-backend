-- The paid VIN history becomes a document the buyer can keep.
--
-- The report was readable on a web page and archived as JSON, neither of which
-- is what someone who just paid for a vehicle history expects to walk away with.
--
-- The locale is stored alongside the key because the key CONTAINS it: rendering
-- the same purchase in a second language adds a document rather than
-- overwriting the first. `pdf_attempts` caps rendering, so a payload the
-- renderer chokes on becomes a logged failure instead of retrying on every
-- download — and, critically, a render failure never fails the sale.

ALTER TABLE "vin_history_purchase"
  ADD COLUMN "pdf_s3_key"      TEXT,
  ADD COLUMN "pdf_locale"      TEXT,
  ADD COLUMN "pdf_rendered_at" TIMESTAMP(3),
  ADD COLUMN "pdf_attempts"    INTEGER NOT NULL DEFAULT 0;

-- Purchases made before this column existed are backfilled lazily, on the first
-- download that asks for a PDF. A batch pass over history would need every old
-- payload re-read from R2 for documents most buyers will never request.
