import { Prisma } from '@prisma/client';
import { manifestPhotoRefs, mirroredPhotoKey, photoLocation } from './listing-photo-urls';

/** The R2 calls the photo rules need. A narrow type, so the spec needs no module. */
export interface ListingPhotoR2 {
  isConfigured(): boolean;
  isPublicBucketConfigured(): boolean;
  publicObjectUrl(key: string): string;
  publicThumbnailUrl(key: string): string | undefined;
  createPresignedDownloadUrl(key: string): Promise<{ url: string }>;
}

/**
 * THE gallery rule, shared by the showroom (`public.service.ts`) and the
 * cabinet cover (DEN-521).
 *
 * A report-backed listing shows the report manifest only while the report row
 * exists. Without it (an erased report), the listing falls back to its own
 * `ListingPhoto` rows, the same as a manual listing.
 */
export function usesReportGallery(listing: { source: string; hasReport: boolean }): boolean {
  return listing.source === 'report' && listing.hasReport;
}

/**
 * True when the photos of a report-backed listing are served from the public
 * mirror. Then each key is `mirroredPhotoKey(listingId, s3Key)`.
 */
export function reportPhotosArePublic(
  publicPhotosMirroredAt: Date | null,
  publicBucketConfigured: boolean,
): boolean {
  return Boolean(publicPhotosMirroredAt) && publicBucketConfigured;
}

/** A public-bucket photo and its 640 px copy, when one exists. */
export function publicPhotoUrls(
  r2: ListingPhotoR2,
  key: string,
): { url: string; thumbUrl?: string } {
  const thumbUrl = r2.publicThumbnailUrl(key);
  return { url: r2.publicObjectUrl(key), ...(thumbUrl ? { thumbUrl } : {}) };
}

/** A signed URL for a private photo, or null when it cannot be signed. */
export async function signedPhotoUrl(r2: ListingPhotoR2, key: string): Promise<string | null> {
  if (!r2.isConfigured()) return null;
  try {
    return (await r2.createPresignedDownloadUrl(key)).url;
  } catch {
    return null;
  }
}

export interface CoverPhotoSource {
  id: string;
  source: string;
  publicPhotosMirroredAt: Date | null;
  /** True when the report row of the listing exists. */
  hasReport: boolean;
  /** `Report.photosManifest` of a report-backed listing. */
  manifest: Prisma.JsonValue | null;
  /** The first `ListingPhoto` row of the listing, in gallery order. */
  firstPhoto: { r2Key: string; bucket: string | null } | null;
}

/**
 * The URL of the first photo of a listing, for the cabinet card (DEN-521).
 *
 * It uses the helpers above, which the showroom card uses too. A public object
 * gives its 640 px copy when one exists, else the full URL. A private object
 * gives a signed URL.
 *
 * It never throws. A photo that cannot be signed gives null, and the card then
 * shows the photo count, as it did before this field existed.
 */
export async function coverPhotoUrl(
  r2: ListingPhotoR2,
  listing: CoverPhotoSource,
): Promise<string | null> {
  const publicConfigured = r2.isPublicBucketConfigured();

  let key: string;
  let isPublic: boolean;
  if (usesReportGallery(listing)) {
    const [ref] = manifestPhotoRefs(listing.manifest, 1);
    if (!ref) return null;
    isPublic = reportPhotosArePublic(listing.publicPhotosMirroredAt, publicConfigured);
    key = isPublic ? mirroredPhotoKey(listing.id, ref.s3Key) : ref.s3Key;
  } else {
    if (!listing.firstPhoto) return null;
    isPublic = photoLocation(listing.firstPhoto.bucket, publicConfigured) === 'public';
    key = listing.firstPhoto.r2Key;
  }

  if (isPublic) {
    const photo = publicPhotoUrls(r2, key);
    return photo.thumbUrl ?? photo.url;
  }
  return signedPhotoUrl(r2, key);
}
