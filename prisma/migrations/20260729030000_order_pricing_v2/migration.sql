-- Ride-hailing order tariff: base + per-km + per-minute, scaled by surge/peak,
-- floored at a minimum fare. Adds the components needed to reconstruct a quote
-- after the fact, and records how the distance was measured.
--
-- `distance_km` keeps its column and type but changes meaning: it now holds ROAD
-- kilometres when `routing_source` = 'mapbox', and great-circle × the configured
-- detour factor when it is 'haversine'. Existing rows predate routing and hold
-- great-circle values with a NULL routing_source, which reads correctly as
-- "unknown provenance".
--
-- NOTE: `prisma migrate diff` also proposed dropping inspector_profile_location_idx,
-- order_location_idx and waitlist_entry_location_idx. Those are the PostGIS GIST
-- indexes that make the KNN nearest-inspector search work; Prisma cannot model
-- them and therefore proposes their removal on every single diff. They are
-- deliberately NOT dropped here.

ALTER TABLE "order"
  ADD COLUMN "duration_min"         INTEGER,
  ADD COLUMN "time_fee_cents"       INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN "surge_multiplier"     DECIMAL(4,2)  NOT NULL DEFAULT 1,
  ADD COLUMN "minimum_fare_applied" BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN "routing_source"       TEXT;
