-- National per-km rates for the four launch countries (DEN-108).
--
-- The per-km term is the one thing the price BANDS deliberately do not set: it
-- is a national published figure, not a band-wide one. Until now every country
-- was charged the GERMAN rate, because 0.30 EUR/km sits in the global tariff.
--
-- All four rates are converted at the ECB reference rates of **2026-08-12**
-- (PLN 4.3043), and Ukraine at the NBU rate of the same day (UAH 51.7597) —
-- one date for every row, so the numbers are comparable with each other. The
-- source figure, its currency, the FX rate and the date are all stored beside
-- the cents: "we charge exactly the national rate" stops being true the moment
-- the currency moves, and a row that kept only the converted cents cannot say
-- so.
--
-- **Every row sets `returnTripFactor` = 2 explicitly.** These allowances are
-- defined on the round trip, and a row that takes the rate from one but
-- inherits the factor would silently halve its own collection the day an
-- operator touches the global factor.
--
-- **Germany deliberately gets NO row.** Its rate IS the global tariff, and
-- writing 30 here would disable `orderRatePerKmEur` in the admin panel for
-- Germany alone — the same trap the anchor band avoids by holding NULL, and the
-- one an e2e test caught when the anchor first restated the global base fee.

-- Poland: PLN 1.15/km for engines from 900 cm3, the higher of the two published
-- figures (0.89 applies below 900 cm3). We take the higher because an inspector
-- driving to a job is not selected for engine size, and under-collecting the
-- allowance is a cost the inspector carries personally.
-- 1.15 / 4.3043 = 0.2672 EUR
INSERT INTO "country_tariff" (
  country_code, zone_id, "perKmCents", "returnTripFactor", derivation,
  "sourceRate", "sourceCurrency", "sourcePerMile", "fxRate", "fxDate",
  "sourceUrl", "effectiveFrom", "createdAt", "updatedAt"
) VALUES (
  'PL', 'zone_pl_60_75', 27, 2, 'TAX_RATE',
  1.15, 'PLN', false, 4.3043, '2026-08-12',
  'https://isap.sejm.gov.pl/', '2026-01-17', NOW(), NOW()
)
ON CONFLICT (country_code) DO UPDATE SET
  "perKmCents" = EXCLUDED."perKmCents",
  "returnTripFactor" = EXCLUDED."returnTripFactor",
  derivation = EXCLUDED.derivation,
  "sourceRate" = EXCLUDED."sourceRate",
  "sourceCurrency" = EXCLUDED."sourceCurrency",
  "fxRate" = EXCLUDED."fxRate",
  "fxDate" = EXCLUDED."fxDate",
  "sourceUrl" = EXCLUDED."sourceUrl",
  "effectiveFrom" = EXCLUDED."effectiveFrom",
  "updatedAt" = NOW()
WHERE "country_tariff"."perKmCents" IS NULL;

-- Spain: 0.26 EUR/km, raised from 0.19 in 2023. Already in euro, so no FX and
-- no fx date — an fxRate of 1 would claim a conversion that never happened.
INSERT INTO "country_tariff" (
  country_code, zone_id, "perKmCents", "returnTripFactor", derivation,
  "sourceRate", "sourceCurrency", "sourcePerMile",
  "sourceUrl", "effectiveFrom", "createdAt", "updatedAt"
) VALUES (
  'ES', 'zone_pl_75_90', 26, 2, 'TAX_RATE',
  0.26, 'EUR', false,
  'https://www.boe.es/', '2023-07-17', NOW(), NOW()
)
ON CONFLICT (country_code) DO UPDATE SET
  "perKmCents" = EXCLUDED."perKmCents",
  "returnTripFactor" = EXCLUDED."returnTripFactor",
  derivation = EXCLUDED.derivation,
  "sourceRate" = EXCLUDED."sourceRate",
  "sourceCurrency" = EXCLUDED."sourceCurrency",
  "sourceUrl" = EXCLUDED."sourceUrl",
  "effectiveFrom" = EXCLUDED."effectiveFrom",
  "updatedAt" = NOW()
WHERE "country_tariff"."perKmCents" IS NULL;

-- Ukraine: there is NO national norm to take. No Ukrainian normative act sets
-- a per-km compensation figure — the amount is agreed between employer and
-- employee. So this row is `FUEL_DERIVED` and says so, rather than passing a
-- number of our own off as a state rate:
--
--   A-95 petrol 81.67 UAH/l (national average, 2026-08-12)
--   x 8 l/100 km  = 6.53 UAH/km fuel
--   x 1.5 wear factor (tyres, servicing, depreciation) = 9.80 UAH/km
--   / 51.7597 (NBU) = 0.1894 EUR -> 19 cents
--
-- `sourceRate` holds the derived UAH figure, not a published one, which is
-- exactly what `derivation` is there to disambiguate. A fuel-derived rate ages
-- on OUR schedule: it must be re-read when the pump price moves, and nothing
-- will republish it for us.
INSERT INTO "country_tariff" (
  country_code, zone_id, "perKmCents", "returnTripFactor", derivation,
  "sourceRate", "sourceCurrency", "sourcePerMile", "fxRate", "fxDate",
  "sourceUrl", "effectiveFrom", "createdAt", "updatedAt"
) VALUES (
  'UA', 'zone_pl_under_60', 19, 2, 'FUEL_DERIVED',
  9.80, 'UAH', false, 51.7597, '2026-08-12',
  'https://index.minfin.com.ua/ua/markets/fuel/a95/', '2026-08-12', NOW(), NOW()
)
ON CONFLICT (country_code) DO UPDATE SET
  "perKmCents" = EXCLUDED."perKmCents",
  "returnTripFactor" = EXCLUDED."returnTripFactor",
  derivation = EXCLUDED.derivation,
  "sourceRate" = EXCLUDED."sourceRate",
  "sourceCurrency" = EXCLUDED."sourceCurrency",
  "fxRate" = EXCLUDED."fxRate",
  "fxDate" = EXCLUDED."fxDate",
  "sourceUrl" = EXCLUDED."sourceUrl",
  "effectiveFrom" = EXCLUDED."effectiveFrom",
  "updatedAt" = NOW()
WHERE "country_tariff"."perKmCents" IS NULL;

-- Germany: the row exists (it maps DE to the anchor band) and stays money-free.
-- Recorded here so a reader looking for the German rate finds the reason rather
-- than an omission.
UPDATE "country_tariff" SET derivation = 'TAX_RATE',
  "sourceRate" = 0.30, "sourceCurrency" = 'EUR',
  "sourceUrl" = 'https://www.gesetze-im-internet.de/estg/__9.html',
  "updatedAt" = NOW()
WHERE country_code = 'DE' AND derivation IS NULL;
