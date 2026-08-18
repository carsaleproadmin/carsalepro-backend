-- Let an inspector be onboarded anywhere, as any kind of business.
--
-- `StripeService.createConnectedAccount` hardcoded `country: 'DE'` and
-- `business_type: 'individual'`, so the platform could onboard exactly one
-- population: a German sole trader or private individual. A GmbH, an OÜ or a
-- Polish company could not be paid out at all — Express onboarding never
-- offered them the company form, because the account already claimed to be a
-- natural person.
--
-- Both facts now come from the inspector and are recorded here.
--
-- COUNTRY is the load-bearing one: Stripe fixes an account's country at
-- creation and has no API to change it, so a stored value is what makes a
-- later, different request refusable (`connect_country_locked`) rather than a
-- silent second account in the wrong country. Kept as ISO 3166-1 alpha-2 upper
-- case, unconstrained by a check: which countries Stripe supports is Stripe's
-- answer at the moment of the call, not a list to go stale in our schema.
--
-- BUSINESS TYPE is nullable and stays nullable on purpose. Null means "the
-- inspector has not said", and Express onboarding then asks them — which is
-- freer than any default we could pick.

ALTER TABLE "inspector_profile"
  ADD COLUMN "stripe_country" TEXT,
  ADD COLUMN "stripe_business_type" TEXT;

-- Backfill what the code actually sent for every account that already exists.
-- These are not guesses: until this migration every connected account was
-- created with country DE and business_type individual. Leaving them null
-- would make the country lock meaningless for precisely the accounts it
-- protects — a stored null reads as "no country chosen", so a request naming
-- FR would pass the check and then fail at Stripe, where the account is German
-- and always will be.
UPDATE "inspector_profile"
SET "stripe_country" = 'DE', "stripe_business_type" = 'individual'
WHERE "stripe_account_id" IS NOT NULL;
