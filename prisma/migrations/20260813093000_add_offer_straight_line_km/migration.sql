-- Great-circle kilometres from the offered inspector to the vehicle.
--
-- Nullable with no backfill: an offer made before this column existed has no
-- recorded distance, and inventing one from today's inspector location would
-- claim a measurement nobody took. Null means "not recorded", which is the
-- truth. See DEN-108.
ALTER TABLE "order_offer"
  ADD COLUMN "straight_line_km" DECIMAL(7,2);
