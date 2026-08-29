-- DEN-213. The inspector's own base fee, and the price an offer was made at.
--
-- Both additive and both NULLABLE. Null is "has not said": an inspector with no
-- stated fee is priced on the platform base, exactly as before this migration,
-- and an offer written before this column existed falls back to the order total.
-- A DEFAULT here would invent a number for every existing inspector.
ALTER TABLE "inspector_profile" ADD COLUMN "base_fee_cents" INTEGER;

ALTER TABLE "order_offer" ADD COLUMN "price_cents" INTEGER;
ALTER TABLE "order_offer" ADD COLUMN "platform_fee_cents" INTEGER;
ALTER TABLE "order_offer" ADD COLUMN "inspector_share_cents" INTEGER;
