-- A listing has no end date (DEN-XXX).
--
-- The 30-day term, its hourly expiry sweep and the renew action are removed.
-- Every listing that the sweep had already retired comes back to the showroom,
-- and the column that held the term is dropped.
UPDATE "listing" SET status = 'ACTIVE' WHERE status = 'EXPIRED';

ALTER TABLE "listing" DROP COLUMN "expires_at";

DELETE FROM "platform_setting" WHERE key = 'listingDurationDays';

-- NOTE: the value 'EXPIRED' stays in the "ListingStatus" enum. No row uses it
-- any more; removing a value needs a full type rewrite, which is not worth the
-- lock on a table the showroom reads.
