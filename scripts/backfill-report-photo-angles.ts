/**
 * Backfill: rewrite `report.photos_manifest` in walk-around order, with `angle`.
 *
 *   npx ts-node scripts/backfill-report-photo-angles.ts --dry-run
 *   npx ts-node scripts/backfill-report-photo-angles.ts --limit=500
 *   npx ts-node scripts/backfill-report-photo-angles.ts --report=<id>
 *
 * Until 2026-08-10 the manifest was written `ORDER BY kind ASC`. That is
 * alphabetical, and `checklist-` and `damage-` sort ahead of `exterior-`, so a
 * well-documented inspection produced a showroom gallery of scratch macros with
 * the car itself pushed past the display limit. The write path now sorts by the
 * catalog's own walk-around and records the bare catalog `angle` beside `kind`.
 *
 * The READ path (`manifestPhotoRefs`) applies the same sort and derives the same
 * `angle`, so every existing listing renders correctly the moment the backend
 * deploys — this script is NOT needed for correctness. What it is needed for:
 *
 *   1. The mirrored PUBLIC-BUCKET subset is "the first MAX_LISTING_PHOTOS
 *      entries", and both the order and the cap (20 -> 32) have changed. A
 *      listing already stamped `public_photos_mirrored_at` serves URLs
 *      recomputed from the current manifest, and for any report whose top-N
 *      moved, those objects were never written: broken images on a live advert.
 *      Pass 2 clears the stamp so the read path falls back to signed URLs
 *      (correct, temporary) and the mirror job re-copies under the new order.
 *   2. Making the stored data match what the code writes, so the next person to
 *      read a manifest by hand is not looking at two different formats.
 *
 * Rules, in order of importance:
 *   1. It DELETES nothing and it uploads nothing. It rewrites one JSON column
 *      and nulls one timestamp.
 *   2. Idempotent: a manifest that already matches is skipped, so a re-run is a
 *      no-op and an interrupted run simply resumes.
 *   3. Batched, because this is a table scan on production.
 *   4. It never prints a device id, a report code or an R2 key — the keys embed
 *      the device id, which is what `mirroredPhotoKey` hashes them for.
 *
 * Flags:
 *   --dry-run       report what would change, write nothing (recommended first)
 *   --limit=N       stop after N reports examined
 *   --batch=N       reports fetched per chunk (default 200)
 *   --report=<id>   only this report
 */
import { Prisma, PrismaClient } from '@prisma/client';

import { angleForKind, comparePhotoKinds } from '../src/catalog/catalog-photo-order';
import { flag, loadEnv, option } from './lib/script-env';

loadEnv();

const DRY_RUN = flag('dry-run');
const LIMIT = Number(option('limit', '0')) || Number.POSITIVE_INFINITY;
const BATCH = Math.max(1, Number(option('batch', '200')) || 200);
const ONLY_REPORT = option('report', '');

interface ManifestEntry {
  s3Key: string;
  kind?: string;
  angle?: string;
}

/** The canonical manifest for a stored one, or null when it is already right. */
function rewrite(manifest: Prisma.JsonValue | null): ManifestEntry[] | null {
  if (!Array.isArray(manifest)) return null;

  const entries: ManifestEntry[] = [];
  for (const raw of manifest) {
    if (!raw || typeof raw !== 'object') continue;
    const ref = raw as Partial<ManifestEntry>;
    if (typeof ref.s3Key !== 'string' || ref.s3Key.length === 0) continue;
    const kind = typeof ref.kind === 'string' ? ref.kind : undefined;
    const angle = angleForKind(kind);
    entries.push({ s3Key: ref.s3Key, ...(kind ? { kind } : {}), ...(angle ? { angle } : {}) });
  }
  entries.sort((a, b) => comparePhotoKinds(a.kind, b.kind));

  // Compare against what is stored, key order included: an identical result
  // means nothing to write, and that is what makes a re-run free.
  if (JSON.stringify(entries) === JSON.stringify(manifest)) return null;
  return entries;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let examined = 0;
  let rewritten = 0;
  let unmirrored = 0;
  let cursor: string | undefined;

  console.log(
    `${DRY_RUN ? '[dry run] ' : ''}backfilling report photo manifests ` +
      `(batch ${BATCH}${Number.isFinite(LIMIT) ? `, limit ${LIMIT}` : ''})`,
  );

  try {
    for (;;) {
      const reports = await prisma.report.findMany({
        where: {
          photosManifest: { not: Prisma.DbNull },
          ...(ONLY_REPORT ? { id: ONLY_REPORT } : {}),
        },
        select: { id: true, photosManifest: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (reports.length === 0) break;
      cursor = reports[reports.length - 1].id;

      for (const report of reports) {
        if (examined >= LIMIT) break;
        examined += 1;

        const next = rewrite(report.photosManifest);
        if (next === null) continue;
        rewritten += 1;

        if (DRY_RUN) {
          console.log(`  would rewrite ${report.id} (${next.length} entries)`);
        } else {
          await prisma.report.update({
            where: { id: report.id },
            data: { photosManifest: next as unknown as Prisma.InputJsonValue },
          });
        }

        // Pass 2: any listing backed by this report is now serving mirrored
        // URLs computed from a manifest whose top-N has moved. Clearing the
        // stamp is what re-queues it; the read path falls back to signed URLs
        // in the meantime, which is exactly the recovery `mirrorPhotosManifest`
        // already performs after a photo re-upload.
        if (DRY_RUN) {
          const pending = await prisma.listing.count({
            where: { reportId: report.id, publicPhotosMirroredAt: { not: null } },
          });
          unmirrored += pending;
        } else {
          const { count } = await prisma.listing.updateMany({
            where: { reportId: report.id, publicPhotosMirroredAt: { not: null } },
            data: { publicPhotosMirroredAt: null },
          });
          unmirrored += count;
        }
      }

      if (examined >= LIMIT || ONLY_REPORT) break;
    }

    console.log(
      `${DRY_RUN ? '[dry run] ' : ''}examined ${examined}, rewritten ${rewritten}, ` +
        `listings re-queued for mirroring ${unmirrored}`,
    );
    if (!DRY_RUN && unmirrored > 0) {
      console.log(
        'Those listings serve signed URLs until the mirror job runs. Trigger it, ' +
          'or wait for the nightly pass.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
