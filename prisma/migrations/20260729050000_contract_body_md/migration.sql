-- Freeze the placeholder-substituted markdown alongside the rendered HTML.
--
-- The PDF renderer needs the same source string the HTML was produced from.
-- Re-deriving it would mean re-substituting placeholders from current order
-- data, which can have moved on since the contract was signed — a legal
-- document must not quietly change when it is re-rendered.
--
-- Nullable because contracts created before this column exist and only have
-- their HTML; those fall back to a re-substitution and are logged as such.

ALTER TABLE "order_contract" ADD COLUMN "body_md" TEXT;
