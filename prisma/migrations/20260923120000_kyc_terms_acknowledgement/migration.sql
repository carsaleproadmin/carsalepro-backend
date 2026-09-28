-- DEN-364: record the framework-terms acknowledgement taken at a KYC submit.
--
-- Both columns stay NULL for every application written before this. A
-- backfilled date would claim a confirmation that nobody gave, which is the
-- opposite of what the record is for.
ALTER TABLE "kyc_application" ADD COLUMN     "terms_accepted_at" TIMESTAMP(3),
ADD COLUMN     "terms_version" TEXT;
