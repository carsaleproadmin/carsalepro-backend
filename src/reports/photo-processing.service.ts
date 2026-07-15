import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

export interface ProcessedPhoto {
  data: Buffer;
  width: number;
  height: number;
  sizeBytes: number;
  format: 'jpeg';
}

/** Longest edge after resize — plenty for car-listing galleries. */
const MAX_EDGE_PX = 1920;
/** mozjpeg q80 keeps visible detail on car paint/panels at ~200–500 KB per shot. */
const JPEG_QUALITY = 80;
/**
 * Concurrent libvips transforms. A 12 MP decode peaks around ~60 MB; capping
 * at 2 keeps the worst case ~120 MB over baseline — safe on a small Render
 * instance. Excess uploads wait in-process.
 */
const MAX_CONCURRENT = 2;

/**
 * Server-side photo compression for report images.
 *
 * Input: original camera JPEG (or PNG/WebP) from the mobile client.
 * Output: EXIF-stripped, orientation-baked JPEG, longest edge ≤ 1920 px,
 * mozjpeg q80 — a 20–35-photo report lands at ~5–20 MB total.
 */
@Injectable()
export class PhotoProcessingService {
  private readonly logger = new Logger(PhotoProcessingService.name);
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor() {
    // libvips' operation cache trades memory for speed; on a small instance
    // predictable memory wins.
    sharp.cache(false);
  }

  async compress(input: Buffer): Promise<ProcessedPhoto> {
    await this.acquire();
    try {
      const { data, info } = await sharp(input, { failOn: 'error' })
        .rotate() // bake EXIF orientation before metadata is stripped
        .resize({
          width: MAX_EDGE_PX,
          height: MAX_EDGE_PX,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, chromaSubsampling: '4:2:0' })
        .toBuffer({ resolveWithObject: true });

      return {
        data,
        width: info.width,
        height: info.height,
        sizeBytes: info.size,
        format: 'jpeg',
      };
    } catch (err) {
      this.logger.warn(`Photo decode/compress failed: ${(err as Error).message}`);
      throw new BadRequestException({
        error: 'invalid_image',
        message: 'The uploaded file could not be decoded as an image (send a camera JPEG).',
      });
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}
