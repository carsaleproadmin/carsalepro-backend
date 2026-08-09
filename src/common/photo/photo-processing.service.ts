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
 * 4:2:0 throws away three quarters of the colour resolution. Invisible on a car
 * panel; it is what smears coloured small print and stamp ink on a photographed
 * document, which is why the KYC path asks for 4:4:4.
 */
const CHROMA_PHOTO = '4:2:0';

export interface CompressOptions {
  /** Longest edge in pixels. Never enlarges. */
  maxEdgePx?: number;
  /** mozjpeg quality, 1–100. */
  quality?: number;
  /** '4:2:0' (photos) or '4:4:4' (documents — keeps coloured text legible). */
  chromaSubsampling?: '4:2:0' | '4:4:4';
}
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

  /**
   * Defaults are the car-photo settings every existing caller relies on, so an
   * argument-less call behaves exactly as before. The options exist because
   * identity documents are a genuinely different subject: a Gewerbeschein is
   * A4 of small print, and 1920 px at q80 with 4:2:0 is the difference between
   * a reviewer reading a registration number and guessing at it.
   */
  async compress(input: Buffer, options: CompressOptions = {}): Promise<ProcessedPhoto> {
    const maxEdge = options.maxEdgePx ?? MAX_EDGE_PX;
    const quality = options.quality ?? JPEG_QUALITY;
    const chroma = options.chromaSubsampling ?? CHROMA_PHOTO;
    await this.acquire();
    try {
      const { data, info } = await sharp(input, { failOn: 'error' })
        .rotate() // bake EXIF orientation before metadata is stripped
        .resize({
          width: maxEdge,
          height: maxEdge,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true, chromaSubsampling: chroma })
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
