-- DEN-535. Set when the seller of a report-backed listing opened the full
-- editor and the report data was copied into the listing. NULL = the listing
-- still reads the report. No backfill: every existing row is NULL by meaning.
ALTER TABLE "listing" ADD COLUMN "report_data_copied_at" TIMESTAMP(3);
