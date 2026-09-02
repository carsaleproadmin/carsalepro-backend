import { createHash } from 'node:crypto';

import { angleForKind, comparePhotoKinds } from '../catalog/catalog-photo-order';

/**
 * Photos per listing. A gallery is a sales tool, not an archive, and the cap
 * bounds both the R2 spend and the size of the public listing response.
 *
 * It is also the size of the showroom SUBSET mirrored into the public bucket
 * for a report-backed listing — an inspection may carry three hundred photos,
 * and the showroom shows this many at most, so mirroring more would double the
 * storage of pictures nobody ever requests.
 *
 * Raised 20 -> 32 on 2026-08-10, and 32 -> 40 on 2026-08-17. The number is
 * derived, not chosen: the manual seller editor builds its guided slots straight
 * from the catalog, and that is 17 exterior angles plus the client's ordered 17
 * interior ones = 34. At 20 the editor offered nine slots the API answered with
 * `photo_limit_reached`, and at 32 the cabin expansion would have re-opened the
 * same gap by five.
 *
 * **Any change to this number must widen `erasePublicPhotoObjects` too.** The
 * mirrored subset is "the first MAX_LISTING_PHOTOS entries in manifest order", so
 * moving the cap strands objects mirrored under the old one — a permanent,
 * CDN-cached public photograph of a car whose owner asked to be erased. That
 * function derives its keys from the WHOLE manifest for exactly this reason, so
 * raising the cap needs no edit there; lowering it would.
 */
export const MAX_LISTING_PHOTOS = 40;

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
 * Slot kinds that must never reach a public surface, whatever a manifest says.
 *
 * `passport` holds the pages of the vehicle registration document, which carry
 * the name and the address of the owner. Three separate locks already stand in
 * front of it: the mobile app does not upload it (`sync_providers.dart` skips
 * `PhotoKind.passport`), it is not drawn into the PDF, and the website removes
 * it again in `lib/report-photos.ts`. All three are on a different machine from
 * this one. This is the lock on the surface that PUBLISHES - the only place
 * where a leak is a leak rather than a mistake in a client.
 *
 * Matched by PREFIX as well as in full. The app takes up to three pages, and a
 * later build that numbers them `passport-2` must not walk past a rule written
 * for a single slot.
 */
const NEVER_PUBLIC_KINDS = ['passport'] as const;

/** True when a slot kind must not be published, at any index. */
export function isNeverPublicKind(kind: string | null | undefined): boolean {
  const value = (kind ?? '').toLowerCase();
  return NEVER_PUBLIC_KINDS.some(
    (banned) => value === banned || value.startsWith(`${banned}-`) || value.startsWith(`${banned}_`),
  );
}

/**
 * The showroom subset of a report's photo manifest.
 *
 * `photosManifest` is a `Json` column, so it can be anything at all: null for an
 * old report, an object for a corrupted one, an array holding entries with no
 * `s3Key`. Both the mirror and the read path have to agree on exactly which
 * refs count, or a mirrored key would be missing for a photo the showroom tries
 * to render — hence one parser, used by both.
 *
 * It SORTS BEFORE IT TRUNCATES, and that is the whole point of the sort living
 * here rather than only at write time. `ReportsService.mirrorPhotosManifest`
 * writes the manifest in walk-around order, but every report written before
 * 2026-08-10 is still stored in the old `kind ASC` order — which is
 * alphabetical, and puts `checklist-` and `damage-` ahead of `exterior-`. Those
 * reports would otherwise keep serving a gallery of scratch macros with no
 * picture of the car, until something happened to re-upload a photo. Sorting on
 * read fixes every existing listing the moment this deploys, with no migration.
 *
 * `angle` is filled in from `kind` for the same reason: the field is only
 * written by the current mirror, so on an older manifest it is absent, and the
 * website would show an uncaptioned gallery until the report was touched.
 *
 * `includeNeverPublic` is for ERASURE and for nothing else. The default drops
 * the kinds that must never be published, which is what every read path and the
 * mirror want. The GDPR pass wants the opposite: it computes the keys to DELETE
 * from the public bucket, so a kind an OLD build mirrored before this rule
 * existed has to stay in that list, or the erasure would walk past the one
 * object it most needs to remove.
 */
export function manifestPhotoRefs(
  manifest: unknown,
  limit: number,
  options: { includeNeverPublic?: boolean } = {},
): ManifestPhotoRef[] {
  if (!Array.isArray(manifest) || limit <= 0) return [];
  const parsed: ManifestPhotoRef[] = [];
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') continue;
    const ref = entry as Partial<ManifestPhotoRef>;
    if (typeof ref.s3Key !== 'string' || ref.s3Key.length === 0) continue;
    const kind = typeof ref.kind === 'string' ? ref.kind : undefined;
    if (!options.includeNeverPublic && isNeverPublicKind(kind)) continue;
    const angle = typeof ref.angle === 'string' ? ref.angle : angleForKind(kind);
    parsed.push({
      s3Key: ref.s3Key,
      ...(kind ? { kind } : {}),
      ...(angle ? { angle } : {}),
    });
  }
  // Stable: entries of equal rank keep their stored order, which is capture
  // order within a slot.
  parsed.sort((a, b) => comparePhotoKinds(a.kind, b.kind));
  return parsed.slice(0, limit);
}
