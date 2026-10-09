import sharp from 'sharp';
import { makeThumbnail, THUMBNAIL_EDGE_PX, thumbnailKey } from './photo-thumbnail';

describe('thumbnailKey', () => {
  it('derives the copy key of a listing photo', () => {
    expect(thumbnailKey('listings/abc/123.jpg')).toBe('listings/abc/123.w640.webp');
    expect(thumbnailKey('listings/abc/m-0123abcd.JPG')).toBe('listings/abc/m-0123abcd.w640.webp');
  });

  it('gives no copy outside listings/ or for a key that is not a JPEG', () => {
    expect(thumbnailKey('report-photos/dev/rep/1.jpg')).toBeNull();
    expect(thumbnailKey('listings/abc/123.w640.webp')).toBeNull();
    expect(thumbnailKey('listings/abc/doc.pdf')).toBeNull();
  });
});

describe('makeThumbnail', () => {
  it('scales the longest edge down to the copy size and writes WebP', async () => {
    const input = await sharp({
      create: { width: 1920, height: 1080, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();
    const meta = await sharp(await makeThumbnail(input)).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(THUMBNAIL_EDGE_PX);
    expect(meta.height).toBe(360);
  });

  it('does not enlarge a small photo', async () => {
    const input = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();
    const meta = await sharp(await makeThumbnail(input)).metadata();
    expect(meta.width).toBe(300);
  });
});
