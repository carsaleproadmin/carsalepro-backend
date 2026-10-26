import { Prisma } from '@prisma/client';
import { manifestPhotoRefs, mirroredPhotoKey, photoLocation } from './listing-photo-urls';

/** The R2 calls this file needs. A narrow type, so the spec needs no module. */
export interface CoverPhotoR2 {
  isConfigured(): boolean;
  isPublicBucketConfigured(): boolean;
  publicObjectUrl(key: string): string;
  publicThumbnailUrl(key: string): string | undefined;
  createPresignedDownloadUrl(key: string): Promise<{ url: string }>;
}

export interface CoverPhotoSource {
  id: string;
  source: string;
  publicPhotosMirroredAt: Date | null;
  /** `Report.photosManifest` of a report-backed listing. */
  manifest: Prisma.JsonValue | null;
  /** The first `ListingPhoto` row of a manual listing, in gallery order. */
  firstPhoto: { r2Key: string; bucket: string | null } | null;
}

/**
 * The URL of the first photo of a listing, for the cabinet card (DEN-521).
 *
 * It uses the same gallery rule as the showroom card (`listingPhotos` in
 * `public.service.ts`): the report manifest for a report-backed listing, the
 * seller's `ListingPhoto` rows for a manual one. A public object gives its
 * 640 px copy when one exists, else the full URL. A private object gives a
 * signed URL.
 *
 * It never throws. A photo that cannot be signed gives null, and the card then
 * shows the photo count, as it did before this field existed.
 */
export async function coverPhotoUrl(
  r2: CoverPhotoR2,
  listing: CoverPhotoSource,
): Promise<string | null> {
  const publicConfigured = r2.isPublicBucketConfigured();

  let key: string;
  let isPublic: boolean;
  if (listing.source === 'report') {
    const [ref] = manifestPhotoRefs(listing.manifest, 1);
    if (!ref) return null;
    isPublic = Boolean(listing.publicPhotosMirroredAt) && publicConfigured;
    key = isPublic ? mirroredPhotoKey(listing.id, ref.s3Key) : ref.s3Key;
  } else {
    if (!listing.firstPhoto) return null;
    isPublic = photoLocation(listing.firstPhoto.bucket, publicConfigured) === 'public';
    key = listing.firstPhoto.r2Key;
  }

  if (isPublic) return r2.publicThumbnailUrl(key) ?? r2.publicObjectUrl(key);
  if (!r2.isConfigured()) return null;
  try {
    return (await r2.createPresignedDownloadUrl(key)).url;
  } catch {
    return null;
  }
}
