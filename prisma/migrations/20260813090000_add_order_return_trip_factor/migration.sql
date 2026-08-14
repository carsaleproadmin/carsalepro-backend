-- Records how many times the measured one-direction trip an order was charged.
--
-- The default of 1 is what makes this migration safe on existing rows: every
-- order written before this column was priced with the return trip folded into
-- the per-km rate, so 1 states exactly what happened and `distance_km` keeps
-- its meaning. It becomes 2 only when the rate itself is anchored to a national
-- tax-free mileage rate. See DEN-108.
ALTER TABLE "order"
  ADD COLUMN "return_trip_factor" DECIMAL(4,2) NOT NULL DEFAULT 1;
