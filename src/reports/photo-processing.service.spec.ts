import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { PhotoProcessingService } from './photo-processing.service';

const fixture = (name: string): Buffer =>
  readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', name));

describe('PhotoProcessingService', () => {
  let service: PhotoProcessingService;

  beforeEach(() => {
    service = new PhotoProcessingService();
  });

  it('downsizes a 4000x3000 camera JPEG to ≤1920 px and well under 1 MB', async () => {
    const input = fixture('photo-4000x3000.jpg');
    const out = await service.compress(input);

    expect(Math.max(out.width, out.height)).toBe(1920);
    expect(out.width).toBe(1920);
    expect(out.height).toBe(1440); // aspect preserved
    expect(out.format).toBe('jpeg');
    expect(out.sizeBytes).toBe(out.data.length);
    expect(out.sizeBytes).toBeLessThan(1024 * 1024);
    expect(out.sizeBytes).toBeLessThan(input.length); // actually compressed
  });

  it('bakes EXIF orientation into pixels and strips metadata', async () => {
    const out = await service.compress(fixture('photo-exif-rotated.jpg'));

    // Orientation 6 = 90° rotation: the 4000x3000 source must come out portrait.
    expect(out.height).toBeGreaterThan(out.width);
    expect(out.height).toBe(1920);

    const meta = await sharp(out.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it('never enlarges a small image and converts PNG input to JPEG', async () => {
    const out = await service.compress(fixture('small-800x600.png'));
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
    expect(out.format).toBe('jpeg');
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('rejects undecodable input with a 400 invalid_image error', async () => {
    await expect(service.compress(fixture('not-an-image.bin'))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('serializes concurrent transforms without dropping any', async () => {
    const input = fixture('small-800x600.png');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => service.compress(input)),
    );
    expect(results).toHaveLength(6);
    for (const r of results) {
      expect(r.width).toBe(800);
    }
  });
});
