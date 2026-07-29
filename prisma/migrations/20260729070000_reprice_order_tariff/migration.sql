-- One-time reprice of the order tariff, and seed rows for the new keys.
--
-- The tariff changed shape in 20260729030000_order_pricing_v2: base + per-km
-- became base + per-km + per-minute with a minimum fare. An existing deployment
-- would otherwise keep base 50.00 and 1.50/km AND gain the per-minute charge —
-- a price rise nobody decided on.
--
-- This lived in prisma/seed.ts, which was the wrong place: Render's start
-- command runs `prisma migrate deploy` and does NOT run the seed, so production
-- would never have been repriced. A migration runs exactly once, on deploy,
-- which is precisely the semantics "one-time reprice" needs.
--
-- Both UPDATEs are guarded on the OLD default value, so an operator who
-- deliberately tuned their pricing is not clobbered — only untouched rows move.

UPDATE "platform_setting"
SET value = to_jsonb(39::numeric), updated_by = 'migration:tariff-v2'
WHERE key = 'orderBaseFeeEur' AND value = to_jsonb(50::numeric);

UPDATE "platform_setting"
SET value = to_jsonb(0.6::numeric), updated_by = 'migration:tariff-v2'
WHERE key = 'orderRatePerKmEur' AND value = to_jsonb(1.5::numeric);

-- Materialise the new keys as rows. SettingsService falls back to the code
-- defaults when a row is missing, so the service works either way — but a row
-- that does not exist cannot be seen or edited in the admin panel.
INSERT INTO "platform_setting" (key, value, updated_by, "updatedAt") VALUES
  ('orderRatePerMinuteEur',  to_jsonb(0.35::numeric), 'migration:tariff-v2', now()),
  ('orderMinimumFareEur',    to_jsonb(49::numeric),   'migration:tariff-v2', now()),
  ('orderSurgeMultiplier',   to_jsonb(1::numeric),    'migration:tariff-v2', now()),
  ('orderPeakMultiplier',    to_jsonb(1::numeric),    'migration:tariff-v2', now()),
  ('orderPeakStartHour',     to_jsonb(16::numeric),   'migration:tariff-v2', now()),
  ('orderPeakEndHour',       to_jsonb(19::numeric),   'migration:tariff-v2', now()),
  ('orderDetourFactor',      to_jsonb(1.3::numeric),  'migration:tariff-v2', now()),
  ('orderRoutingCacheHours', to_jsonb(24::numeric),   'migration:tariff-v2', now()),
  ('vinHistoryPriceEur',     to_jsonb(19.99::numeric),'migration:tariff-v2', now()),
  ('vinHistoryCacheDays',    to_jsonb(30::numeric),   'migration:tariff-v2', now())
ON CONFLICT (key) DO NOTHING;
