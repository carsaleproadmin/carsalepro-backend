-- Raise the inspector search window 6 hours -> 24 hours (DEN-326).
--
-- The number used to be a product guess. It now has a job: dispatch offers the
-- order to ONE inspector at a time for `offerTimeoutMinutes` (60), so a single
-- pass over five candidates can take five hours. At 360 minutes the search got
-- one pass and the order was cancelled; the re-dispatch rounds need room for
-- several passes, or they never run at all.
--
-- The ceiling is still Stripe's: an uncaptured authorization expires after
-- 7 days, and 1440 minutes is well inside it. The cost is on the customer's
-- card, which holds the authorization for the whole window.
--
-- Why a migration and not prisma/seed.ts: the seed upserts settings with
-- `update: {}` so it never overwrites an admin-tuned value, and Render's start
-- command runs `prisma migrate deploy` and never the seed. Changing the code
-- default alone would move fresh installs and leave production on six hours.
--
-- Guarded on the old value, like 20260810120000_lower_min_report_quality_score:
-- an operator who deliberately tuned this keeps their number.

UPDATE "platform_setting"
SET value = to_jsonb(1440::numeric), updated_by = 'migration:den326-dispatch-rounds'
WHERE key = 'orderSearchWindowMinutes' AND value = to_jsonb(360::numeric);

-- Materialise the row for a deployment that never had one. SettingsService
-- falls back to the code default either way, but a row that does not exist
-- cannot be seen or edited in the admin panel.
INSERT INTO "platform_setting" (key, value, updated_by, "updatedAt") VALUES
  ('orderSearchWindowMinutes', to_jsonb(1440::numeric), 'migration:den326-dispatch-rounds', now())
ON CONFLICT (key) DO NOTHING;
