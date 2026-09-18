-- DEN-350: counter-offers queue by price instead of racing for one slot.
--
-- Before this, an order had ONE active counter-offer and the fastest inspector
-- took it: 90 EUR beat 55 EUR whenever 90 pressed the button first, and the
-- customer never learned the cheaper price existed. Many prices may now wait at
-- once; exactly one of them is in front of the customer, and the next is shown
-- only when that one is answered.

ALTER TABLE "order_counter_offer" ADD COLUMN "presented_at" TIMESTAMP(3);

-- Every offer that was active under the old rule WAS the one on the customer's
-- screen, so it is presented, and its answer window already started. Using
-- created_at rather than now() keeps the deadline these rows already carry in
-- `expires_at` consistent with the column that now explains it.
UPDATE "order_counter_offer"
   SET "presented_at" = "createdAt"
 WHERE "status" IN ('PENDING', 'ACCEPTING');

-- The old rule refused a second PENDING row outright, which is exactly the
-- queue. It goes.
DROP INDEX "order_counter_offer_active_unique";

-- What survives it: one PRESENTED price per order. Queued rows (PENDING with a
-- null presented_at) are unconstrained and may be many; a promotion that races
-- another promotion loses here rather than putting two prices on one screen.
-- Prisma cannot model a partial index, so this is hand-written and is proposed
-- for dropping by `migrate diff` on every later run, like the GIST indexes.
-- Strip that line before committing.
CREATE UNIQUE INDEX "order_counter_offer_presented_unique"
  ON "order_counter_offer"("order_id")
  WHERE "status" = 'ACCEPTING'
     OR ("status" = 'PENDING' AND "presented_at" IS NOT NULL);

-- The queue read: cheapest PENDING first, per order.
CREATE INDEX "order_counter_offer_order_id_status_price_cents_idx"
  ON "order_counter_offer"("order_id", "status", "price_cents");
