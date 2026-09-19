-- DEN-344, correction to `payment_active_order_unique`.
--
-- The first version said "one payment row per order that is not superseded".
-- That is wrong for the state it was written for: while a customer pays for a
-- counter-offer, the order legitimately carries TWO rows - the original hold,
-- which must stay live until the replacement holds real money, and the pending
-- replacement. The index refused the second one, so accepting a counter-offer
-- failed with a unique violation.
--
-- The invariant that is actually true is about money, not rows: an order has at
-- most one payment that HOLDS OR HAS TAKEN money. A 'pending' row holds nothing
-- - it is a PaymentIntent the customer has not confirmed - and a 'failed' or
-- 'cancelled' one holds nothing any more.
DROP INDEX "payment_active_order_unique";

CREATE UNIQUE INDEX "payment_active_order_unique"
  ON "payment"("order_id")
  WHERE "order_id" IS NOT NULL
    AND "superseded_at" IS NULL
    AND "status" IN ('authorized', 'succeeded');
