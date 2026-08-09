-- The inspection completeness gate, as a setting rather than a constant.
--
-- An order may only be closed with a report whose completeness score reaches
-- this number. It is a PlatformSetting and not a constant for one operational
-- reason: an inspector running an older build of the mobile app may send a
-- report with NO score at all, and discovering that in production must be
-- fixable from the admin panel in a minute, not by a release.
--
-- `0` disables the gate entirely — that is the emergency lever.
--
-- Seeded at 90 per the product decision. If a deployment needs to measure the
-- real distribution of scores first, set it to 0, observe, then raise it.

INSERT INTO "platform_setting" (key, value, updated_by, "updatedAt") VALUES
  ('minReportQualityScore', to_jsonb(90::numeric), 'migration:quality-gate', now())
ON CONFLICT (key) DO NOTHING;
