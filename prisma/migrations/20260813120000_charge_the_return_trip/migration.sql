-- Charge the trip in BOTH directions, at the German tax-free mileage rate.
--
-- The two statements are one decision and must not be separated. The per-km
-- rate was an invented 0.60 charged on the one-direction distance; it becomes a
-- published 0.30 (Kilometerpauschale, §9 Abs. 1 Nr. 4a EStG) charged on the
-- distance actually driven. 0.30 x 2 = 0.60, so the kilometre charge does not
-- move — it only becomes a number a customer can check against the tax code.
-- Applying either statement alone changes every fare by a factor of two.
--
-- Both are guarded on the OLD value. An operator who has already retuned a rate
-- from the admin panel keeps their number: this migration corrects the shipped
-- tariff, and must never overwrite a deliberate local decision.
--
-- Editing PLATFORM_SETTING_DEFAULTS alone would do nothing here — `seed.ts`
-- upserts with `update: {}` and Render runs `migrate deploy`, never the seed.
-- See DEN-108.
UPDATE "platform_setting"
   SET value = '0.3'::jsonb
 WHERE key = 'orderRatePerKmEur'
   AND value::text = '0.6';

INSERT INTO "platform_setting" (key, value, "updatedAt")
VALUES ('orderReturnTripFactor', '2'::jsonb, NOW())
ON CONFLICT (key) DO UPDATE
   SET value = '2'::jsonb
 WHERE "platform_setting".value::text = '1';
