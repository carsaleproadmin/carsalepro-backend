-- Listing photos get permanent URLs, from a bucket that is public on purpose.
--
-- Showroom images were served through 15-minute signed URLs. That breaks every
-- ordinary thing a marketplace listing needs: a shared link dies, a search
-- engine indexes an expired URL, and the CDN cannot cache anything because the
-- query string changes on every render.
--
-- The obvious fix — making the existing bucket public, or setting the global
-- `R2_PUBLIC_URL` — is the dangerous one. Publicity in R2 is a property of the
-- BUCKET, and `carsalepro-reports` also holds paid inspection PDFs and KYC
-- objects. So this adds a SEPARATE public bucket and records, per row, which
-- bucket an object lives in.
--
-- Per-row rather than a global switch, because that makes the cutover a
-- resumable migration: rows move in batches, each row is served correctly
-- whichever side of the move it is on, and the code ships DARK — with
-- `R2_PUBLIC_*` unset, `bucket` stays NULL everywhere and behaviour is
-- byte-for-byte what it is today.

ALTER TABLE "listing_photo" ADD COLUMN "bucket" TEXT;

-- Report-backed listings have no `listing_photo` rows at all: their images come
-- from `report.photos_manifest`, in the private reports bucket. Those are
-- mirrored into the public bucket under a deterministic key; this records when.
ALTER TABLE "listing" ADD COLUMN "public_photos_mirrored_at" TIMESTAMP(3);
