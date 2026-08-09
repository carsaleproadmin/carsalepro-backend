import { createHash } from 'node:crypto';
import {
  MAX_LISTING_PHOTOS,
  manifestPhotoRefs,
  mirroredPhotoKey,
  photoLocation,
} from './listing-photo-urls';

describe('photoLocation — the per-row bucket rule', () => {
  it('signs when the row names no bucket, configured or not', () => {
    expect(photoLocation(null, true)).toBe('private');
    expect(photoLocation(null, false)).toBe('private');
    expect(photoLocation(undefined, true)).toBe('private');
    expect(photoLocation('', true)).toBe('private');
  });

  it('serves a permanent URL only when the row names a bucket AND one is wired', () => {
    expect(photoLocation('carsalepro-public', true)).toBe('public');
  });

  /**
   * The dark-ship guarantee. With `R2_PUBLIC_*` unset there is no base URL to
   * build against, so a stray non-NULL bucket (a rolled-back environment, a
   * database restored from a configured one) must not emit `"/listings/…"` —
   * a root-relative string the frontend would render as a broken image on its
   * own origin.
   */
  it('falls back to signing when the row names a bucket but none is configured', () => {
    expect(photoLocation('carsalepro-public', false)).toBe('private');
  });
});

describe('mirroredPhotoKey', () => {
  const listingId = 'clx1listing000';
  const sourceKey = 'report-photos/device-abc/report-123/front.jpg';

  it('is deterministic — the same input always yields the same key', () => {
    expect(mirroredPhotoKey(listingId, sourceKey)).toBe(mirroredPhotoKey(listingId, sourceKey));
  });

  it('is the documented shape: listings/<listingId>/m-<sha256(sourceKey)[0..16]>.jpg', () => {
    const digest = createHash('sha256').update(sourceKey).digest('hex').slice(0, 16);
    expect(mirroredPhotoKey(listingId, sourceKey)).toBe(`listings/${listingId}/m-${digest}.jpg`);
    expect(digest).toHaveLength(16);
  });

  it('namespaces by listing, so the same report photo on two listings never collides', () => {
    expect(mirroredPhotoKey('listing-a', sourceKey)).not.toBe(
      mirroredPhotoKey('listing-b', sourceKey),
    );
  });

  it('separates different source objects of the same listing', () => {
    const a = mirroredPhotoKey(listingId, 'report-photos/d/r/front.jpg');
    const b = mirroredPhotoKey(listingId, 'report-photos/d/r/rear.jpg');
    expect(a).not.toBe(b);
  });

  /**
   * The digest is not decoration: the source key is
   * `report-photos/<deviceId>/<reportId>/<slot>.jpg`, and this URL is permanent
   * and public. Pasting the key through would publish the link between a car
   * advert and the device that inspected it.
   */
  it('leaks neither the device id nor the report id into the public key', () => {
    const key = mirroredPhotoKey(listingId, 'report-photos/device-abc/report-123/front.jpg');
    expect(key).not.toContain('device-abc');
    expect(key).not.toContain('report-123');
    expect(key).not.toContain('report-photos');
  });

  it('produces keys that are safe in a URL path', () => {
    expect(mirroredPhotoKey(listingId, 'report-photos/d/a file (1).jpg')).toMatch(
      /^listings\/[A-Za-z0-9_-]+\/m-[0-9a-f]{16}\.jpg$/,
    );
  });
});

describe('manifestPhotoRefs', () => {
  it('keeps order and caps at the limit', () => {
    const manifest = Array.from({ length: 30 }, (_, i) => ({ s3Key: `k${i}.jpg`, kind: 'ext' }));
    const refs = manifestPhotoRefs(manifest, MAX_LISTING_PHOTOS);
    expect(refs).toHaveLength(MAX_LISTING_PHOTOS);
    expect(refs[0].s3Key).toBe('k0.jpg');
    expect(refs[MAX_LISTING_PHOTOS - 1].s3Key).toBe(`k${MAX_LISTING_PHOTOS - 1}.jpg`);
  });

  it('drops entries with no usable s3Key without shifting the cap', () => {
    const refs = manifestPhotoRefs(
      [{ kind: 'ext' }, { s3Key: '' }, { s3Key: 'good.jpg' }, null, 'nonsense', 42],
      10,
    );
    expect(refs).toEqual([{ s3Key: 'good.jpg' }]);
  });

  /**
   * `photosManifest` is a `Json` column: null for an old report, an object for a
   * corrupted one. Both the mirror and the read path parse it through here, so
   * they cannot disagree about which photos exist.
   */
  it('tolerates every non-array shape the Json column can hold', () => {
    expect(manifestPhotoRefs(null, 10)).toEqual([]);
    expect(manifestPhotoRefs(undefined, 10)).toEqual([]);
    expect(manifestPhotoRefs({ s3Key: 'x.jpg' }, 10)).toEqual([]);
    expect(manifestPhotoRefs('x.jpg', 10)).toEqual([]);
  });

  it('returns nothing for a non-positive limit', () => {
    expect(manifestPhotoRefs([{ s3Key: 'a.jpg' }], 0)).toEqual([]);
    expect(manifestPhotoRefs([{ s3Key: 'a.jpg' }], -1)).toEqual([]);
  });

  it('carries kind/angle through only when they are strings', () => {
    expect(manifestPhotoRefs([{ s3Key: 'a.jpg', kind: 'front', angle: 'diag_front_left' }], 5)).toEqual(
      [{ s3Key: 'a.jpg', kind: 'front', angle: 'diag_front_left' }],
    );
    expect(manifestPhotoRefs([{ s3Key: 'a.jpg', kind: 7 }], 5)).toEqual([{ s3Key: 'a.jpg' }]);
  });
});
