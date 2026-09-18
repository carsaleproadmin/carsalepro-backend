-- Lower the counter-offer ceiling 1.5 -> 1.2 (DEN-344).
--
-- The multiplier is the room ABOVE the fair price of this inspector's own
-- trip - the order re-priced on their distance and their base fee. The room
-- exists because the straight line is shorter than the road and a difficult
-- address costs more than the kilometres say; it was never meant to pay for
-- more than that. Half again the fair price is more than any of it costs, and
-- it is the figure the customer reads as opportunism:
--
--   fair 40 EUR  ... 1.5 permits 60,  1.2 permits 48
--   fair 200 EUR ... 1.5 permits 300, 1.2 permits 240
--
-- Why a migration and not prisma/seed.ts: the seed upserts settings with
-- `update: {}` so it never overwrites an admin-tuned value, and Render's start
-- command runs `prisma migrate deploy` and never the seed. Changing the code
-- default alone would move fresh installs and leave production on 1.5.
--
-- Guarded on the old value, like 20260810120000_lower_min_report_quality_score:
-- an operator who deliberately tuned this keeps their number.

UPDATE "platform_setting"
SET value = to_jsonb(1.2::numeric), updated_by = 'migration:counter-offer-ceiling-1_2'
WHERE key = 'counterOfferMaxMultiplier' AND value = to_jsonb(1.5::numeric);

-- Materialise the row for a deployment that never had one. SettingsService
-- falls back to the code default, so the ceiling holds either way - but a row
-- that does not exist cannot be seen or edited in the admin panel.
INSERT INTO "platform_setting" (key, value, updated_by, "updatedAt") VALUES
  ('counterOfferMaxMultiplier', to_jsonb(1.2::numeric), 'migration:counter-offer-ceiling-1_2', now())
ON CONFLICT (key) DO NOTHING;
