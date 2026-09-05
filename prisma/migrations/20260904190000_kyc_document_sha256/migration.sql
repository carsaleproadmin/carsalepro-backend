-- KYC document fingerprint (DEN-249).
--
-- `sha256` holds the SHA-256 of the bytes as uploaded, so that a rejected
-- applicant cannot re-enter under a new account with the same files. It is
-- NULLABLE and stays NULL for every row that exists today: the platform never
-- held those bytes and cannot compute the value now.
--
-- WRITTEN BY HAND. `prisma migrate diff` adds three `DROP INDEX` statements for
-- the PostGIS location indexes on `inspector_profile`, `order` and
-- `waitlist_entry` on every run, because it cannot read an `Unsupported` column
-- type. Those indexes carry the inspector geo search. They are not dropped here
-- and must not be dropped by a generated file.

ALTER TABLE "kyc_document" ADD COLUMN "sha256" TEXT;

CREATE INDEX "kyc_document_sha256_idx" ON "kyc_document"("sha256");
