-- One identity document per kind, per application.
--
-- DESTRUCTIVE. Read this before applying it anywhere with real data.
--
-- Re-uploading an ID front appended a second row. Nothing deduplicated, and
-- every reader — the reviewer's queue included — picked one arbitrarily. So the
-- decision to approve or reject an inspector could be taken against a document
-- the applicant had already replaced.
--
-- Inventory before applying (returned 0 on both the dev and the test database):
--   SELECT application_id, kind, count(*) FROM kyc_document
--   GROUP BY 1,2 HAVING count(*) > 1;
--
-- Where duplicates DO exist, the newest upload wins. That is not an arbitrary
-- tie-break: the newest is what the applicant last chose to submit, and it is
-- the only reading under which "upload a corrected document" ever worked.
--
-- The R2 objects behind deleted rows are intentionally left in place. Deleting
-- them here would make the migration unrepeatable and irreversible; they are
-- covered by the existing KYC purge path instead.

DELETE FROM "kyc_document" d
USING "kyc_document" newer
WHERE d."application_id" = newer."application_id"
  AND d."kind"           = newer."kind"
  AND (d."uploadedAt" < newer."uploadedAt"
       OR (d."uploadedAt" = newer."uploadedAt" AND d."id" < newer."id"));

CREATE UNIQUE INDEX "kyc_document_application_id_kind_key"
  ON "kyc_document" ("application_id", "kind");
