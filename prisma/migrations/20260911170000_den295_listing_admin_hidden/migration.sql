-- DEN-295: an admin who hides a listing must give a reason, and the seller is
-- told. `status` alone cannot tell an admin hide apart from the seller's own
-- unpublish - both are HIDDEN - and the difference decides whether the seller
-- may publish the listing again.
--
-- `admin_hidden_at` is set by an admin hide and cleared by an admin unhide.
-- Nullable with NO backfill: a listing an admin hid before this column existed
-- has no recorded reason, and inventing one would put words in an admin's
-- mouth. Such a listing behaves as before until an admin hides it again.
ALTER TABLE "listing" ADD COLUMN "admin_hidden_at" TIMESTAMP(3);
ALTER TABLE "listing" ADD COLUMN "admin_hidden_reason" TEXT;
