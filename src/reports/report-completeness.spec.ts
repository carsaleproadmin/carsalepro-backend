import {
  countMissing,
  currentRequiredAngles,
  evaluateCompleteness,
  resolveRequiredAngles,
  resolveRequiredPanels,
  thicknessPanelIds,
} from './report-completeness';

/**
 * The gate that replaced the quality-score threshold on 2026-08-13.
 *
 * The cases below are written to pin the two things that make this rule
 * different from the score it replaced: a paint panel needs a reading AND a
 * photo (the score accepted either), and a wheel needs all four of photo,
 * tread, DOT and size (the score accepted tread OR a condition word).
 */

const LEGACY_8 = [
  'diag_front_left',
  'left',
  'diag_rear_left',
  'rear',
  'front',
  'diag_front_right',
  'right',
  'diag_rear_right',
];

/** The paint-thickness stations that shipped before the four door sills. */
const LEGACY_PANELS_13 = [
  'roof_rear_left',
  'fender_rear_left',
  'door_rear_left',
  'opening_left',
  'door_front_left',
  'fender_front_left',
  'hood',
  'fender_front_right',
  'door_front_right',
  'opening_right',
  'door_rear_right',
  'fender_rear_right',
  'trunk_lid',
];

/** A payload that satisfies every family. The base for the negative cases. */
function completePayload() {
  return {
    wheels: ['fl', 'fr', 'rl', 'rr'].map((corner) => ({
      corner,
      treadMm: 6.5,
      dot: '2419',
      sizeSpec: '205 / 55 R 16',
    })),
    thickness: {
      panels: thicknessPanelIds().map((panelId) => ({ panelId, um: 120 })),
    },
    photos: [
      ...currentRequiredAngles().map((id) => ({ kind: `exterior-${id}` })),
      ...thicknessPanelIds().map((id) => ({ kind: `thickness-${id}` })),
      { kind: 'zeroproof' },
      { kind: 'zeroproof-al' },
      ...['fl', 'fr', 'rl', 'rr'].map((c) => ({ kind: `wheel-${c}` })),
    ],
  };
}

describe('evaluateCompleteness', () => {
  it('accepts a payload covering every required element', () => {
    const r = evaluateCompleteness(completePayload());
    expect(r.evaluable).toBe(true);
    expect(r.complete).toBe(true);
    expect(countMissing(r.missing)).toBe(0);
  });

  it('reports "not evaluable" rather than "incomplete" with no payload', () => {
    // The distinction is the whole reason there are two error codes: a missing
    // payload means an old app, and telling that inspector their work is poor
    // sends them back to a car that was fine.
    for (const input of [null, undefined, 'not an object', 42]) {
      const r = evaluateCompleteness(input);
      expect(r.evaluable).toBe(false);
      expect(r.complete).toBe(false);
    }
  });

  it('names the exterior angles that were not photographed', () => {
    const data = completePayload();
    const dropped = currentRequiredAngles().slice(0, 3);
    data.photos = data.photos.filter(
      (p) => !dropped.some((id) => p.kind === `exterior-${id}`),
    );
    const r = evaluateCompleteness(data);
    expect(r.complete).toBe(false);
    expect(r.missing.exteriorAngles.sort()).toEqual([...dropped].sort());
  });

  it('refuses a paint panel that has a photo but no reading', () => {
    // The old score counted this panel as measured. This gate does not: a
    // picture of a gauge nobody transcribed is not a measurement.
    const data = completePayload();
    const target = thicknessPanelIds()[0];
    data.thickness.panels = data.thickness.panels.filter(
      (p) => p.panelId !== target,
    );
    const r = evaluateCompleteness(data);
    expect(r.complete).toBe(false);
    expect(r.missing.thicknessValues).toEqual([target]);
    expect(r.missing.thicknessPhotos).toEqual([]);
  });

  it('refuses a paint panel that has a reading but no photo', () => {
    // The mirror of the case above, and the other half of what the score let
    // through: a number with no picture cannot be audited.
    const data = completePayload();
    const target = thicknessPanelIds()[1];
    data.photos = data.photos.filter((p) => p.kind !== `thickness-${target}`);
    const r = evaluateCompleteness(data);
    expect(r.complete).toBe(false);
    expect(r.missing.thicknessPhotos).toEqual([target]);
    expect(r.missing.thicknessValues).toEqual([]);
  });

  it('refuses a missing calibration reference, and names which one', () => {
    const data = completePayload();
    data.photos = data.photos.filter((p) => p.kind !== 'zeroproof-al');
    const r = evaluateCompleteness(data);
    expect(r.complete).toBe(false);
    expect(r.missing.calibration).toEqual(['zeroproof-al']);
  });

  it('refuses a wheel missing any one of photo, tread, DOT or size', () => {
    const cases: { drop: string; expect: string }[] = [
      { drop: 'photo', expect: 'photo' },
      { drop: 'treadMm', expect: 'treadMm' },
      { drop: 'dot', expect: 'dot' },
      { drop: 'sizeSpec', expect: 'sizeSpec' },
    ];
    for (const c of cases) {
      const data = completePayload();
      if (c.drop === 'photo') {
        data.photos = data.photos.filter((p) => p.kind !== 'wheel-rr');
      } else {
        const w = data.wheels.find((x) => x.corner === 'rr')!;
        delete (w as Record<string, unknown>)[c.drop];
      }
      const r = evaluateCompleteness(data);
      expect(r.complete).toBe(false);
      expect(r.missing.wheels).toEqual([
        { corner: 'rr', missing: [c.expect] },
      ]);
    }
  });

  it('treats an empty or blank DOT as absent', () => {
    const data = completePayload();
    data.wheels.find((w) => w.corner === 'fl')!.dot = '   ';
    const r = evaluateCompleteness(data);
    expect(r.complete).toBe(false);
    expect(r.missing.wheels[0].missing).toContain('dot');
  });

  it('counts every gap, so a refusal can say how many', () => {
    const data = completePayload();
    data.photos = data.photos.filter((p) => p.kind !== 'zeroproof');
    data.wheels = data.wheels.filter((w) => w.corner !== 'fl');
    const r = evaluateCompleteness(data);
    // One calibration slot, plus the fl wheel (missing all four of its fields
    // counts as one incomplete wheel, not four gaps).
    expect(countMissing(r.missing)).toBe(2);
  });
});

describe('resolveRequiredAngles — the legacy amnesty', () => {
  it('judges a complete legacy 8-angle report by the legacy set', () => {
    // The walk-around grew from 8 angles to 17 on 2026-08-10. Without this,
    // every report filed by an older build becomes permanently un-closable and
    // its inspector cannot be paid for work that was correct when it was done.
    const resolved = resolveRequiredAngles(new Set(LEGACY_8));
    expect(resolved.sort()).toEqual([...LEGACY_8].sort());
  });

  it('judges a report that knows the newer angles by the current set', () => {
    // An inspector must not be able to opt into the lenient rule by skipping
    // the new shots: showing ONE new angle proves the build knows about them.
    const newAngle = currentRequiredAngles().find((id) => !LEGACY_8.includes(id));
    expect(newAngle).toBeDefined();
    const resolved = resolveRequiredAngles(new Set([...LEGACY_8, newAngle!]));
    expect(resolved).toEqual(currentRequiredAngles());
  });

  it('judges an incomplete legacy report by the current set', () => {
    // Missing angles are missing either way; the amnesty is for reports that
    // were COMPLETE under the old rule, not for partial ones.
    const resolved = resolveRequiredAngles(new Set(LEGACY_8.slice(0, 5)));
    expect(resolved).toEqual(currentRequiredAngles());
  });

  it('accepts a complete legacy payload end to end', () => {
    const data = completePayload();
    data.photos = [
      ...LEGACY_8.map((id) => ({ kind: `exterior-${id}` })),
      ...data.photos.filter((p) => !p.kind.startsWith('exterior-')),
    ];
    const r = evaluateCompleteness(data);
    expect(r.complete).toBe(true);
    expect(r.exteriorAngleCount).toBe(8);
  });
});

describe('resolveRequiredPanels — the legacy amnesty for paint stations', () => {
  it('judges a 13-panel payload by the 13 it knows about', () => {
    // The case this exists for. Four door sills were added on 2026-08-19, and
    // CATALOG_VERSION did not change, so every installed build keeps sending
    // thirteen for weeks. Without the amnesty each one is refused with eight
    // missing elements — four readings and four photographs — that its own
    // interface cannot collect.
    expect(resolveRequiredPanels(new Set(LEGACY_PANELS_13))).toEqual(
      LEGACY_PANELS_13,
    );
  });

  it('judges a payload that names any sill by the full current set', () => {
    const knowsSills = new Set([...LEGACY_PANELS_13, 'sill_rear_left']);
    expect(resolveRequiredPanels(knowsSills)).toEqual(thicknessPanelIds());
  });

  it('judges an incomplete legacy payload by the current set', () => {
    // Same rule as the angles: the amnesty is for reports that were COMPLETE
    // under the old catalog, never for partial ones.
    expect(resolveRequiredPanels(new Set(LEGACY_PANELS_13.slice(0, 6)))).toEqual(
      thicknessPanelIds(),
    );
  });

  it('accepts a complete 13-panel payload end to end', () => {
    const data = completePayload();
    data.thickness = {
      panels: LEGACY_PANELS_13.map((panelId) => ({ panelId, um: 120 })),
    };
    data.photos = [
      ...data.photos.filter((p) => !p.kind.startsWith('thickness-')),
      ...LEGACY_PANELS_13.map((id) => ({ kind: `thickness-${id}` })),
    ];
    const r = evaluateCompleteness(data);
    expect(r.complete).toBe(true);
    expect(countMissing(r.missing)).toBe(0);
  });

  it('a PHOTOGRAPH of a sill is enough to opt into the current set', () => {
    // A station is "mentioned" by a reading or by a photograph. An inspector
    // who photographed the sill without typing its number has proved the build
    // knows the station exists, which is what is being detected here.
    const data = completePayload();
    data.thickness = {
      panels: LEGACY_PANELS_13.map((panelId) => ({ panelId, um: 120 })),
    };
    const r = evaluateCompleteness(data);
    expect(r.complete).toBe(false);
    expect(r.missing.thicknessValues).toContain('sill_rear_left');
    expect(r.missing.thicknessPhotos).toHaveLength(0);
  });
});
