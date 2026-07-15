-- Report sync v2: structured payload versioning + server-compressed photos.
-- (GIST indexes on PostGIS columns are intentionally untouched — Prisma cannot
-- model them, so `migrate diff` always proposes dropping them; never do.)

-- AlterTable
ALTER TABLE "report" ADD COLUMN     "finished_at" TIMESTAMP(3),
ADD COLUMN     "report_schema_version" INTEGER,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "report_photo" (
    "id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "r2_key" TEXT NOT NULL,
    "public_url" TEXT,
    "size_bytes" INTEGER NOT NULL,
    "source_bytes" INTEGER,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'jpeg',
    "hash" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_photo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_photo_r2_key_key" ON "report_photo"("r2_key");

-- CreateIndex
CREATE INDEX "report_photo_report_id_idx" ON "report_photo"("report_id");

-- CreateIndex
CREATE UNIQUE INDEX "report_photo_report_id_kind_position_key" ON "report_photo"("report_id", "kind", "position");

-- AddForeignKey
ALTER TABLE "report_photo" ADD CONSTRAINT "report_photo_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Global uniqueness for NEW UUID-format report codes only. Legacy CSP-###
-- codes may legitimately collide across devices and stay legal. Soft-deleted
-- rows are excluded so delete-then-re-upload of the same inspection works.
-- (Partial index — Prisma cannot model it; kept in raw SQL like the GIST ones.)
CREATE UNIQUE INDEX "report_code_uuid_unique" ON "report" ("code")
WHERE "code" ~* '^CSP-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND "deleted_at" IS NULL;
