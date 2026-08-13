-- A purchased VIN history becomes a link the buyer can hand to someone else.
--
-- Until now a paid report could only be read by the account that bought it. That
-- is the wrong shape for what the report is FOR: a buyer checks a car in order to
-- show the answer to the seller, to a garage, or to whoever is lending them the
-- money. Emailing a PDF works once; a link stays correct.
--
-- The token is NULLABLE and starts null, so sharing is off until the owner asks
-- for it, and revoking is setting it back to null. That is the whole lifetime,
-- and it belongs to the owner rather than to us.
--
-- It is UNIQUE because it is the only lookup key on a public, unauthenticated
-- route — the index is what makes that lookup a single row rather than a scan,
-- and what makes a collision impossible rather than merely unlikely. The value
-- itself is minted from a cryptographic random source in the service; the column
-- only guarantees that two purchases can never share one.
--
-- `share_token_created_at` exists so the age of a link is answerable. Nothing
-- expires today — an expiry that surprises the person the link was given to is
-- worse than no expiry — but a link that has been public for a year is a fact
-- the owner should be able to see before deciding to keep it.

ALTER TABLE "vin_history_purchase"
  ADD COLUMN "share_token"            TEXT,
  ADD COLUMN "share_token_created_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "vin_history_purchase_share_token_key"
  ON "vin_history_purchase" ("share_token");

-- How long we remember that a VIN has no records.
--
-- The data provider bills the same for a record-less answer as for a full one,
-- and nothing used to remember the empty one — so the same VIN paid that fee on
-- every attempt. `SettingsService` falls back to the compiled default when a row
-- is missing, so the behaviour is live either way, but a row that does not exist
-- cannot be seen or tuned in the admin panel.
--
-- Deliberately much shorter than `vinHistoryCacheDays`: a full report ages
-- slowly because the facts in it stay true, whereas "no records" is a statement
-- about the database on the day we asked and stops being true the first time the
-- car is titled or written off. Zero disables the negative cache.
INSERT INTO "platform_setting" (key, value, updated_by, "updatedAt") VALUES
  ('vinHistoryEmptyCacheDays', to_jsonb(7::numeric), 'migration:vin-history-share', now())
ON CONFLICT (key) DO NOTHING;
