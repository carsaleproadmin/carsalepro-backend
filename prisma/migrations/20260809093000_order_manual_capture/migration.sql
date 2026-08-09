-- Authorize now, capture when an inspector accepts (the ride-hailing model).
--
-- Until now the customer's card was CHARGED the moment the order was created,
-- before anyone had agreed to do the work. If nobody accepted, the platform was
-- holding real money and owed a refund. Stripe's manual capture expresses this
-- properly: the funds are held, and taken only when the job is actually assigned.
--
-- No OrderStatus is added. `PAID` already means "the customer's money is
-- committed"; whether it is held or taken is a PAYMENT fact and lives here.

-- 1 ── the search window ------------------------------------------------------

ALTER TABLE "order" ADD COLUMN "search_expires_at" TIMESTAMP(3);

-- Deliberately NOT backfilled. An order created before this deploy was charged
-- outright, so there is no hold to release; a non-null deadline would make the
-- expiry cron try to cancel a PaymentIntent that has already been captured.
-- NULL is the flag that means "leave this one alone", and it is load-bearing.

CREATE INDEX "order_status_search_expires_at_idx"
  ON "order" ("status", "search_expires_at");

-- 2 ── payment money-state timestamps ----------------------------------------

ALTER TABLE "payment"
  ADD COLUMN "authorized_at" TIMESTAMP(3),
  ADD COLUMN "captured_at"   TIMESTAMP(3),
  ADD COLUMN "canceled_at"   TIMESTAMP(3);

-- Every payment that already succeeded was captured at creation time. Without
-- this, an old charge is indistinguishable from a fresh uncaptured hold and the
-- reconciler would go asking Stripe to capture money it already has.
UPDATE "payment" SET "captured_at" = "createdAt" WHERE "status" = 'succeeded';

CREATE INDEX "payment_status_createdAt_idx" ON "payment" ("status", "createdAt");

-- 3 ── how long to look for an inspector -------------------------------------

-- Six hours. The constraint at the top end is Stripe: an uncaptured
-- authorization expires after 7 days, and letting a hold sit anywhere near that
-- would strand the customer's money. The constraint at the bottom end is
-- coverage: too short and orders in thin regions fail that could have been
-- filled. This is a product number and is meant to be tuned from the admin
-- panel once real fill times exist.
INSERT INTO "platform_setting" (key, value, updated_by, "updatedAt") VALUES
  ('orderSearchWindowMinutes', to_jsonb(360::numeric), 'migration:manual-capture', now())
ON CONFLICT (key) DO NOTHING;
