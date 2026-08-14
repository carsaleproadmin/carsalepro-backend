-- The remaining national per-km rates (DEN-108), 19 countries.
--
-- Same rule as the four launch countries: the kilometre term is a per-COUNTRY
-- published figure, so it lives on the country row and never on a band. Every
-- row states `returnTripFactor` = 2 — these allowances are defined on the round
-- trip, and a row that takes the rate from one but inherits the factor collects
-- half of what it claims the day the global factor is touched.
--
-- **One FX date for every row: 2026-08-12**, ECB reference rates
-- (DKK 7.4758 · SEK 10.9965 · GBP 0.85358 · USD 1.1545 · CAD 1.6077 ·
--  CHF 0.9366 · CZK 24.254 · HUF 364.10). Rows converted on different days are
-- not comparable with each other, which is the whole reason the date is stored
-- rather than assumed.
--
-- `derivation` separates three genuinely different kinds of number, because
-- they age differently and a customer is entitled to know which one they pay:
--
--   TAX_RATE       a single national figure, republished by the state. Re-read
--                  when the state moves it.
--   REPRESENTATIVE the state publishes a TABLE, not a rate (France by fiscal
--                  horsepower, Italy by car model, Ireland by engine size and
--                  distance band). One figure standing in for a table, named as
--                  such rather than passed off as a national rate.
--   FUEL_DERIVED   the state publishes nothing usable. Computed by us, ages on
--                  OUR schedule: nothing will republish it for us.
--
-- Where a country publishes a basic amortisation PLUS fuel by receipt (CZ, SK,
-- HU), the stored figure is that construction evaluated at the August 2026 pump
-- price and 8 l/100 km — the published half alone is not a rate: Hungary's
-- 9 HUF/km is 2.5 cents, which pays for no travel at all.
--
-- Rates NOT taken and why:
--   * per-mile figures (GB, US) keep `sourcePerMile` = true. A per-mile rate
--     converted as if it were per-km is wrong by a factor of 1.6 in the
--     customer's disfavour, and nothing about the number looks wrong.
--   * tiered rates (GB 55p then 25p, CA 0.73 then 0.67, DK 3.94 then 2.28) take
--     the FIRST tier. The lower tier begins after thousands of kilometres a
--     year per employee, which an inspection trip does not reach.
--   * Ireland and France take a middle band rather than the top one: the top
--     band prices a large-engined car, and an inspector is not selected for
--     engine size.
--
-- Every row is guarded: an operator who already typed a rate for a country
-- keeps it. A migration may install a decision, never overwrite one.
INSERT INTO "country_tariff" (
  country_code, zone_id, "perKmCents", "returnTripFactor", derivation,
  "sourceRate", "sourceCurrency", "sourcePerMile", "fxRate", "fxDate",
  "sourceUrl", "effectiveFrom", "createdAt", "updatedAt"
) VALUES
  -- Single national figures, already in euro.
  ('AT','zone_pl_105_plus',   50, 2, 'TAX_RATE',   0.50,   'EUR', false, NULL,     NULL,
    'https://www.bmf.gv.at/', '2025-01-01', NOW(), NOW()),
  ('FI','zone_pl_105_plus',   55, 2, 'TAX_RATE',   0.55,   'EUR', false, NULL,     NULL,
    'https://www.vero.fi/', '2026-01-01', NOW(), NOW()),
  -- Belgium reviews the figure every 1 July and indexes it quarterly, so this
  -- row is the one most likely to be stale: 0.4449 applied until 30.06.2026.
  ('BE','zone_pl_90_105',     48, 2, 'TAX_RATE',   0.4761, 'EUR', false, NULL,     NULL,
    'https://www.ejustice.just.fgov.be/', '2026-07-01', NOW(), NOW()),
  ('NL','zone_pl_90_105',     25, 2, 'TAX_RATE',   0.25,   'EUR', false, NULL,     NULL,
    'https://www.belastingdienst.nl/', '2026-01-01', NOW(), NOW()),
  ('PT','zone_pl_75_90',      40, 2, 'TAX_RATE',   0.40,   'EUR', false, NULL,     NULL,
    'https://info.portaldasfinancas.gov.pt/', '2025-01-01', NOW(), NOW()),
  ('EE','zone_pl_60_75',      37, 2, 'TAX_RATE',   0.37,   'EUR', false, NULL,     NULL,
    'https://www.emta.ee/', '2025-01-01', NOW(), NOW()),

  -- Single national figures in another currency.
  ('DK','zone_pl_105_plus',   53, 2, 'TAX_RATE',   3.94,   'DKK', false, 7.4758,   '2026-08-12',
    'https://skat.dk/', '2026-01-01', NOW(), NOW()),
  ('SE','zone_pl_105_plus',   23, 2, 'TAX_RATE',   2.50,   'SEK', false, 10.9965,  '2026-08-12',
    'https://www.skatteverket.se/', '2026-01-01', NOW(), NOW()),
  ('CH','zone_pl_105_plus',   80, 2, 'TAX_RATE',   0.75,   'CHF', false, 0.9366,   '2026-08-12',
    'https://www.estv.admin.ch/', '2026-01-01', NOW(), NOW()),
  ('CA','zone_pl_105_plus',   45, 2, 'TAX_RATE',   0.73,   'CAD', false, 1.6077,   '2026-08-12',
    'https://www.canada.ca/en/revenue-agency.html', '2026-01-01', NOW(), NOW()),

  -- Per MILE. 55p and 76c are miles, not kilometres.
  -- 0.55 GBP / 0.85358 = 0.6444 EUR per mile / 1.609344 = 0.4004 EUR per km.
  ('GB','zone_pl_90_105',     40, 2, 'TAX_RATE',   0.55,   'GBP', true,  0.85358,  '2026-08-12',
    'https://www.gov.uk/government/publications/rates-and-allowances-travel-mileage-and-fuel-allowances',
    '2026-04-06', NOW(), NOW()),
  -- 0.76 USD / 1.1545 = 0.6583 EUR per mile / 1.609344 = 0.4091 EUR per km.
  ('US','zone_pl_105_plus',   41, 2, 'TAX_RATE',   0.76,   'USD', true,  1.1545,   '2026-08-12',
    'https://www.irs.gov/tax-professionals/standard-mileage-rates', '2026-07-01', NOW(), NOW()),

  -- A TABLE, not a rate. One figure standing in for it, named as such.
  -- France: 5 CV, the 2001-10000 km band. Ireland: 1501-2000 cc, first band.
  -- Italy: ACI, a mid-segment car — the weakest number in this migration, and
  -- the first that should be replaced by a real per-model lookup.
  ('FR','zone_pl_90_105',     40, 2, 'REPRESENTATIVE', 0.40, 'EUR', false, NULL,   NULL,
    'https://www.impots.gouv.fr/', '2026-01-01', NOW(), NOW()),
  ('IE','zone_pl_105_plus',   55, 2, 'REPRESENTATIVE', 0.55, 'EUR', false, NULL,   NULL,
    'https://www.revenue.ie/', '2025-09-01', NOW(), NOW()),
  ('IT','zone_pl_75_90',      50, 2, 'REPRESENTATIVE', 0.50, 'EUR', false, NULL,   NULL,
    'https://www.aci.it/', '2026-01-01', NOW(), NOW()),

  -- Basic amortisation PLUS fuel by receipt. Stored figure is the whole
  -- construction at the August 2026 pump price and 8 l/100 km.
  -- CZ: 5.60 + 1.74 EUR/l x 24.254 x 0.08 = 8.98 CZK/km.
  ('CZ','zone_pl_60_75',      37, 2, 'REPRESENTATIVE', 8.98, 'CZK', false, 24.254, '2026-08-12',
    'https://www.mpsv.cz/', '2026-01-01', NOW(), NOW()),
  -- SK: 0.193 + 1.76 x 0.08 = 0.33 EUR/km.
  ('SK','zone_pl_60_75',      33, 2, 'REPRESENTATIVE', 0.33, 'EUR', false, NULL,   NULL,
    'https://www.mpsvr.sk/', '2026-01-01', NOW(), NOW()),
  -- HU: 9 + 1.65 EUR/l x 364.10 x 0.08 = 57.06 HUF/km. The published 9 HUF is
  -- 2.5 cents on its own and pays for nothing.
  ('HU','zone_pl_60_75',      16, 2, 'REPRESENTATIVE', 57.06,'HUF', false, 364.10, '2026-08-12',
    'https://nav.gov.hu/', '2026-01-01', NOW(), NOW()),

  -- Nothing published at all. Same method as Ukraine: fuel x consumption x a
  -- wear factor. 1.80 EUR/l x 0.08 x 1.5 = 0.216 EUR/km.
  ('RO','zone_pl_under_60',   22, 2, 'FUEL_DERIVED',  0.216,'EUR', false, NULL,    NULL,
    'https://www.anaf.ro/', '2026-08-12', NOW(), NOW())
ON CONFLICT (country_code) DO UPDATE SET
  "perKmCents"       = EXCLUDED."perKmCents",
  "returnTripFactor" = EXCLUDED."returnTripFactor",
  derivation         = EXCLUDED.derivation,
  "sourceRate"       = EXCLUDED."sourceRate",
  "sourceCurrency"   = EXCLUDED."sourceCurrency",
  "sourcePerMile"    = EXCLUDED."sourcePerMile",
  "fxRate"           = EXCLUDED."fxRate",
  "fxDate"           = EXCLUDED."fxDate",
  "sourceUrl"        = EXCLUDED."sourceUrl",
  "effectiveFrom"    = EXCLUDED."effectiveFrom",
  "updatedAt"        = NOW()
WHERE "country_tariff"."perKmCents" IS NULL;
