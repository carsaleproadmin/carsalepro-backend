-- DEN-326: offer an unfilled order again, in rounds.
--
-- `order.dispatch_round` is the pass the order is on; `order_offer.round` is
-- the pass an offer belonged to. Together they let dispatch say "already asked"
-- about THIS round rather than about all time, so an inspector who never
-- answered is asked again on the next pass while one who DECLINED never is.
--
-- Both default to 0, which is the first round, so every existing order and
-- offer reads correctly with no backfill.
--
-- The three PostGIS GIST indexes that `prisma migrate diff` proposes to drop on
-- every run are NOT dropped here, and the unrelated listing index rename is not
-- carried either.

ALTER TABLE "order" ADD COLUMN "dispatch_round" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "order_offer" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 0;
