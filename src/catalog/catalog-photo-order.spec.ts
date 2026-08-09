import { CATALOG_V1 } from './catalog.data';
import { angleForKind, comparePhotoKinds, photoSortRank } from './catalog-photo-order';

describe('angleForKind — mobile slot key -> catalog angle id', () => {
  it('strips the exterior group prefix', () => {
    expect(angleForKind('exterior-diag_front_left')).toBe('diag_front_left');
    expect(angleForKind('exterior-trunk_open')).toBe('trunk_open');
    expect(angleForKind('exterior-engine_bay_right')).toBe('engine_bay_right');
  });

  it('handles the interior double prefix', () => {
    // The catalog id already carries `interior_`, so the slot key reads
    // `interior-interior_front`.
    expect(angleForKind('interior-interior_front')).toBe('interior_front');
    expect(angleForKind('interior-interior_door_trim_rr')).toBe('interior_door_trim_rr');
  });

  it('bridges the hyphen/underscore difference for wheels', () => {
    expect(angleForKind('wheel-fl')).toBe('wheel_fl');
    expect(angleForKind('wheel-rr')).toBe('wheel_rr');
  });

  it('accepts a bare angle id — the misc group and legacy manifests', () => {
    expect(angleForKind('odometer')).toBe('odometer');
    // Manifests written before slot keys carried a group prefix.
    expect(angleForKind('front')).toBe('front');
    expect(angleForKind('rear')).toBe('rear');
  });

  /**
   * The negative half is the important half: a caption is worse than no caption
   * when it describes the wrong photo, so this must never guess.
   */
  it('returns undefined for every kind that is not an angle', () => {
    for (const kind of [
      'damage-abc123',
      'thickness-hood',
      'checklist-42',
      'repair-xyz',
      'zeroproof',
      'zeroproof-al',
      'obd',
      'service',
      'underbody-rust',
      'exterior-extra',
      'passport',
      'listing',
      'exterior-not_an_angle',
      'wheel-zz',
      '',
    ]) {
      expect(angleForKind(kind)).toBeUndefined();
    }
    expect(angleForKind(null)).toBeUndefined();
    expect(angleForKind(undefined)).toBeUndefined();
  });

  it('does NOT map `vin` to the vin_plate angle', () => {
    // A near-match is still a guess. The catalog id is `vin_plate`; the mobile
    // slot key is `vin`; nothing declares them the same thing.
    expect(angleForKind('vin')).toBeUndefined();
  });

  it('resolves every catalog angle from the slot key the app actually writes', () => {
    for (const angle of CATALOG_V1.angles) {
      const kind =
        angle.group === 'exterior'
          ? `exterior-${angle.id}`
          : angle.group === 'interior'
            ? `interior-${angle.id}`
            : angle.group === 'wheel'
              ? `wheel-${angle.id.replace('wheel_', '')}`
              : angle.id;
      expect(angleForKind(kind)).toBe(angle.id);
    }
  });
});

describe('photoSortRank / comparePhotoKinds — gallery order', () => {
  const sorted = (kinds: string[]): string[] => [...kinds].sort(comparePhotoKinds);

  it('puts the exterior walk-around first, in catalog order', () => {
    expect(
      sorted([
        'exterior-diag_rear_right',
        'exterior-trunk_open',
        'exterior-diag_front_left',
        'exterior-front',
      ]),
    ).toEqual([
      'exterior-diag_front_left', // order 1
      'exterior-trunk_open', // order 5
      'exterior-front', // order 9
      'exterior-diag_rear_right', // order 17
    ]);
  });

  it('orders the groups exterior -> wheel -> interior -> misc', () => {
    expect(
      sorted(['odometer', 'interior-interior_front', 'wheel-fl', 'exterior-left']),
    ).toEqual(['exterior-left', 'wheel-fl', 'interior-interior_front', 'odometer']);
  });

  /**
   * The regression this whole module exists for. `kind ASC` is alphabetical and
   * `checklist-`/`damage-` sort ahead of `exterior-`, so an inspection with a
   * dozen damage close-ups produced a showroom gallery with no picture of the
   * car in it and a scratch macro as the advert thumbnail.
   */
  it('sorts every non-angle kind after every angle', () => {
    const order = sorted([
      'damage-aaa',
      'checklist-1',
      'thickness-hood',
      'exterior-diag_rear_right',
      'repair-x',
      'zeroproof',
    ]);
    expect(order[0]).toBe('exterior-diag_rear_right');
    expect(order.slice(1)).toEqual([
      'thickness-hood',
      'zeroproof',
      'damage-aaa',
      'repair-x',
      'checklist-1',
    ]);
  });

  it('is a total order — equal kinds compare equal, and it is stable in a sort', () => {
    expect(comparePhotoKinds('exterior-front', 'exterior-front')).toBe(0);
    // Array.prototype.sort is stable, so two entries of one slot keep the order
    // they arrived in, which is capture order.
    const input = [
      { kind: 'exterior-extra', id: 'a' },
      { kind: 'exterior-extra', id: 'b' },
      { kind: 'exterior-extra', id: 'c' },
    ];
    expect(
      [...input].sort((x, y) => comparePhotoKinds(x.kind, y.kind)).map((x) => x.id),
    ).toEqual(['a', 'b', 'c']);
  });

  it('gives unknown kinds a defined, repeatable rank rather than throwing', () => {
    expect(photoSortRank('something-new')).toBe(photoSortRank('something-else'));
    expect(sorted(['zzz', 'aaa'])).toEqual(['aaa', 'zzz']);
    expect(() => comparePhotoKinds(null, undefined)).not.toThrow();
  });

  it('ranks all 17 required exterior angles ahead of anything else', () => {
    const exterior = CATALOG_V1.angles.filter((a) => a.group === 'exterior');
    expect(exterior).toHaveLength(17);
    const worstExterior = Math.max(...exterior.map((a) => photoSortRank(`exterior-${a.id}`)));
    expect(worstExterior).toBeLessThan(photoSortRank('wheel-fl'));
    expect(worstExterior).toBeLessThan(photoSortRank('damage-x'));
  });
});
