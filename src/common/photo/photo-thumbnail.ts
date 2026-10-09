import sharp from 'sharp';

/**
 * Small copies of showroom photos (DEN-469).
 *
 * A listing card is about 400 px wide, and the gallery strip on the car page
 * is smaller. Both loaded the 1920 px original, 300-400 KB each. The home page
 * downloaded about 5 MB of images that the browser then scaled down.
 *
 * The copy is written next to the original, in the public bucket, under a key
 * derived from the original key. The read path thus builds the URL with no
 * database column, and the delete path removes it with no lookup.
 */

/** Longest edge of the copy. Two times the card width, for HiDPI screens. */
export const THUMBNAIL_EDGE_PX = 640;
const THUMBNAIL_WEBP_QUALITY = 72;

/**
 * The key of the copy, or null when the object gets no copy.
 *
 * Only JPEG photos under `listings/`. Everything there is the output of
 * `PhotoProcessingService` (or the demo import), so a `.jpg` key is a photo.
 */
export function thumbnailKey(key: string): string | null {
  if (!key.startsWith('listings/') || !/\.jpg$/i.test(key)) return null;
  return key.replace(/\.jpg$/i, '.w640.webp');
}

/**
 * Resize a showroom photo to the copy. The input is already a 1920 px JPEG, so
 * this is fast and needs little memory.
 */
export async function makeThumbnail(input: Buffer | Uint8Array): Promise<Buffer> {
  return sharp(input, { failOn: 'error' })
    .rotate()
    .resize({
      width: THUMBNAIL_EDGE_PX,
      height: THUMBNAIL_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: THUMBNAIL_WEBP_QUALITY })
    .toBuffer();
}
