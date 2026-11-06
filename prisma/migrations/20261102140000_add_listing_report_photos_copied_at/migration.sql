-- DEN-539. The report photos are copied into a listing only once the report
-- upload is complete, so they get a stamp of their own. A listing whose data
-- was already copied had its photos copied in the same call, so it takes the
-- same time.
ALTER TABLE "listing" ADD COLUMN "report_photos_copied_at" TIMESTAMP(3);
UPDATE "listing" SET "report_photos_copied_at" = "report_data_copied_at"
WHERE "report_data_copied_at" IS NOT NULL;
