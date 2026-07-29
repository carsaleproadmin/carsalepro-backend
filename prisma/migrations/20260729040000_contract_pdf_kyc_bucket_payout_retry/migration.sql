-- Three independent hardening changes that happen to land together.
--
-- order_contract: the HTML archive key was computed and the object uploaded, but
-- the key was never stored, so the archive was unreachable. pdf_* records the
-- rendering attempt so a failed render becomes a retryable job rather than a
-- permanently false `pdfReady`.
--
-- kyc_document.bucket: identity documents are moving out of the shared reports
-- bucket into a dedicated private one. Recording the bucket per row makes the
-- migration window explicit — a NULL is the legacy shared bucket — instead of
-- relying on "everything moved at once".
--
-- payout: a failed Stripe transfer parked a pending row and nothing ever tried
-- again. These columns give the retry cron a schedule, an attempt cap and a
-- reason to show an operator.
--
-- NOTE: `prisma migrate diff` again proposed dropping inspector_profile_location_idx,
-- order_location_idx and waitlist_entry_location_idx — the PostGIS GIST indexes
-- behind the KNN inspector search, which Prisma cannot model. Deliberately NOT
-- dropped here.

ALTER TABLE "order_contract"
  ADD COLUMN "html_s3_key"     TEXT,
  ADD COLUMN "pdf_rendered_at" TIMESTAMP(3),
  ADD COLUMN "pdf_attempts"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pdf_last_error"  TEXT;

ALTER TABLE "kyc_document"
  ADD COLUMN "bucket" TEXT;

ALTER TABLE "payout"
  ADD COLUMN "attempts"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_error"      TEXT,
  ADD COLUMN "last_attempt_at" TIMESTAMP(3),
  ADD COLUMN "next_retry_at"   TIMESTAMP(3);

-- Drives the hourly PDF backfill: unrendered contracts under the attempt cap.
CREATE INDEX "order_contract_pdf_s3_key_pdf_attempts_idx"
  ON "order_contract" ("pdf_s3_key", "pdf_attempts");

-- Drives the payout retry cron: due retries by status.
CREATE INDEX "payout_status_next_retry_at_idx"
  ON "payout" ("status", "next_retry_at");
