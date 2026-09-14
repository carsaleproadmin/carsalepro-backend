-- DEN-299: a super admin manages the admins.
-- Its own migration: PostgreSQL does not let a transaction use an enum value
-- that the same transaction added, so the data step is the next migration.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
