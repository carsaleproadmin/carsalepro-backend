-- Make `inspector_profile.search_radius_km` mean something. See DEN-113.
--
-- The column has existed since the first inspector migration, is editable in
-- the profile form, and was read by NOTHING: dispatch filtered on the platform
-- ceiling alone. `GeoService.findNearestInspectors` now takes the tighter of
-- the two, which is the whole point of the field.
--
-- That flips the meaning of every stored 50. It is the column default, and it
-- got there because a value had to be written, not because an inspector chose
-- it — choosing it did nothing, so nobody had a reason to. Honouring those 50s
-- literally would cut the reach the platform has TODAY (the ceiling is 300 as
-- of DEN-118) down to 50 km for the entire roster, silently, in the same
-- deployment that widened it. Every order between 50 and 300 km would find
-- nobody and read as "no coverage".
--
-- So rows still holding the untouched default move to 300 -- the reach those
-- inspectors already have and have been serving. Anything else is a number a
-- human typed while the field was inert; it was a statement of preference then
-- and it is honoured now, which is the correction this ticket is about.
--
-- New rows default to the ceiling for the same reason: an inspector who has
-- not answered the question keeps today's behaviour, and one who does not want
-- a five-hour drive finally has a control that works.
ALTER TABLE "inspector_profile" ALTER COLUMN "search_radius_km" SET DEFAULT 300;

UPDATE "inspector_profile"
   SET "search_radius_km" = 300
 WHERE "search_radius_km" = 50;
