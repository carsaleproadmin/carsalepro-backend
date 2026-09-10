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
 * ## `passport` is here again, and the history is the reason to keep it
 *
 * `passport` is the pages of the vehicle registration document. They carry the
 * name and the address of the owner. The kind was on this list until
 * 2026-09-09, when DEN-263 emptied the list so that the document could appear
 * on the public car page beside the VIN plate and the odometer. It is back.
 *
 * Understand what an absent kind gets, because it is more than a picture on a
 * page: `mirrorPublicPhotos` copies it into the PUBLIC BUCKET as a permanent,
 * unsigned, CDN-cached object. Anyone who holds the URL can read it. There is
 * no authentication and no expiry, and the object stays after the listing that
 * caused the copy is gone. The only control in front of it was the inspector,
 * who was told to hide the address with the photo editor before he finished.
 * Nothing downstream examined his work.
 *
 * DEN-263 also removed three other controls: the app now uploads the kind, the
 * PDF now draws it, and the website no longer drops it. Those stay as they
 * are.
 *
 * ## The ban is on the BUCKET, not on the eye
 *
 * A reader of the free report page still sees the document: `reportFull` in
 * `public.service.ts` passes `includeNeverPublic` and signs it. That URL
 * expires and no edge caches it, so it gives the page what DEN-263 asked for
 * without giving anybody a permanent copy. This list governs the mirror, and
 * the mirror is what this kind must never reach.
 *
 * The erasure sweep (`erasePublicPhotoObjects`) passes `includeNeverPublic:
 * true` and must continue to. A build that ran between 2026-09-09 and this
 * change could have mirrored these pages, and that pass is what removes them.
 *
 * Matching is by PREFIX as well as in full, thus a build that numbers the
 * pages `passport-2` cannot go past a rule written for one slot.
 */
const NEVER_PUBLIC_KINDS: readonly string[] = ['passport'];

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
 * `includeNeverPublic` has exactly two callers, and the default is what every
 * other path wants: drop the kinds that must not reach the public bucket.
 *
 * The GDPR pass is the first. It computes the keys to DELETE from that bucket,
 * so a kind an OLD build mirrored before the rule existed has to stay in the
 * list, or the erasure would walk past the one object it most needs to remove.
 *
 * `reportFull` is the second. It signs each URL rather than mirroring it, and
 * a signed URL expires - the property the ban exists to protect is not touched
 * by it. Any THIRD caller has to make the same argument before it passes the
 * flag: if the output can become a permanent unsigned object, the answer is
 * no.
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
