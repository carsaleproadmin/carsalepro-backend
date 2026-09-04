-- The minimum fare drops from 49 EUR to 5 EUR. Owner's decision of 2026-09-04.
--
-- Editing PLATFORM_SETTING_DEFAULTS does not reach production: the seed upserts
-- with `update: {}` and Render runs `prisma migrate deploy`, never the seed. A
-- migration is the only path a decided number takes to a running deployment.
--
-- Why the floor moves. At 49 it WAS the price of a short job: the base plus the
-- travel does not reach it before roughly 37 km one way, so every nearer order
-- cost the same, whatever the tariff said. That hid an inspector's own base fee
-- (5 and 39 both produced 49 next door, so the one number DEN-213 gave them to
-- set changed nothing where most orders are) and it overrode regional pricing,
-- topping every cheaper country up to the same figure.
--
-- Guarded on the old default, like the tariff-v2 reprice before it: an operator
-- who already tuned this from the admin panel keeps their number. Only a row
-- still sitting on 49 moves.
UPDATE "platform_setting"
SET value = to_jsonb(5::numeric), updated_by = 'migration:lower-minimum-fare'
WHERE key = 'orderMinimumFareEur' AND value = to_jsonb(49::numeric);
