import { coverPhotoUrl, CoverPhotoR2, CoverPhotoSource } from './listing-cover-photo';
import { mirroredPhotoKey } from './listing-photo-urls';

function r2(options: { publicBucket?: boolean; configured?: boolean; signFails?: boolean } = {}) {
  const fake: CoverPhotoR2 = {
    isConfigured: () => options.configured ?? true,
    isPublicBucketConfigured: () => options.publicBucket ?? false,
    publicObjectUrl: (key) => `https://img.test/${key}`,
    publicThumbnailUrl: (key) => `https://img.test/${key}.640`,
    createPresignedDownloadUrl: jest.fn(async (key: string) => {
      if (options.signFails) throw new Error('boom');
      return { url: `https://signed.test/${key}` };
    }),
  };
  return fake;
}

const manual = (firstPhoto: CoverPhotoSource['firstPhoto']): CoverPhotoSource => ({
  id: 'l1',
  source: 'manual',
  publicPhotosMirroredAt: null,
  manifest: null,
  firstPhoto,
});

const report = (mirrored: boolean): CoverPhotoSource => ({
  id: 'l2',
  source: 'report',
  publicPhotosMirroredAt: mirrored ? new Date() : null,
  manifest: [
    { s3Key: 'report-photos/d/r/damage-1.jpg', kind: 'damage-1' },
    { s3Key: 'report-photos/d/r/front.jpg', kind: 'exterior-front' },
  ],
  firstPhoto: null,
});

describe('coverPhotoUrl', () => {
  it('gives null for a listing with no photo', async () => {
    expect(await coverPhotoUrl(r2(), manual(null))).toBeNull();
    expect(await coverPhotoUrl(r2(), { ...report(false), manifest: [] })).toBeNull();
  });

  it('signs a private manual photo', async () => {
    const url = await coverPhotoUrl(r2(), manual({ r2Key: 'listings/s/l1/a.jpg', bucket: null }));
    expect(url).toBe('https://signed.test/listings/s/l1/a.jpg');
  });

  it('gives the small public copy of a public manual photo', async () => {
    const url = await coverPhotoUrl(
      r2({ publicBucket: true }),
      manual({ r2Key: 'listings/s/l1/a.jpg', bucket: 'carsalepro-listings' }),
    );
    expect(url).toBe('https://img.test/listings/s/l1/a.jpg.640');
  });

  it('signs a public row when the public bucket is not configured', async () => {
    const url = await coverPhotoUrl(
      r2({ publicBucket: false }),
      manual({ r2Key: 'listings/s/l1/a.jpg', bucket: 'carsalepro-listings' }),
    );
    expect(url).toBe('https://signed.test/listings/s/l1/a.jpg');
  });

  it('takes the walk-around first, not the manifest order, for a report-backed listing', async () => {
    const url = await coverPhotoUrl(r2(), report(false));
    expect(url).toBe('https://signed.test/report-photos/d/r/front.jpg');
  });

  it('gives the mirrored key for a mirrored report-backed listing', async () => {
    const url = await coverPhotoUrl(r2({ publicBucket: true }), report(true));
    const key = mirroredPhotoKey('l2', 'report-photos/d/r/front.jpg');
    expect(url).toBe(`https://img.test/${key}.640`);
  });

  it('gives null, and does not throw, when signing fails', async () => {
    const url = await coverPhotoUrl(
      r2({ signFails: true }),
      manual({ r2Key: 'listings/s/l1/a.jpg', bucket: null }),
    );
    expect(url).toBeNull();
  });

  it('gives null when R2 is not configured', async () => {
    const url = await coverPhotoUrl(
      r2({ configured: false }),
      manual({ r2Key: 'listings/s/l1/a.jpg', bucket: null }),
    );
    expect(url).toBeNull();
  });
});
