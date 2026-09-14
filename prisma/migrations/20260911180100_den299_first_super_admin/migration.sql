-- DEN-299: make the oldest active admin the first super admin.
-- Without one super admin, nobody can demote an admin. The step does nothing
-- when a super admin already exists, or when there is no active admin.
UPDATE "user"
SET "role" = 'SUPER_ADMIN'
WHERE "id" = (
  SELECT "id" FROM "user"
  WHERE "role" = 'ADMIN' AND "deletedAt" IS NULL AND "bannedAt" IS NULL
  ORDER BY "createdAt" ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM "user" WHERE "role" = 'SUPER_ADMIN');
