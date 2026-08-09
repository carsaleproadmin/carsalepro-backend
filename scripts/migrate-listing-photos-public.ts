/**
 * Backfill: give every existing showroom photo a PERMANENT public URL.
 *
 *   npx ts-node scripts/migrate-listing-photos-public.ts --dry-run
 *   npx ts-node scripts/migrate-listing-photos-public.ts --limit=200
 *   npx ts-node scripts/migrate-listing-photos-public.ts --listing=<id>
 *
 * Showroom images were served through 15-minute presigned URLs: a shared link
 * died, a crawler indexed an expired URL, and no CDN could cache anything. The
 * fix is a SEPARATE public bucket — publicity in R2 is a property of the bucket,
 * so exposing the `listings/` prefix of the reports bucket is not a thing that
 * exists, and exposing the bucket itself would publish the paid inspection PDFs
 * and the KYC objects sitting in it.
 *
 * New photos already land in the public bucket (`ListingsService.addPhoto`) and
 * newly-published listings are mirrored on publication. This script is for
 * everything that existed BEFORE that, in two passes:
 *
 *   A. seller-uploaded `listing_photo` rows with `bucket IS NULL` — the object is
 *      copied to the SAME key in the public bucket and the row is stamped;
 *   B. report-backed listings with `public_photos_mirrored_at IS NULL` — the
 *      showroom subset of `report.photos_manifest` is copied under the
 *      deterministic key `listings/<listingId>/m-<sha256(sourceKey)[0..16]>.jpg`
 *      (`mirroredPhotoKey`, shared with the runtime so the read path can
 *      recompute it), and the listing is stamped.
 *
 * Rules this script obeys, in order of importance:
 *
 *   1. IT DELETES NOTHING from the reports bucket. Not one object. Reclaiming
 *      that space is a separate, later pass once the public copies are proven —
 *      and until then the original is what makes a rollback (unset `R2_PUBLIC_*`)
 *      a silent return to signed URLs rather than an outage.
 *   2. The DB row is stamped only AFTER the destination object is verified with
 *      a HEAD, so a row can never claim a copy that is not there.
 *   3. Idempotent and resumable: a destination that already exists with the same
 *      size is skipped without re-transferring, and each row/listing records its
 *      own completion, so a re-run starts where the last one stopped.
 *   4. Batched. Every object is a download plus an upload; an unbounded sweep of
 *      the whole showroom is a self-inflicted R2 bill.
 *
 * Flags:
 *   --dry-run          log every action without copying or updating anything
 *   --limit=N          stop after N objects (a first cautious pass)
 *   --batch=N          rows fetched/processed per chunk (default 25)
 *   --listing=<id>     only this listing (both passes)
 *   --active-only      only ACTIVE listings (default: every non-DELETED one)
 */
import {
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { flag, loadEnv, option, requireEnv } from './lib/script-env';
import {
  MAX_LISTING_PHOTOS,
  manifestPhotoRefs,
  mirroredPhotoKey,
} from '../src/listings/listing-photo-urls';

/** Matches `R2Service.publicPutObject` — keys are immutable by construction. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

interface Stats {
  rowsScanned: number;
  rowsCopied: number;
  rowsSkipped: number;
  listingsScanned: number;
  mirrored: number;
  mirrorSkipped: number;
  listingsStamped: number;
  missingSources: number;
  failed: number;
}

interface Ctx {
  source: S3Client;
  sourceBucket: string;
  publicClient: S3Client;
  publicBucket: string;
  prisma: PrismaClient;
  dryRun: boolean;
  limit: number;
  stats: Stats;
}

async function main(): Promise<void> {
  loadEnv();

  const dryRun = flag('dry-run');
  const activeOnly = flag('active-only');
  const onlyListing = option('listing', '');
  const batch = Math.max(1, Number(option('batch', '25')) || 25);
  const limit = Number(option('limit', '0')) || Infinity;

  const accountId = requireEnv('R2_ACCOUNT_ID');
  const sourceBucket = requireEnv('R2_BUCKET');
  const publicBucket = requireEnv('R2_PUBLIC_BUCKET');
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

  // The whole point of the separation. A public bucket that IS the reports or
  // KYC bucket would publish every paid PDF and every identity document, and
  // this script would be the thing that did it.
  if (publicBucket === sourceBucket || publicBucket === process.env.R2_KYC_BUCKET) {
    console.error(
      `FATAL: R2_PUBLIC_BUCKET ("${publicBucket}") is the reports or KYC bucket. ` +
        'It must be a dedicated, separate bucket.',
    );
    process.exit(1);
  }
  if (!process.env.R2_PUBLIC_BASE_URL) {
    console.error(
      'FATAL: R2_PUBLIC_BASE_URL is not set. Copying objects the API cannot build ' +
        'URLs for would leave the showroom on signed URLs anyway.',
    );
    process.exit(1);
  }

  const source = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
  // A separate, narrowly-scoped token: the public bucket is written with
  // credentials that cannot read the reports bucket, which is also why this is a
  // download+upload rather than a cross-bucket CopyObject.
  const publicClient = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: requireEnv('R2_PUBLIC_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_PUBLIC_SECRET_ACCESS_KEY'),
    },
  });

  const prisma = new PrismaClient();
  const stats: Stats = {
    rowsScanned: 0,
    rowsCopied: 0,
    rowsSkipped: 0,
    listingsScanned: 0,
    mirrored: 0,
    mirrorSkipped: 0,
    listingsStamped: 0,
    missingSources: 0,
    failed: 0,
  };
  const ctx: Ctx = { source, sourceBucket, publicClient, publicBucket, prisma, dryRun, limit, stats };

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}Publishing listing photos ` +
      `${sourceBucket} → ${publicBucket} (endpoint ${endpoint})` +
      `${onlyListing ? `, listing=${onlyListing}` : ''}${activeOnly ? ', ACTIVE only' : ''}`,
  );

  try {
    await migrateUploadedPhotos(ctx, { batch, onlyListing, activeOnly });
    await mirrorReportListings(ctx, { batch, onlyListing, activeOnly });
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n--- summary ---');
  console.log(`rows scanned      ${stats.rowsScanned}`);
  console.log(`rows copied       ${stats.rowsCopied}`);
  console.log(`rows already done ${stats.rowsSkipped}`);
  console.log(`listings scanned  ${stats.listingsScanned}`);
  console.log(`photos mirrored   ${stats.mirrored}`);
  console.log(`mirrors skipped   ${stats.mirrorSkipped}`);
  console.log(`listings stamped  ${stats.listingsStamped}`);
  console.log(`missing sources   ${stats.missingSources}`);
  console.log(`failed            ${stats.failed}`);
  console.log('(nothing was deleted from the reports bucket — by design)');
  if (dryRun) console.log('\n(dry run — nothing was written or updated)');
  if (stats.failed > 0) process.exitCode = 1;
}

// ------------------------------------------------------------------
// Pass A — seller uploads (`listing_photo` rows)
// ------------------------------------------------------------------

async function migrateUploadedPhotos(
  ctx: Ctx,
  opts: { batch: number; onlyListing: string; activeOnly: boolean },
): Promise<void> {
  const { prisma, stats } = ctx;

  // Ids are collected up front rather than re-queried in a loop: a row whose
  // copy fails keeps `bucket = NULL`, so a "fetch the next page of NULLs" loop
  // would hand back the same failing row forever.
  const pending = await prisma.listingPhoto.findMany({
    where: {
      bucket: null,
      listing: {
        status: opts.activeOnly ? 'ACTIVE' : { not: 'DELETED' },
        ...(opts.onlyListing ? { id: opts.onlyListing } : {}),
      },
    },
    select: { id: true, r2Key: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\nPass A: ${pending.length} uploaded photo(s) still private`);

  for (let i = 0; i < pending.length; i += opts.batch) {
    for (const row of pending.slice(i, i + opts.batch)) {
      if (transferred(stats) >= ctx.limit) {
        console.log('  limit reached — stopping pass A');
        return;
      }
      stats.rowsScanned += 1;
      try {
        const outcome = await copyObject(ctx, row.r2Key, row.r2Key);
        if (outcome === 'missing') {
          console.log(`  MISS ${row.r2Key} (no source object — row left private)`);
          continue;
        }
        if (outcome === 'exists') stats.rowsSkipped += 1;
        else stats.rowsCopied += 1;

        if (ctx.dryRun) {
          console.log(`  DB   ${row.id} → bucket=${ctx.publicBucket} (skipped: dry run)`);
        } else {
          await prisma.listingPhoto.update({
            where: { id: row.id },
            data: { bucket: ctx.publicBucket },
          });
          console.log(`  ${outcome === 'exists' ? 'SKIP' : 'COPY'} ${row.r2Key} → public`);
        }
      } catch (err) {
        stats.failed += 1;
        console.error(`  FAIL ${row.r2Key}: ${(err as Error).message}`);
      }
    }
  }
}

// ------------------------------------------------------------------
// Pass B — report-backed listings (`report.photos_manifest`)
// ------------------------------------------------------------------

async function mirrorReportListings(
  ctx: Ctx,
  opts: { batch: number; onlyListing: string; activeOnly: boolean },
): Promise<void> {
  const { prisma, stats } = ctx;

  const pending = await prisma.listing.findMany({
    where: {
      publicPhotosMirroredAt: null,
      reportId: { not: null },
      status: opts.activeOnly ? 'ACTIVE' : { not: 'DELETED' },
      ...(opts.onlyListing ? { id: opts.onlyListing } : {}),
    },
    select: { id: true, report: { select: { photosManifest: true } } },
    orderBy: { publishedAt: 'asc' },
  });
  console.log(`\nPass B: ${pending.length} report-backed listing(s) not yet mirrored`);

  for (let i = 0; i < pending.length; i += opts.batch) {
    for (const listing of pending.slice(i, i + opts.batch)) {
      if (transferred(stats) >= ctx.limit) {
        console.log('  limit reached — stopping pass B');
        return;
      }
      stats.listingsScanned += 1;
      const refs = manifestPhotoRefs(listing.report?.photosManifest, MAX_LISTING_PHOTOS);
      let failedHere = 0;

      for (const ref of refs) {
        try {
          const outcome = await copyObject(ctx, ref.s3Key, mirroredPhotoKey(listing.id, ref.s3Key));
          if (outcome === 'missing') {
            // A manifest entry whose object is gone. A signed URL for it 404s
            // just as loudly, so it does not block the stamp — the other photos
            // of the listing should not stay on expiring URLs because of it.
            console.log(`  MISS ${ref.s3Key} (listing ${listing.id})`);
            continue;
          }
          if (outcome === 'exists') stats.mirrorSkipped += 1;
          else stats.mirrored += 1;
        } catch (err) {
          failedHere += 1;
          stats.failed += 1;
          console.error(`  FAIL ${ref.s3Key} (listing ${listing.id}): ${(err as Error).message}`);
        }
      }

      // The stamp is what switches the READ path over. Stamping a listing whose
      // mirror half-failed would put a permanently broken image on a live advert.
      if (failedHere > 0) {
        console.log(`  KEEP ${listing.id} unstamped (${failedHere} failure(s)) — retry later`);
        continue;
      }
      if (ctx.dryRun) {
        console.log(`  DB   ${listing.id} → public_photos_mirrored_at (skipped: dry run)`);
      } else {
        await prisma.listing.update({
          where: { id: listing.id },
          data: { publicPhotosMirroredAt: new Date() },
        });
        stats.listingsStamped += 1;
        console.log(`  DONE ${listing.id} (${refs.length} photo(s))`);
      }
    }
  }
}

// ------------------------------------------------------------------

type CopyOutcome = 'copied' | 'exists' | 'missing';

/**
 * Download from the reports bucket, upload to the public one, verify.
 *
 * Not a `CopyObject`: the destination token is scoped to the public bucket and
 * deliberately cannot read the source. The verification HEAD is what lets the
 * caller stamp a database row — without it a row could point at a copy that a
 * half-finished PUT never produced.
 */
async function copyObject(ctx: Ctx, sourceKey: string, destKey: string): Promise<CopyOutcome> {
  const sourceSize = await headOrNull(ctx.source, ctx.sourceBucket, sourceKey);
  if (sourceSize === null) {
    ctx.stats.missingSources += 1;
    return 'missing';
  }

  const destSize = await headOrNull(ctx.publicClient, ctx.publicBucket, destKey);
  if (destSize !== null && destSize === sourceSize) return 'exists';

  // A dry run reports what a real run would transfer, and touches nothing.
  if (ctx.dryRun) return 'copied';

  const got = await ctx.source.send(
    new GetObjectCommand({ Bucket: ctx.sourceBucket, Key: sourceKey }),
  );
  const body = got.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) throw new Error('source object had no readable body');
  const bytes = Buffer.from(await body.transformToByteArray());

  await ctx.publicClient.send(
    new PutObjectCommand({
      Bucket: ctx.publicBucket,
      Key: destKey,
      Body: bytes,
      ContentType: got.ContentType ?? 'image/jpeg',
      CacheControl: CACHE_CONTROL,
    }),
  );

  const written = await headOrNull(ctx.publicClient, ctx.publicBucket, destKey);
  if (written === null) throw new Error('destination object missing after PutObject');
  if (written !== bytes.length) {
    throw new Error(`size mismatch after copy: source=${bytes.length} dest=${written}`);
  }
  return 'copied';
}

/** How many objects this run has actually moved — what `--limit` counts. */
function transferred(stats: Stats): number {
  return stats.rowsCopied + stats.mirrored;
}

/** ContentLength of the object, or null when it does not exist. */
async function headOrNull(client: S3Client, bucket: string, key: string): Promise<number | null> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength ?? 0;
  } catch (err: unknown) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
