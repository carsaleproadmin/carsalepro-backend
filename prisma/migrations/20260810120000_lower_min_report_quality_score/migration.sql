-- Lower the report completeness gate 90 -> 85.
--
-- The required exterior walk-around grew from 8 angles to 17 on 2026-08-10
-- (four for the luggage compartment, five for the engine bay). The mobile
-- quality score prorates a fixed 25 points over the REQUIRED angle count, so
-- the very same inspection now scores less than it did yesterday:
--
--   17/17, everything filled ............................ 100  pass
--   12/17, engine bay and open bonnet skipped ...........  93  pass
--    8/17, a report shot before the expansion, re-synced
--          from a newer build ...........................  87  pass   <- upper bound
--   17/17 with no make/model/VIN ........................  80  refuse <- lower bound
--
-- 85 is the only round number inside [81, 87]: it keeps a legacy report
-- closable and still refuses a report that does not identify the vehicle.
--
-- Why a migration and not prisma/seed.ts: the seed upserts settings with
-- `update: {}` so it never overwrites an admin-tuned value, and Render's start
-- command runs `prisma migrate deploy` and never the seed. Changing the code
-- default alone would have moved fresh installs and left production on 90 —
-- where every report from an updated app that skipped the engine bay would be
-- refused with `report_quality_too_low`.
--
-- Guarded on the old value, like 20260729070000_reprice_order_tariff: an
-- operator who deliberately tuned this keeps their number.

UPDATE "platform_setting"
SET value = to_jsonb(85::numeric), updated_by = 'migration:quality-gate-17-angles'
WHERE key = 'minReportQualityScore' AND value = to_jsonb(90::numeric);

-- Materialise the row for a deployment that never had one. SettingsService
-- falls back to the code default, so the gate works either way — but a row that
-- does not exist cannot be seen or edited in the admin panel, which is where
-- the emergency `0` lever lives.
INSERT INTO "platform_setting" (key, value, updated_by, "updatedAt") VALUES
  ('minReportQualityScore', to_jsonb(85::numeric), 'migration:quality-gate-17-angles', now())
ON CONFLICT (key) DO NOTHING;
