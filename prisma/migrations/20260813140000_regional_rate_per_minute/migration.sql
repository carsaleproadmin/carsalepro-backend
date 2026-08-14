-- The per-minute rate becomes regional (DEN-108).
--
-- The three fare terms answer to different things, and only two of them are
-- local:
--
--   * the BASE FEE pays for an expert hour, and an expert hour is priced where
--     the expert lives. Already banded.
--   * the PER-KM rate is a national tax-free mileage allowance. It is a
--     per-country published figure, not a band-wide one, and it stays out of
--     this migration.
--   * the PER-MINUTE rate pays for the SAME expert's travel time. It is the
--     base fee measured in minutes instead of in a job, so leaving it global
--     while the base fee is banded prices one hour of a Ukrainian inspector's
--     day at the German figure.
--
-- What that cost before this migration: on a short job the bands worked (Kyiv
-- 24 EUR against Zurich 57), but on a 100 km job the travel terms are most of
-- the fare, and both were world-uniform — the gap closed to 18 %. The band was
-- being diluted by exactly the part of the bill that grows.
--
-- The rate moves with the base fee, at the shipped ratio 0.35 / 39.00, and is
-- rounded to the whole cent:
--
--   45.00 -> 40  |  33.00 -> 30  |  27.00 -> 24  |  19.00 -> 17
--
-- The anchor band (`pl_90_105`) stays NULL, like its base fee and its floor. Its
-- numbers ARE the global tariff: writing 35 here would silently disable
-- `orderRatePerMinuteEur` in the admin panel for Germany, France and Japan,
-- because the more specific level wins.
--
-- Every UPDATE is guarded by `IS NULL`, so an operator who already typed a rate
-- for a band keeps it. That is the same guard the tariff migrations use, for the
-- same reason: a migration may install a decision, never overwrite one.
UPDATE "pricing_zone" SET "ratePerMinuteCents" = 40, "updatedAt" = NOW()
  WHERE key = 'pl_105_plus' AND "ratePerMinuteCents" IS NULL;

UPDATE "pricing_zone" SET "ratePerMinuteCents" = 30, "updatedAt" = NOW()
  WHERE key = 'pl_75_90' AND "ratePerMinuteCents" IS NULL;

UPDATE "pricing_zone" SET "ratePerMinuteCents" = 24, "updatedAt" = NOW()
  WHERE key = 'pl_60_75' AND "ratePerMinuteCents" IS NULL;

UPDATE "pricing_zone" SET "ratePerMinuteCents" = 17, "updatedAt" = NOW()
  WHERE key = 'pl_under_60' AND "ratePerMinuteCents" IS NULL;
