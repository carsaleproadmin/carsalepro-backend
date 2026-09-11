-- DEN-290. The customer does not choose an inspection time, and the price does
-- not change for peak hours.

-- 1. New orders store no time. Old orders keep the time they were created with.
ALTER TABLE "order" ALTER COLUMN "scheduled_at" DROP NOT NULL;

-- 2. The peak window settings are not read by anything now.
DELETE FROM "platform_setting"
WHERE "key" IN ('orderPeakMultiplier', 'orderPeakStartHour', 'orderPeakEndHour');

-- 3. The contract does not show a time.
--
-- The seed does not change a template that already has real content, and
-- Render runs `migrate deploy`, not the seed. Thus this migration makes the
-- change. It adds a NEW version and deactivates the old one. It does not edit
-- the old version, because contracts that were already rendered refer to it by
-- its version number.
--
-- Only the latest active version of each key is copied, and only when it still
-- contains the placeholder. Thus the migration does nothing on a database that
-- does not need it.
WITH src AS (
  SELECT DISTINCT ON (t."key")
    t."id",
    t."key",
    t."locale",
    t."title",
    t."body_md",
    (SELECT MAX(m."version") FROM "legal_template" m WHERE m."key" = t."key") + 1 AS next_version
  FROM "legal_template" t
  WHERE t."active" AND t."body_md" ~ '\{\{\s*scheduledAt\s*\}\}'
  ORDER BY t."key", t."version" DESC
),
ins AS (
  INSERT INTO "legal_template" ("id", "key", "version", "locale", "title", "body_md", "active", "createdAt")
  SELECT
    'den290-' || src."key" || '-v' || src.next_version,
    src."key",
    src.next_version,
    src."locale",
    src."title",
    regexp_replace(
      src."body_md",
      '\n[^\n]*\{\{\s*scheduledAt\s*\}\}[^\n]*',
      '',
      'g'
    ),
    TRUE,
    NOW()
  FROM src
  RETURNING "key"
)
UPDATE "legal_template"
SET "active" = FALSE
WHERE "id" IN (SELECT "id" FROM src);
