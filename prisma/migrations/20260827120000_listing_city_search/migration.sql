-- A city a buyer can actually search for - DEN-205.
--
-- `listing.city` is free text. It is written once, by whoever created the
-- listing, in whatever language their geocoder answered in - the table already
-- holds "Berlin", "Берлин" and "Биттерфельд-Вольфен" side by side - and it is
-- read by a buyer typing in whatever language they think in. A `contains`
-- between those two strings finds the car only when both happened to pick the
-- same alphabet, which is why a search for "Берлин" returned nothing while the
-- car sat in the showroom.
--
-- The fold cannot be done in SQL at query time. Case and diacritics could be
-- (`lower`, `unaccent`), but Cyrillic-to-Latin transliteration cannot without a
-- procedure nobody would maintain, and a function on the left-hand side of a
-- `LIKE` cannot use an index anyway. So the normalized form is STORED, written
-- by the application through `normalizeSearchText`, and indexed.
--
-- Nullable, with no default: a row whose city has not been normalized yet is a
-- fact worth being able to see, and NULL says it. The backfill below fills what
-- is already there; `scripts/backfill-listing-search-columns.ts` re-runs the same
-- work through the real transliterator for the rows this statement cannot
-- reach.
ALTER TABLE "listing" ADD COLUMN "city_search" TEXT;

-- A prefix/substring search on a text column. `text_pattern_ops` is what lets
-- `LIKE 'berlin%'` use the index; the trailing-wildcard form is the common case
-- and the only one that can be indexed at all.
CREATE INDEX "listing_city_search_idx" ON "listing" ("city_search" text_pattern_ops);

-- A first pass for the Latin-script rows, which is most of the table. Case and
-- whitespace only: Postgres has no transliteration, so the Cyrillic rows keep a
-- Cyrillic `city_search` until the backfill script rewrites them. That is
-- deliberate rather than a shortcut - a half-normalized column still matches
-- more than none, and the script is idempotent.
UPDATE "listing"
SET "city_search" = lower(btrim(regexp_replace("city", '\s+', ' ', 'g')))
WHERE "city" IS NOT NULL AND "city" <> '';
