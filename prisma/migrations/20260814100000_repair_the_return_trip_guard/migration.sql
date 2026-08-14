-- Repair the guard of 20260813120000_charge_the_return_trip.
--
-- That migration is one decision in two statements: lower the per-km rate from
-- an invented 0.60 to the published 0.30, and start charging both directions.
-- 0.30 x 2 = 0.60, so a fare only stays where it was if BOTH apply.
--
-- Only the first statement is guarded. The second is an INSERT ... ON CONFLICT,
-- and its WHERE clause can only reach a row that already exists: for the new
-- key -- which is what it is on every database that has not run it -- the plain
-- INSERT wins and the factor lands unconditionally. So an operator who had
-- already retuned the rate from the admin panel, say to 0.55, keeps their rate
-- AND takes the factor, and every travel charge on that installation doubles.
-- Nothing errors and nothing looks wrong; the fares are simply twice what the
-- operator set.
--
-- The two statements cannot be repaired in place -- a committed migration is
-- part of the contract, and rewriting one changes a checksum on every database
-- that already applied it. This runs immediately after instead, and restores
-- the invariant the pair was always supposed to hold: the factor of 2 belongs
-- to the 0.30 rate and to no other.
--
-- On a database that took both statements as intended (rate now 0.30) this is a
-- no-op. On one where the rate was left alone because an operator had moved it,
-- the factor goes back to 1 -- the "the rate already includes the return trip"
-- case, which is what that operator's number means. On a database with no rate
-- row at all (nothing seeded yet) it is also a no-op, and the seeded defaults
-- 0.30 / 2 apply as designed.
--
-- Safe to run exactly because it runs in the same deployment as the migration
-- it repairs: no operator can have chosen a deliberate rate/factor pair in the
-- window between the two. See DEN-108.
-- The comparisons go through `numeric` rather than the shipped migration's
-- `value::text`, and each cast is fenced behind a `CASE` on `jsonb_typeof`.
-- A rate an operator typed as 0.30 is the same rate as 0.3 and must not be read
-- as a deliberate change, and a row holding something that is not a number at
-- all must fail towards "changed" instead of failing the deploy on a cast.
UPDATE "platform_setting"
   SET value = '1'::jsonb, "updatedAt" = NOW()
 WHERE key = 'orderReturnTripFactor'
   AND jsonb_typeof(value) = 'number'
   AND (value #>> '{}')::numeric = 2
   AND EXISTS (
     SELECT 1
       FROM "platform_setting" rate
      WHERE rate.key = 'orderRatePerKmEur'
        AND CASE
              WHEN jsonb_typeof(rate.value) = 'number'
                THEN (rate.value #>> '{}')::numeric <> 0.3
              ELSE TRUE
            END
   );
