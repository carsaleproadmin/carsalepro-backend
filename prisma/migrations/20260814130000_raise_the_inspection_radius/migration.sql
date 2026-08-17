-- Accept inspections up to 300 km of ROAD, one direction. See DEN-118.
--
-- Two settings decide this and they are not in the same unit, which is why they
-- are one migration rather than one number:
--
--   orderCapKm            the ceiling, measured on the ROUTED distance in one
--                         direction. It refuses at the quote, before a price
--                         exists, so it is the number that actually defines
--                         "300 km".
--   expertSearchRadiusKm  a PostGIS straight-line prefilter over inspector
--                         locations. It only decides who is CONSIDERED.
--
-- The radius goes to 300 as well, deliberately wider than the cap needs: at the
-- 1.3 detour factor, 300 km of road is about 230 km on the map, and an
-- inspector who happens to sit on a motorway corridor is closer by road than
-- the factor assumes. Making the prefilter a superset lets the cap -- which
-- measures the real route -- do the refusing, instead of a straight-line
-- estimate silently answering "no coverage" for somebody who is within reach.
-- The cost is a slightly longer candidate list on a query that already runs on
-- a geography index.
--
-- The tariff is unchanged, on the owner's decision (2026-08-14): a 300 km order
-- prices at roughly 350 EUR, and that is accepted rather than tapered.
--
-- Both statements are guarded on the OLD shipped value, and each cast is fenced
-- behind `jsonb_typeof` so a row holding something that is not a number fails
-- towards "an operator changed this" instead of failing the deploy on a cast.
-- An operator who has already retuned either number from the admin panel keeps
-- it: this migration moves the SHIPPED value and must never overwrite a local
-- decision.
--
-- Editing PLATFORM_SETTING_DEFAULTS alone would not do this: `seed.ts` upserts
-- with `update: {}` and Render runs `migrate deploy`, never the seed. The
-- defaults still have to match, for a database that has no row at all.
UPDATE "platform_setting"
   SET value = '300'::jsonb, "updatedAt" = NOW()
 WHERE key = 'expertSearchRadiusKm'
   AND jsonb_typeof(value) = 'number'
   AND (value #>> '{}')::numeric = 50;

INSERT INTO "platform_setting" (key, value, "updatedAt")
VALUES ('orderCapKm', '300'::jsonb, NOW())
ON CONFLICT (key) DO UPDATE
   SET value = '300'::jsonb, "updatedAt" = NOW()
 WHERE jsonb_typeof("platform_setting".value) = 'number'
   AND ("platform_setting".value #>> '{}')::numeric = 100;
