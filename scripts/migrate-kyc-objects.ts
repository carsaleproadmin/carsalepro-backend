/**
 * One-off migration: move KYC identity documents out of the shared public
 * reports bucket (`kyc/` prefix of `R2_BUCKET`) into the dedicated PRIVATE
 * bucket (`R2_KYC_BUCKET`). SECURITY.md H2.
 *
 *   npx ts-node scripts/migrate-kyc-objects.ts --dry-run
 *   npx ts-node scripts/migrate-kyc-objects.ts
 *
 * Per object, strictly in this order:
 *   1. CopyObject  source bucket → KYC bucket (same key)
 *   2. HeadObject  on the destination, verify ContentLength matches the source
 *   3. UPDATE kyc_document SET bucket = '<kyc bucket>' WHERE s3_key = <key>
 *   4. DeleteObject on the source — ONLY after the row points at the copy
 *
 * The ordering is the whole point: if the process dies at any step the object
 * is still readable through the row's current `bucket` value. A source deleted
 * before step 3 would be a KYC document that no admin can ever open again.
 *
 * Idempotent and resumable — a re-run skips keys whose row already names the
 * KYC bucket and whose destination object verifies, and it tolerates a source
 * that has already been deleted.
 *
 * Objects with no matching kyc_document row (orphans from a deleted
 * application) are copied and reported but NEVER deleted from the source; they
 * need a human decision, not an automatic delete.
 *
 * Flags:
 *   --dry-run   log every action without copying, updating or deleting
 *   --prefix=X  override the source prefix (default `kyc/`)
 *   --limit=N   stop after N source objects (useful for a first cautious pass)
 */
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { flag, loadEnv, option, requireEnv } from './lib/script-env';

// ------------------------------------------------------------------

interface Stats {
  listed: number;
  copied: number;
  skipped: number;
  rowsUpdated: number;
  sourcesDeleted: number;
  orphans: number;
  failed: number;
}

async function main(): Promise<void> {
  loadEnv();

  const dryRun = flag('dry-run');
  const sourcePrefix = option('prefix', 'kyc/');
  const limit = Number(option('limit', '0')) || Infinity;

  const accountId = requireEnv('R2_ACCOUNT_ID');
  const sourceBucket = requireEnv('R2_BUCKET');
  const kycBucket = requireEnv('R2_KYC_BUCKET');
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

  if (sourceBucket === kycBucket) {
    console.error(
      `FATAL: R2_BUCKET and R2_KYC_BUCKET are both "${sourceBucket}". ` +
        'There is nothing to migrate and a self-copy would be destructive.',
    );
    process.exit(1);
  }

  // The source (public reports) bucket is read+delete with the MAIN token; the
  // destination is written with the scoped KYC token. Cross-bucket CopyObject is
  // issued against the destination and needs read on the source, so it runs on
  // the main client — the scoped KYC token deliberately cannot see the source.
  const mainClient = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    },
  });
  const kycClient = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: requireEnv('R2_KYC_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_KYC_SECRET_ACCESS_KEY'),
    },
  });

  const prisma = new PrismaClient();
  const stats: Stats = {
    listed: 0,
    copied: 0,
    skipped: 0,
    rowsUpdated: 0,
    sourcesDeleted: 0,
    orphans: 0,
    failed: 0,
  };

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}Migrating "${sourcePrefix}" ` +
      `from ${sourceBucket} → ${kycBucket} (endpoint ${endpoint})`,
  );

  try {
    let continuationToken: string | undefined;
    outer: do {
      const page = await mainClient.send(
        new ListObjectsV2Command({
          Bucket: sourceBucket,
          Prefix: sourcePrefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const object of page.Contents ?? []) {
        const key = object.Key;
        if (!key || key.endsWith('/')) continue;
        if (stats.listed >= limit) break outer;
        stats.listed += 1;

        try {
          await migrateOne({
            key,
            sourceSize: object.Size,
            sourceBucket,
            kycBucket,
            mainClient,
            kycClient,
            prisma,
            dryRun,
            stats,
          });
        } catch (err) {
          stats.failed += 1;
          console.error(`  FAIL ${key}: ${(err as Error).message}`);
        }
      }

      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n--- summary ---');
  console.log(`listed          ${stats.listed}`);
  console.log(`copied          ${stats.copied}`);
  console.log(`already done    ${stats.skipped}`);
  console.log(`rows updated    ${stats.rowsUpdated}`);
  console.log(`sources deleted ${stats.sourcesDeleted}`);
  console.log(`orphans kept    ${stats.orphans}`);
  console.log(`failed          ${stats.failed}`);
  if (dryRun) console.log('\n(dry run — nothing was written or deleted)');
  if (stats.failed > 0) process.exitCode = 1;
}

interface MigrateOneArgs {
  key: string;
  sourceSize?: number;
  sourceBucket: string;
  kycBucket: string;
  mainClient: S3Client;
  kycClient: S3Client;
  prisma: PrismaClient;
  dryRun: boolean;
  stats: Stats;
}

async function migrateOne(args: MigrateOneArgs): Promise<void> {
  const { key, sourceBucket, kycBucket, mainClient, kycClient, prisma, dryRun, stats } = args;

  const row = await prisma.kycDocument.findFirst({
    where: { s3Key: key },
    select: { id: true, bucket: true },
  });

  // Fast path: a previous run already finished this key.
  if (row?.bucket === kycBucket) {
    const dest = await headOrNull(kycClient, kycBucket, key);
    if (dest !== null) {
      stats.skipped += 1;
      console.log(`  SKIP ${key} (row already points at ${kycBucket}, copy verified)`);
      // The source may still be around if a prior run died at step 4.
      if (!dryRun) {
        await mainClient.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: key }));
        stats.sourcesDeleted += 1;
        console.log(`  DEL  ${key} (leftover source from an interrupted run)`);
      }
      return;
    }
    // Row claims the KYC bucket but the object is not there — fall through and
    // re-copy from the source, which is still present or we would not be here.
    console.log(`  WARN ${key}: row names ${kycBucket} but no object there — re-copying`);
  }

  // 1. Copy.
  if (dryRun) {
    console.log(`  COPY ${key} → ${kycBucket} (skipped: dry run)`);
  } else {
    await mainClient.send(
      new CopyObjectCommand({
        Bucket: kycBucket,
        Key: key,
        CopySource: `${sourceBucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
      }),
    );
    stats.copied += 1;
    console.log(`  COPY ${key} → ${kycBucket}`);
  }

  // 2. Verify the destination exists and has the same size.
  if (!dryRun) {
    const destSize = await headOrNull(kycClient, kycBucket, key);
    if (destSize === null) {
      throw new Error('destination object missing after CopyObject');
    }
    const sourceSize = args.sourceSize;
    if (typeof sourceSize === 'number' && destSize !== sourceSize) {
      throw new Error(`size mismatch after copy: source=${sourceSize} dest=${destSize}`);
    }
    console.log(`  HEAD ${key} verified (${destSize} bytes)`);
  }

  // 3. Point the DB row at the copy. No row => an orphan object: keep both
  //    copies and leave it for a human.
  if (!row) {
    stats.orphans += 1;
    console.log(`  ORPH ${key}: no kyc_document row — copied but source NOT deleted`);
    return;
  }
  if (dryRun) {
    console.log(`  DB   ${key} → bucket=${kycBucket} (skipped: dry run)`);
  } else {
    await prisma.kycDocument.update({ where: { id: row.id }, data: { bucket: kycBucket } });
    stats.rowsUpdated += 1;
    console.log(`  DB   ${key} → bucket=${kycBucket}`);
  }

  // 4. Only now is it safe to remove the source.
  if (dryRun) {
    console.log(`  DEL  ${key} from ${sourceBucket} (skipped: dry run)`);
  } else {
    await mainClient.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: key }));
    stats.sourcesDeleted += 1;
    console.log(`  DEL  ${key} from ${sourceBucket}`);
  }
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
