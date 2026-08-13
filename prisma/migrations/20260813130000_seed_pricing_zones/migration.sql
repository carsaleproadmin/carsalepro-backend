-- The five price bands and a starter country map (DEN-108).
--
-- **The bands are named after the price level index, not after a region.** They
-- group countries by what an hour of expert time costs locally, so a
-- geographical name is a lie the moment the list grows: Chile belongs with
-- Spain, Japan with Germany, and Mexico four bands below Canada. A name that
-- states the membership rule cannot drift away from the contents. Germany is
-- the anchor: index 100, 39 EUR.
--
-- `minimum_fare_cents` moves with the base fee, at the shipped ratio 49/39.
-- Without it a band whose base fee is 19 EUR still charges 49 EUR on every
-- short job, because the floor binds first — the whole regional decision would
-- have no effect on the price anybody pays.
--
-- Only `baseFeeCents` and `minimumFareCents` are set. The per-km rate stays
-- null on purpose: it comes from the national tax-free mileage rate, which is a
-- per-COUNTRY figure and not a band-wide one, and no country rate is filled yet.
INSERT INTO "pricing_zone" (id, key, name, "baseFeeCents", "minimumFareCents", "createdAt", "updatedAt")
VALUES
  ('zone_pl_105_plus',    'pl_105_plus',     'Price level 105+',      4500, 5700, NOW(), NOW()),
  -- The anchor band deliberately sets NO money. Its numbers ARE the global
  -- tariff, and a band that restates a global value silently
  -- disables the global lever: an operator raising `orderBaseFeeEur` from the
  -- admin panel would see no change in Germany, because the more specific level
  -- wins. Null means "ask the next level", which is the whole point of the
  -- field-by-field resolution.
  ('zone_pl_90_105', 'pl_90_105',       'Price level 90-105 (anchor)',   NULL, NULL, NOW(), NOW()),
  ('zone_pl_75_90','pl_75_90',        'Price level 75-90',  3300, 4100, NOW(), NOW()),
  ('zone_pl_60_75', 'pl_60_75',        'Price level 60-75',   2700, 3400, NOW(), NOW()),
  ('zone_pl_under_60',       'pl_under_60',     'Price level below 60', 1900, 2400, NOW(), NOW())
ON CONFLICT (key) DO NOTHING;

-- A country is listed only when its band differs from the global default, or
-- when we already work there. Everything unlisted resolves to the global
-- tariff, which never refuses an order — so this list is grown on demand, one
-- row per country that turns out to need one, and never needs to cover the
-- world.
--
-- Russia and Belarus are left out deliberately, and not over price: Stripe
-- Connect makes no payouts there, so the inspector could not be paid. Serving
-- them is a payout problem, not a tariff row.
INSERT INTO "country_tariff" (country_code, zone_id, "sourcePerMile", "createdAt", "updatedAt")
VALUES
  ('CH','zone_pl_105_plus',false,NOW(),NOW()),
  ('NO','zone_pl_105_plus',false,NOW(),NOW()),
  ('IS','zone_pl_105_plus',false,NOW(),NOW()),
  ('DK','zone_pl_105_plus',false,NOW(),NOW()),
  ('SE','zone_pl_105_plus',false,NOW(),NOW()),
  ('FI','zone_pl_105_plus',false,NOW(),NOW()),
  ('IE','zone_pl_105_plus',false,NOW(),NOW()),
  ('LU','zone_pl_105_plus',false,NOW(),NOW()),
  ('AT','zone_pl_105_plus',false,NOW(),NOW()),
  ('US','zone_pl_105_plus',false,NOW(),NOW()),
  ('CA','zone_pl_105_plus',false,NOW(),NOW()),
  ('AU','zone_pl_105_plus',false,NOW(),NOW()),

  ('DE','zone_pl_90_105',false,NOW(),NOW()),
  ('FR','zone_pl_90_105',false,NOW(),NOW()),
  ('NL','zone_pl_90_105',false,NOW(),NOW()),
  ('BE','zone_pl_90_105',false,NOW(),NOW()),
  ('GB','zone_pl_90_105',false,NOW(),NOW()),
  ('JP','zone_pl_90_105',false,NOW(),NOW()),

  ('ES','zone_pl_75_90',false,NOW(),NOW()),
  ('IT','zone_pl_75_90',false,NOW(),NOW()),
  ('PT','zone_pl_75_90',false,NOW(),NOW()),
  ('GR','zone_pl_75_90',false,NOW(),NOW()),
  ('CY','zone_pl_75_90',false,NOW(),NOW()),
  ('MT','zone_pl_75_90',false,NOW(),NOW()),
  ('SI','zone_pl_75_90',false,NOW(),NOW()),

  ('PL','zone_pl_60_75',false,NOW(),NOW()),
  ('CZ','zone_pl_60_75',false,NOW(),NOW()),
  ('SK','zone_pl_60_75',false,NOW(),NOW()),
  ('HU','zone_pl_60_75',false,NOW(),NOW()),
  ('HR','zone_pl_60_75',false,NOW(),NOW()),
  ('EE','zone_pl_60_75',false,NOW(),NOW()),
  ('LV','zone_pl_60_75',false,NOW(),NOW()),
  ('LT','zone_pl_60_75',false,NOW(),NOW()),

  ('UA','zone_pl_under_60',false,NOW(),NOW()),
  ('RO','zone_pl_under_60',false,NOW(),NOW()),
  ('BG','zone_pl_under_60',false,NOW(),NOW()),
  ('RS','zone_pl_under_60',false,NOW(),NOW()),
  ('BA','zone_pl_under_60',false,NOW(),NOW()),
  ('MD','zone_pl_under_60',false,NOW(),NOW()),
  ('TR','zone_pl_under_60',false,NOW(),NOW()),
  ('MX','zone_pl_under_60',false,NOW(),NOW()),
  ('BR','zone_pl_under_60',false,NOW(),NOW()),
  ('AR','zone_pl_under_60',false,NOW(),NOW()),
  ('ZA','zone_pl_under_60',false,NOW(),NOW()),
  ('SG','zone_pl_105_plus',false,NOW(),NOW()),
  ('IL','zone_pl_105_plus',false,NOW(),NOW()),
  ('NZ','zone_pl_105_plus',false,NOW(),NOW()),
  ('HK','zone_pl_105_plus',false,NOW(),NOW()),

  ('KR','zone_pl_90_105',false,NOW(),NOW()),
  ('TW','zone_pl_90_105',false,NOW(),NOW()),

  ('AE','zone_pl_75_90',false,NOW(),NOW()),
  ('SA','zone_pl_75_90',false,NOW(),NOW()),
  ('CL','zone_pl_75_90',false,NOW(),NOW()),
  ('UY','zone_pl_75_90',false,NOW(),NOW()),

  ('CN','zone_pl_60_75',false,NOW(),NOW()),
  ('MY','zone_pl_60_75',false,NOW(),NOW()),
  ('CR','zone_pl_60_75',false,NOW(),NOW()),
  ('PA','zone_pl_60_75',false,NOW(),NOW()),
  ('ME','zone_pl_60_75',false,NOW(),NOW()),
  ('AL','zone_pl_60_75',false,NOW(),NOW()),
  ('MK','zone_pl_60_75',false,NOW(),NOW()),
  ('GE','zone_pl_60_75',false,NOW(),NOW()),

  ('TH','zone_pl_under_60',false,NOW(),NOW()),
  ('VN','zone_pl_under_60',false,NOW(),NOW()),
  ('ID','zone_pl_under_60',false,NOW(),NOW()),
  ('PH','zone_pl_under_60',false,NOW(),NOW()),
  ('CO','zone_pl_under_60',false,NOW(),NOW()),
  ('PE','zone_pl_under_60',false,NOW(),NOW()),
  ('EC','zone_pl_under_60',false,NOW(),NOW()),
  ('EG','zone_pl_under_60',false,NOW(),NOW()),
  ('MA','zone_pl_under_60',false,NOW(),NOW()),
  ('NG','zone_pl_under_60',false,NOW(),NOW()),
  ('KE','zone_pl_under_60',false,NOW(),NOW()),
  ('AM','zone_pl_under_60',false,NOW(),NOW()),
  ('AZ','zone_pl_under_60',false,NOW(),NOW()),
  ('KZ','zone_pl_under_60',false,NOW(),NOW()),
  ('UZ','zone_pl_under_60',false,NOW(),NOW()),
  ('IN','zone_pl_under_60',false,NOW(),NOW())
ON CONFLICT (country_code) DO NOTHING;
