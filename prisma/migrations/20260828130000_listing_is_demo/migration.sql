-- DEN-216. Mark a listing the platform created to fill the showroom.
--
-- Additive, NOT NULL with a default of false, so every existing row keeps
-- saying what it already said: this is a real advert. The default is what
-- makes the column safe to add to a live table without a backfill.
ALTER TABLE "listing" ADD COLUMN "is_demo" BOOLEAN NOT NULL DEFAULT false;

-- Partial index: the queries that care ask for the demo rows (a sweep, an
-- admin view), never for the 99.9 % that are not.
CREATE INDEX "listing_is_demo_idx" ON "listing" ("is_demo") WHERE "is_demo" = true;
