/**
 * Backfill: write the 640 px copy (DEN-469) for every showroom photo that is
 * already in the public bucket.
 *
 *   npx ts-node scripts/backfill-listing-thumbnails.ts --dry-run
 *   npx ts-node scripts/backfill-listing-thumbnails.ts --limit=50
 *   npx ts-node scripts/backfill-listing-thumbnails.ts
 *
 * New photos get the copy from `R2Service.publicPutObject`. This script is for
 * the photos that existed before. It reads the bucket, not the database, so it
 * covers every way a photo got there: seller uploads, mirrored report photos
 * and the demo import.
 *
 * It only ADDS objects. It deletes and changes nothing. A photo whose copy is
 * already there is skipped, so a second run continues where the first stopped.
 *
 * Flags:
 *   --dry-run     list the copies to write, write nothing
 *   --limit=N     stop after N copies
 *   --prefix=P    only keys under P (default `listings/`)
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { flag, loadEnv, option, requireEnv } from './lib/script-env';
import { makeThumbnail, thumbnailKey } from '../src/common/photo/photo-thumbnail';

/** Matches `R2Service.publicPutThumbnail`. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

async function main(): Promise<void> {
  loadEnv();
  const dryRun = flag('dry-run');
  const limit = Number(option('limit', '0')) || Infinity;
  const prefix = option('prefix', 'listings/');

  const bucket = requireEnv('R2_PUBLIC_BUCKET');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${requireEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requireEnv('R2_PUBLIC_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_PUBLIC_SECRET_ACCESS_KEY'),
    },
  });

  // One listing of the whole prefix: the keys of the photos and the keys of
  // the copies that exist. A HEAD per photo would be one request per object.
  const keys = new Set<string>();
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) if (o.Key) keys.add(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  const todo = [...keys].filter((k) => {
    const small = thumbnailKey(k);
    return small !== null && !keys.has(small);
  });
  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}${bucket}/${prefix}: ${keys.size} objects, ` +
      `${todo.length} photos without a copy`,
  );

  let written = 0;
  let failed = 0;
  for (const key of todo) {
    if (written >= limit) break;
    const small = thumbnailKey(key) as string;
    if (dryRun) {
      console.log(`  would write ${small}`);
      written += 1;
      continue;
    }
    try {
      const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = Buffer.from(await obj.Body!.transformToByteArray());
      const body = await makeThumbnail(bytes);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: small,
          Body: body,
          ContentType: 'image/webp',
          CacheControl: CACHE_CONTROL,
        }),
      );
      written += 1;
      console.log(`  ${small}  ${bytes.length >> 10} KB -> ${body.length >> 10} KB`);
    } catch (err: unknown) {
      failed += 1;
      console.error(`  FAILED ${key}: ${(err as Error).message}`);
    }
  }

  console.log(`\n${dryRun ? 'would write' : 'written'} ${written}, failed ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
