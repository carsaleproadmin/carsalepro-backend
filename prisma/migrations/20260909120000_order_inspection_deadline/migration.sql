-- DEN-269: the deadline for an accepted inspection to start.
--
-- Nullable with NO backfill, deliberately. The hourly sweep skips a null, so
-- every order assigned before this migration keeps living without a deadline
-- instead of being cancelled under a rule it was never given.
ALTER TABLE "order" ADD COLUMN "inspection_deadline_at" TIMESTAMP(3);

-- The sweep reads (status, inspection_deadline_at) every hour and the null rows
-- are the majority right after deploy, so they are kept out of the index.
CREATE INDEX "order_inspection_deadline_at_idx"
  ON "order" ("inspection_deadline_at")
  WHERE "inspection_deadline_at" IS NOT NULL;
