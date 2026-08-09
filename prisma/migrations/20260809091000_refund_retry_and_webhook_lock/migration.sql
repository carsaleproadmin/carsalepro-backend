-- Money that fails must become a task, not an exception.
--
-- Three independent defects share this migration because they share one theme:
-- the ledger recorded intent as if it were outcome.
--
-- 1. `refund` had no retry state and `stripe_refund_id` was NOT NULL, so the row
--    could only be written AFTER Stripe accepted. A rejected refund therefore
--    threw out of `cancel()` with no trace: the order kept its old status, the
--    money stayed taken, and the customer saw a 500. Retry state mirrors
--    `payout`, which already solved this.
--
-- 2. `stripe_webhook_event` was written only after successful handling. That
--    makes a REPLAY idempotent but does nothing about two concurrent deliveries
--    of the same event — both find no row, both run the handler.
--
-- 3. `report_purchase` had no way to express "refunded", and the
--    `(user_id, report_id)` unique means the row cannot simply be deleted.
--
-- The duplicate check that must precede the new unique index (returned 0 on
-- both the dev and the test database):
--   SELECT order_id, reason, count(*) FROM refund
--   WHERE order_id IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;

-- 1 ── refund: retry state, and a nullable provider id -----------------------

ALTER TABLE "refund" ALTER COLUMN "stripe_refund_id" DROP NOT NULL;

ALTER TABLE "refund"
  ADD COLUMN "status"          TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "attempts"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_error"      TEXT,
  ADD COLUMN "last_attempt_at" TIMESTAMP(3),
  ADD COLUMN "next_retry_at"   TIMESTAMP(3);

-- Every row that exists today got its id from Stripe, so it succeeded.
UPDATE "refund" SET "status" = 'succeeded' WHERE "stripe_refund_id" IS NOT NULL;

-- Postgres treats NULLs as distinct, so non-order refunds (a VIN history whose
-- provider failed after capture) are unconstrained by this — which is right:
-- they key off `payment_id`, which is already unique.
CREATE UNIQUE INDEX "refund_order_id_reason_key" ON "refund" ("order_id", "reason");
CREATE INDEX "refund_status_next_retry_at_idx" ON "refund" ("status", "next_retry_at");

-- 2 ── stripe_webhook_event: claim before handling ---------------------------

ALTER TABLE "stripe_webhook_event"
  ADD COLUMN "status"     TEXT NOT NULL DEFAULT 'processed',
  ADD COLUMN "attempts"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "claimed_at" TIMESTAMP(3);

-- The default is 'processed' on purpose: every existing row was written by the
-- old code path, which inserted only after the handler returned.

CREATE INDEX "stripe_webhook_event_status_claimed_at_idx"
  ON "stripe_webhook_event" ("status", "claimed_at");

-- 3 ── report_purchase: revocable pay-per-view access ------------------------

ALTER TABLE "report_purchase"
  ADD COLUMN "revoked_at"     TIMESTAMP(3),
  ADD COLUMN "revoked_reason" TEXT;
