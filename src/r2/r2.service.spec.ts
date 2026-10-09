import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import sharp from 'sharp';
import { R2Service } from './r2.service';

/**
 * The public-bucket contract of the 640 px copies (DEN-469). The delete half
 * is the GDPR half: an erased photo must not leave a public copy behind.
 */
describe('R2Service public photo copies', () => {
  let send: jest.Mock;

  function service(thumbnails: boolean): R2Service {
    const r2 = new R2Service({} as ConfigService<AppConfig, true>);
    send = jest.fn().mockResolvedValue({});
    // The fields `initPublicClient` sets from the environment.
    Object.assign(r2 as unknown as Record<string, unknown>, {
      publicClient: { send },
      publicBucket: 'pub',
      publicBaseUrl: 'https://img.test',
      publicThumbnails: thumbnails,
    });
    return r2;
  }

  async function jpeg(): Promise<Buffer> {
    return sharp({ create: { width: 1200, height: 800, channels: 3, background: '#888' } })
      .jpeg()
      .toBuffer();
  }

  const putKeys = () =>
    send.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd instanceof PutObjectCommand)
      .map((cmd: PutObjectCommand) => [cmd.input.Key, cmd.input.ContentType]);
  const deleteKeys = () =>
    send.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd instanceof DeleteObjectCommand)
      .map((cmd: DeleteObjectCommand) => cmd.input.Key);

  it('writes the copy beside a listing photo', async () => {
    await service(false).publicPutObject('listings/l1/a.jpg', await jpeg());
    expect(putKeys()).toEqual([
      ['listings/l1/a.jpg', 'image/jpeg'],
      ['listings/l1/a.w640.webp', 'image/webp'],
    ]);
  });

  it('writes no copy for an object that is not a listing photo', async () => {
    await service(false).publicPutObject('fonts/x.ttf', Buffer.from('x'), 'font/ttf');
    expect(putKeys()).toEqual([['fonts/x.ttf', 'font/ttf']]);
  });

  it('keeps the original when the copy cannot be made', async () => {
    const r2 = service(false);
    await expect(r2.publicPutObject('listings/l1/a.jpg', Buffer.from('not an image'))).resolves.toBe(
      'pub',
    );
    expect(putKeys()).toEqual([['listings/l1/a.jpg', 'image/jpeg']]);
  });

  it('deletes the copy with the photo', async () => {
    await service(false).publicDeleteObject('listings/l1/a.jpg');
    expect(deleteKeys()).toEqual(['listings/l1/a.jpg', 'listings/l1/a.w640.webp']);
  });

  it('gives the URL of the copy only when R2_PUBLIC_THUMBNAILS is on', () => {
    expect(service(false).publicThumbnailUrl('listings/l1/a.jpg')).toBeUndefined();
    expect(service(true).publicThumbnailUrl('listings/l1/a.jpg')).toBe(
      'https://img.test/listings/l1/a.w640.webp',
    );
    expect(service(true).publicThumbnailUrl('fonts/x.ttf')).toBeUndefined();
  });
});
