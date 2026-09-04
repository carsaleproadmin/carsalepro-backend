-- KYC document number, hashed (DEN-250).
--
-- `id_number_hash` holds a peppered SHA-256 of the issuing state, the document
-- code and the document number as read from the machine-readable zone. It is
-- NULLABLE and stays NULL wherever no zone could be read: a card without one, a
-- photograph that cannot be recognised, or the reader switched off. A NULL
-- matches nothing.
--
-- WRITTEN BY HAND, like every migration in this repository. `prisma migrate
-- diff` adds three `DROP INDEX` statements for the PostGIS location indexes on
-- `inspector_profile`, `order` and `waitlist_entry`, which carry the inspector
-- geo search.

ALTER TABLE "kyc_document" ADD COLUMN "id_number_hash" TEXT;

CREATE INDEX "kyc_document_id_number_hash_idx" ON "kyc_document"("id_number_hash");
