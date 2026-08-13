-- Kilometres of the trip that carried no travel charge, frozen on the order.
--
-- The default of 0 states what every existing order was charged: there was no
-- free radius when they were priced. Together with `return_trip_factor` and
-- `distance_km` it lets a row reproduce its own invoice years later. See
-- DEN-108.
ALTER TABLE "order"
  ADD COLUMN "free_radius_km" DECIMAL(6,2) NOT NULL DEFAULT 0;
