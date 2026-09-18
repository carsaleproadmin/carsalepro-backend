-- DEN-344: counter-offers, and a payment history per order.
--
-- The three PostGIS GIST indexes that `prisma migrate diff` proposes to drop on
-- every run (inspector_profile_location_idx, order_location_idx,
-- waitlist_entry_location_idx) are deliberately NOT in this file.

-- An order may now carry more than one payment row: accepting a counter-offer
-- above the authorized sum creates a second PaymentIntent, because Stripe
-- captures less than an authorization and never more. The replaced row stays as
-- the record that a hold of the old amount existed and was released.
DROP INDEX "payment_order_id_key";

ALTER TABLE "payment" ADD COLUMN "superseded_at" TIMESTAMP(3);

CREATE INDEX "payment_order_id_idx" ON "payment"("order_id");

-- "One LIVE payment per order" survives the dropped unique constraint. Prisma
-- cannot model a partial index, so it is written here by hand - and is proposed
-- for dropping by `migrate diff` on every later run, exactly like the GIST
-- indexes above. Strip that line before committing.
CREATE UNIQUE INDEX "payment_active_order_unique"
  ON "payment"("order_id")
  WHERE "order_id" IS NOT NULL AND "superseded_at" IS NULL;

CREATE TABLE "order_counter_offer" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "inspector_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "price_cents" INTEGER NOT NULL,
    "platform_fee_cents" INTEGER NOT NULL,
    "inspector_share_cents" INTEGER NOT NULL,
    "max_price_cents" INTEGER NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "straight_line_km" DECIMAL(7,2) NOT NULL,
    "round" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepting_until" TIMESTAMP(3),
    "responded_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_counter_offer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_counter_offer_order_id_status_idx" ON "order_counter_offer"("order_id", "status");

CREATE INDEX "order_counter_offer_inspector_id_status_idx" ON "order_counter_offer"("inspector_id", "status");

CREATE UNIQUE INDEX "order_counter_offer_order_id_inspector_id_key" ON "order_counter_offer"("order_id", "inspector_id");

-- The rule the application cannot enforce: ONE active counter-offer per order.
-- Two inspectors who press the button in the same millisecond both pass any
-- check in the code, so the database has to be the one that refuses.
CREATE UNIQUE INDEX "order_counter_offer_active_unique"
  ON "order_counter_offer"("order_id")
  WHERE "status" IN ('PENDING', 'ACCEPTING');

ALTER TABLE "order_counter_offer" ADD CONSTRAINT "order_counter_offer_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_counter_offer" ADD CONSTRAINT "order_counter_offer_inspector_id_fkey" FOREIGN KEY ("inspector_id") REFERENCES "inspector_profile"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
