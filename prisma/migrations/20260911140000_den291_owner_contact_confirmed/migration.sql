-- DEN-291: the moment the assigned inspector confirmed contact with the car
-- owner. The inspector cannot start the trip (ASSIGNED -> EN_ROUTE) while it is
-- null.
--
-- Nullable with NO backfill. An order that is ASSIGNED at deploy time gets the
-- two buttons like a new one; the inspector presses "contacted" once and goes
-- on as before.
ALTER TABLE "order" ADD COLUMN "owner_contact_confirmed_at" TIMESTAMP(3);
