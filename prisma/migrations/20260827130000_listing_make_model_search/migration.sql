-- Make and model, folded for search - DEN-205.
--
-- Same reasoning as `city_search` in the migration before this one, applied to
-- the two other free-text filters, with one difference: separators are dropped
-- as well. Nobody agrees on the punctuation in a car name. The table holds
-- "Mercedes-Benz" and "C 220"; buyers type "mercedes benz", "Mercedes", "C220"
-- and "c-220" meaning the same car, and an exact match answered every one of
-- them with nothing.
--
-- A place name is deliberately NOT compacted this way: "Frankfurt am Main"
-- collapsed to "frankfurtammain" would be reachable by a search for "Main"
-- through the middle of a word.
ALTER TABLE "listing"
  ADD COLUMN "make_search" TEXT,
  ADD COLUMN "model_search" TEXT;

CREATE INDEX "listing_make_model_search_idx" ON "listing" ("make_search", "model_search");

-- What SQL can do: case, and the separators. Transliteration and diacritics are
-- left to `scripts/backfill-listing-search-columns.ts`, which rewrites all three
-- columns through the real normalizer and is idempotent.
UPDATE "listing"
SET "make_search"  = regexp_replace(lower("make"),  '[^a-z0-9]', '', 'g'),
    "model_search" = regexp_replace(lower("model"), '[^a-z0-9]', '', 'g')
WHERE "make" IS NOT NULL OR "model" IS NOT NULL;
