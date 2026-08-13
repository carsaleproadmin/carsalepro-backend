-- The showroom is worldwide, so the search starts with the country. A city name
-- alone cannot answer it: there is a Frankfurt in Germany and a Frankfort in
-- Kentucky, and one text field matches both.
--
-- Nullable, and NOT backfilled. Every listing written before this column exists
-- has no country to claim. A guessed value ("everything is DE, the seed is
-- German") filters a real car out of a real search and nothing about the row
-- would look wrong.
ALTER TABLE "listing" ADD COLUMN "country_code" VARCHAR(2);

CREATE INDEX "listing_country_code_city_idx" ON "listing"("country_code", "city");
