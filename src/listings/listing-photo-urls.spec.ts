import { createHash } from 'node:crypto';
import {
  MAX_LISTING_PHOTOS,
  isNeverPublicKind,
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
    // Sized off the cap, not a literal: every kind here has the same sort rank,
    // so the stable sort must leave them exactly as stored.
    const manifest = Array.from({ length: MAX_LISTING_PHOTOS + 10 }, (_, i) => ({
      s3Key: `k${i}.jpg`,
      kind: 'ext',
    }));
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

  /**
   * THE regression test for the showroom gallery.
   *
   * Manifests written before 2026-08-10 are stored in `kind ASC` order, which
   * puts `damage-*` ahead of `exterior-*`. Truncating before sorting therefore
   * handed the showroom twenty scratch macros and no picture of the car — and
   * that is what every listing in the database still holds today, so the sort
   * has to happen on READ, not only in the mirror.
   */
  it('sorts by the catalog walk-around BEFORE it truncates', () => {
    const manifest = [
      ...Array.from({ length: 25 }, (_, i) => ({ s3Key: `dmg${i}.jpg`, kind: `damage-${i}` })),
      { s3Key: 'rear.jpg', kind: 'exterior-rear' },
      { s3Key: 'opener.jpg', kind: 'exterior-diag_front_left' },
      { s3Key: 'wheel.jpg', kind: 'wheel-fl' },
    ];
    const refs = manifestPhotoRefs(manifest, 3);
    expect(refs.map((r) => r.s3Key)).toEqual(['opener.jpg', 'rear.jpg', 'wheel.jpg']);
  });

  it('fills in a missing angle from the kind, and never overwrites a stored one', () => {
    // Old manifests carry no `angle` at all — the field was in the read DTOs
    // from the start and written by nothing until this change.
    expect(manifestPhotoRefs([{ s3Key: 'a.jpg', kind: 'exterior-trunk_open' }], 5)).toEqual([
      { s3Key: 'a.jpg', kind: 'exterior-trunk_open', angle: 'trunk_open' },
    ]);
    // A stored value wins, even a stale one: this parser resolves, it does not
    // adjudicate.
    expect(
      manifestPhotoRefs([{ s3Key: 'a.jpg', kind: 'exterior-front', angle: 'legacy_id' }], 5),
    ).toEqual([{ s3Key: 'a.jpg', kind: 'exterior-front', angle: 'legacy_id' }]);
    // A non-angle kind gets no angle key at all, rather than a null.
    expect(manifestPhotoRefs([{ s3Key: 'd.jpg', kind: 'damage-1' }], 5)).toEqual([
      { s3Key: 'd.jpg', kind: 'damage-1' },
    ]);
  });

  it('caps at 40, which is the 17 exterior + 17 interior guided slots plus room', () => {
    // Derived, not chosen: the manual seller editor builds its slots from the
    // catalog, so a smaller cap would advertise slots the API refuses. The cabin
    // went from 12 slots to the client's ordered 17 on 2026-08-17, which is what
    // took 32 below the guided count.
    expect(MAX_LISTING_PHOTOS).toBe(40);
    expect(MAX_LISTING_PHOTOS).toBeGreaterThanOrEqual(17 + 17);
  });
});

describe('isNeverPublicKind — the registration document', () => {
  it('drops the slot the registration document uses', () => {
    expect(isNeverPublicKind('passport')).toBe(true);
  });

  it('drops the numbered pages of it', () => {
    // The app takes up to three pages. A rule written for one slot must not
    // walk past `passport-2` and publish page two of the owner's address.
    expect(isNeverPublicKind('passport-2')).toBe(true);
    expect(isNeverPublicKind('passport_back')).toBe(true);
    expect(isNeverPublicKind('PASSPORT-3')).toBe(true);
  });

  it('keeps every kind the report is actually made of', () => {
    for (const kind of ['exterior-front', 'interior-1', 'vin', 'odometer', 'damage-1']) {
      expect(isNeverPublicKind(kind)).toBe(false);
    }
  });

  it('says nothing about a kind that is absent', () => {
    expect(isNeverPublicKind(null)).toBe(false);
    expect(isNeverPublicKind(undefined)).toBe(false);
  });
});

describe('manifestPhotoRefs — the never-public rule', () => {
  const manifest = [
    { s3Key: 'a.jpg', kind: 'exterior-front' },
    { s3Key: 'b.jpg', kind: 'passport' },
    { s3Key: 'c.jpg', kind: 'passport-2' },
  ];

  it('leaves the registration document out by default', () => {
    const keys = manifestPhotoRefs(manifest, 10).map((ref) => ref.s3Key);
    expect(keys).toEqual(['a.jpg']);
  });

  it('returns it for an erasure, which has to delete it', () => {
    // The GDPR pass computes the keys to REMOVE from the public bucket. A
    // build older than this rule could have mirrored one, and skipping it here
    // would leave the one object the erasure most needs to take away.
    const keys = manifestPhotoRefs(manifest, 10, { includeNeverPublic: true }).map(
      (ref) => ref.s3Key,
    );
    expect(keys).toContain('b.jpg');
    expect(keys).toContain('c.jpg');
  });
});
