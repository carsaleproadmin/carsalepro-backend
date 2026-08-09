import { createHash } from 'node:crypto';

/**
 * Photos per listing. A gallery is a sales tool, not an archive: twenty shots
 * covers every angle a buyer looks at, and the cap bounds both the R2 spend and
 * the size of the public listing response.
 *
 * It is also the size of the showroom SUBSET mirrored into the public bucket
 * for a report-backed listing — an inspection may carry three hundred photos,
 * and the showroom shows twenty of them at most, so mirroring more would double
 * the storage of pictures nobody ever requests.
 */
export const MAX_LISTING_PHOTOS = 20;

/**
 * Where a photo's bytes live, and therefore how its URL is produced.
 *
 * - `public` — a permanent, immutable, CDN-cacheable URL on the public bucket.
 * - `private` — a 15-minute presigned URL on the reports bucket (today's
 *   behaviour, and the only behaviour when `R2_PUBLIC_*` is unset).
 */
export type PhotoLocation = 'public' | 'private';

/** One entry of `Report.photosManifest`, as the mobile app writes it. */
export interface ManifestPhotoRef {
  s3Key: string;
  kind?: string;
  angle?: string;
}

/**
 * THE per-row rule, in one place.
 *
 * `ListingPhoto.bucket` is the authority: NULL means the object is in the
 * private reports bucket and must be signed, a value means it is in the public
 * bucket and has a permanent URL. Storing it per row is what makes the cutover a
 * resumable migration instead of a flag day — every row is served correctly
 * whichever side of the move it is on.
 *
 * The second argument is the guard that keeps the feature DARK. With
 * `R2_PUBLIC_*` unset there is no base URL to build against and no client to
 * reach the bucket with, so a stray non-NULL `bucket` (a rolled-back
 * environment, a restored database) must NOT produce `"/listings/…"` — a
 * root-relative string the frontend would happily render as a broken image on
 * its own origin. Signing is the honest fallback: it is what the object needed
 * before the migration, and for every mirrored object the private original is
 * still there, because nothing in this feature ever deletes from the reports
 * bucket.
 */
export function photoLocation(
  bucket: string | null | undefined,
  publicBucketConfigured: boolean,
): PhotoLocation {
  return bucket && publicBucketConfigured ? 'public' : 'private';
}

/**
 * The public-bucket key of a MIRRORED report photo.
 *
 * Report-backed listings have no `ListingPhoto` rows at all — their images come
 * from `Report.photosManifest`, in the private reports bucket, beside the paid
 * PDFs. They cannot be served from there, so the showroom subset is copied into
 * the public bucket under this key.
 *
 * Deterministic, so a re-run is idempotent: the same (listing, source object)
 * always lands on the same key, a second mirror pass overwrites identical bytes
 * instead of accumulating a second copy, and the READ path can reconstruct the
 * URL from the manifest without a join table to remember it.
 *
 * The digest of the source key rather than the key itself, because the source
 * key is `report-photos/<deviceId>/<reportId>/<slot>.jpg`: pasting a device id
 * and a report id into a permanent public URL would publish the link between a
 * car advert and the device that inspected it. Sixteen hex characters (64 bits)
 * of SHA-256 is far past collision range for the ≤20 keys that share a listing
 * prefix, and the listing id namespaces them anyway.
 *
 * `.jpg` is not a guess: everything in `photosManifest` has been through the
 * server-side sharp pipeline (1920 px, mozjpeg q80), and the mirror re-declares
 * `image/jpeg` on the copy.
 */
export function mirroredPhotoKey(listingId: string, sourceKey: string): string {
  const digest = createHash('sha256').update(sourceKey).digest('hex').slice(0, 16);
  return `listings/${listingId}/m-${digest}.jpg`;
}

/**
 * The showroom subset of a report's photo manifest.
 *
 * `photosManifest` is a `Json` column, so it can be anything at all: null for an
 * old report, an object for a corrupted one, an array holding entries with no
 * `s3Key`. Both the mirror and the read path have to agree on exactly which
 * refs count, or a mirrored key would be missing for a photo the showroom tries
 * to render — hence one parser, used by both.
 */
export function manifestPhotoRefs(manifest: unknown, limit: number): ManifestPhotoRef[] {
  if (!Array.isArray(manifest) || limit <= 0) return [];
  const out: ManifestPhotoRef[] = [];
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') continue;
    const ref = entry as Partial<ManifestPhotoRef>;
    if (typeof ref.s3Key !== 'string' || ref.s3Key.length === 0) continue;
    out.push({
      s3Key: ref.s3Key,
      ...(typeof ref.kind === 'string' ? { kind: ref.kind } : {}),
      ...(typeof ref.angle === 'string' ? { angle: ref.angle } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}
