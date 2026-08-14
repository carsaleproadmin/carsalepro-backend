-- Work contact channels on the inspector profile, disclosed to the customer
-- once an order is ASSIGNED. All additive and nullable: nothing to backfill,
-- and an inspector who sets none still reaches the customer by email, which
-- falls back to the User row.
--
-- `prisma migrate diff` also proposed DROP INDEX for the three PostGIS GIST
-- indexes (inspector_profile_location_idx, order_location_idx,
-- waitlist_entry_location_idx). Those lines are stripped on every migration in
-- this repo — Prisma cannot model an index on an Unsupported() column and so
-- offers to delete them each run.
ALTER TABLE "inspector_profile" ADD COLUMN "contact_phone" TEXT,
ADD COLUMN "contact_email" TEXT,
ADD COLUMN "contact_whatsapp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "contact_telegram" TEXT;
