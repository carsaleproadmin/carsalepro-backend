import { CATALOG_V1 } from '../catalog/catalog.data';

/**
 * Whether a report actually documents the car, judged from its `reportData`
 * payload alone.
 *
 * Deliberately a plain module and not a Nest provider, for the same reason as
 * `catalog/catalog-photo-order.ts`: both `src/reports/` (which receives the
 * payload) and `src/orders/` (which closes the order) must apply the SAME rule.
 * Two injected copies could drift, and a report accepted on one path and
 * refused on the other is a support ticket nobody can reproduce. It imports
 * only `catalog.data.ts`, which imports nothing, so there is no cycle.
 *
 * ## Why this replaced the score gate (2026-08-13)
 *
 * Until now an order could only be closed with a report scoring at least
 * `minReportQualityScore`. A score is a weighted average, so it let a genuinely
 * missing family of evidence be paid for by another: a report with no wheel
 * photos at all could still clear 90 on the strength of its exterior walk.
 * The client asked for the opposite rule — every required element present, and
 * a photograph for each — so the question stopped being "how good is this?" and
 * became "is anything missing?".
 *
 * Note this is STRICTER than the score in two specific places, and both are
 * deliberate:
 *
 *  - the score counted a paint panel as measured with a reading **or** a photo;
 *    this requires **both**, because a number with no picture cannot be
 *    audited and a picture with no number was never read;
 *  - the score counted a wheel with tread **or** a condition word; this
 *    requires the photo, the tread, the DOT code and the size.
 *
 * A report that scores 100 today can therefore fail this gate. That is the
 * point, and it is why `evaluate` reports WHICH elements are missing rather
 * than a pass/fail — the inspector has to be told what to go back for.
 *
 * ## Why old reports are judged by an old yardstick
 *
 * The required exterior walk grew from 8 angles to 17 on 2026-08-10. A report
 * filed by a build that only knew about 8 can never satisfy a 17-angle rule, no
 * matter how well it was done, and its inspector would be permanently unable to
 * close a paid order. So when a payload covers a known older angle set
 * completely, it is judged against that set. See [resolveRequiredAngles].
 */

/** Slot-key prefixes the mobile app uses. Must match `PhotoKind` in the app. */
const EXTERIOR_PREFIX = 'exterior-';
const THICKNESS_PREFIX = 'thickness-';
const WHEEL_PREFIX = 'wheel-';
const INTERIOR_PREFIX = 'interior-';
const DAMAGE_PREFIX = 'damage-';

/** The two gauge-calibration reference shots, ferrous and non-ferrous. */
const CALIBRATION_KINDS = ['zeroproof', 'zeroproof-al'] as const;

/** The four corners, in report reading order. */
const WHEEL_CORNERS = ['fl', 'fr', 'rl', 'rr'] as const;

/**
 * The exterior angle sets this gate recognises, newest first.
 *
 * `current` is whatever the catalog says today. `legacy8` is the walk-around
 * that shipped before 2026-08-10, listed explicitly rather than derived: the
 * whole purpose is to keep judging old reports by the rule they were filed
 * under, and a derived list would silently follow the catalog forward.
 */
const LEGACY_EXTERIOR_ANGLES_8 = [
  'diag_front_left',
  'left',
  'diag_rear_left',
  'rear',
  'front',
  'diag_front_right',
  'right',
  'diag_rear_right',
] as const;

/**
 * The paint-thickness stations that shipped before 2026-08-19.
 *
 * Same purpose as [LEGACY_EXTERIOR_ANGLES_8], and it exists because the panels
 * had NO such escape hatch when four door sills were added. Unlike a catalog
 * angle, a station is required unconditionally, so the moment this service
 * deployed with seventeen panels every phone still carrying the thirteen-panel
 * bundle would have been refused with eight missing elements — four readings
 * and four photographs — that its own interface cannot collect. `CATALOG_VERSION`
 * is still `'1'`, so those builds keep thirteen panels until the app is updated,
 * which is weeks.
 */
const LEGACY_THICKNESS_PANELS_13 = [
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
] as const;

export type CompletenessMissing = {
  /** Catalog angle ids with no `exterior-<id>` photo. */
  exteriorAngles: string[];
  /** Catalog panel ids with no `um` reading. */
  thicknessValues: string[];
  /** Catalog panel ids with no `thickness-<id>` photo. */
  thicknessPhotos: string[];
  /** Missing calibration slots: `zeroproof` and/or `zeroproof-al`. */
  calibration: string[];
  /** Per corner, which of photo / treadMm / dot / sizeSpec is absent. */
  wheels: { corner: string; missing: string[] }[];
  /**
   * `['photo']` when the payload has no `interior-<id>` photo at all, else
   * empty. One cabin photo is enough (client decision, 2026-10-06).
   */
  interior: string[];
  /**
   * Per damage row, which of part / type / photo is absent. A report with no
   * damage rows is complete: a clean car has none.
   */
  damages: { id: string; missing: string[] }[];
};

export type CompletenessResult = {
  /**
   * False when there is no v1 payload to judge — an older app, or a report
   * filed before the structured payload existed. NOT the same as incomplete:
   * the caller must say "update your app", not "your inspection is poor".
   */
  evaluable: boolean;
  complete: boolean;
  /** Which angle set was applied, for the refusal message and for tests. */
  exteriorAngleCount: number;
  missing: CompletenessMissing;
};

type Payload = {
  wheels?: unknown;
  damages?: unknown;
  thickness?: unknown;
  photos?: unknown;
  scores?: unknown;
};

/**
 * True when the app that made the report tells the inspector about the cabin
 * photo and the damage rows (DEN-451).
 *
 * The two rules came on 2026-10-06 (DEN-439). An app build from before that
 * did not show them to the inspector, and reports it made are already on the
 * server. Refusing such a report at attach time would send an inspector back
 * to a car he can no longer reach, for a rule he was never shown. The first
 * build that shows the rules (mobile PR #9) also sends
 * `scores.breakdown.method`, so its presence marks a report that can be held
 * to them. The same idea as `resolveRequiredAngles` above: a report is held to
 * the rules its app knew.
 */
export function appKnowsCabinAndDamageRules(data: Payload): boolean {
  const scores = data.scores;
  if (!scores || typeof scores !== 'object') return false;
  const breakdown = (scores as { breakdown?: unknown }).breakdown;
  if (!breakdown || typeof breakdown !== 'object') return false;
  return isNonEmptyString((breakdown as { method?: unknown }).method);
}

const EMPTY_MISSING: CompletenessMissing = {
  exteriorAngles: [],
  thicknessValues: [],
  thicknessPhotos: [],
  calibration: [],
  wheels: [],
  interior: [],
  damages: [],
};

/** Every required exterior angle id in today's catalog. */
export function currentRequiredAngles(): string[] {
  return CATALOG_V1.angles.filter((a) => a.group === 'exterior' && a.required).map((a) => a.id);
}

/** Every guided paint-thickness station id in today's catalog. */
export function thicknessPanelIds(): string[] {
  return CATALOG_V1.thicknessPanels.map((p) => p.id);
}

/**
 * Which angle set to judge this payload by.
 *
 * The current set wins whenever the payload could plausibly satisfy it — that
 * is, whenever it carries at least one angle the current set has and the legacy
 * set does not. Only a payload that covers the legacy 8 and shows no sign of
 * knowing about the newer angles is judged leniently, so an inspector cannot
 * opt into the old rule by simply skipping the new shots.
 */
export function resolveRequiredAngles(capturedAngleIds: Set<string>): string[] {
  const current = currentRequiredAngles();
  const legacy = new Set<string>(LEGACY_EXTERIOR_ANGLES_8);
  const knowsNewAngles = current.some((id) => !legacy.has(id) && capturedAngleIds.has(id));
  if (knowsNewAngles) return current;

  const coversLegacy = LEGACY_EXTERIOR_ANGLES_8.every((id) => capturedAngleIds.has(id));
  return coversLegacy ? [...LEGACY_EXTERIOR_ANGLES_8] : current;
}

/**
 * Which paint-thickness station set to judge this payload by.
 *
 * The same rule as [resolveRequiredAngles], and deliberately the same shape so
 * the two read as one policy: a payload that names ANY station the current set
 * has and the legacy set does not is judged by the current set. Everything else
 * falls back to the thirteen, because a build that cannot show the four door
 * sills must not be refused for not having them.
 *
 * [measuredPanelIds] is every station the payload mentions at all — a reading
 * or a photograph is equally good evidence that the app knows the station
 * exists, which is what is being detected here rather than completeness.
 */
export function resolveRequiredPanels(measuredPanelIds: Set<string>): string[] {
  const current = thicknessPanelIds();
  const legacy = new Set<string>(LEGACY_THICKNESS_PANELS_13);
  const knowsNewPanels = current.some((id) => !legacy.has(id) && measuredPanelIds.has(id));
  if (knowsNewPanels) return current;

  const coversLegacy = LEGACY_THICKNESS_PANELS_13.every((id) => measuredPanelIds.has(id));
  return coversLegacy ? [...LEGACY_THICKNESS_PANELS_13] : current;
}

/**
 * Judges [reportData]. Never throws — the caller decides what a gap means.
 *
 * The photo evidence comes from the payload's `photos[].kind` manifest and NOT
 * from uploaded files, because this runs inside `POST /reports`, before any
 * photo has been uploaded: no `ReportPhoto` row exists yet. The manifest is the
 * only evidence available at gate time, and it is validated by
 * `ReportPhotoMetaDto`.
 */
export function evaluateCompleteness(reportData: unknown): CompletenessResult {
  if (!reportData || typeof reportData !== 'object') {
    return {
      evaluable: false,
      complete: false,
      exteriorAngleCount: 0,
      missing: EMPTY_MISSING,
    };
  }

  const data = reportData as Payload;
  const photoKinds = new Set(
    (Array.isArray(data.photos) ? data.photos : [])
      .map((p) => (p && typeof p === 'object' ? (p as { kind?: unknown }).kind : undefined))
      .filter((k): k is string => typeof k === 'string'),
  );

  const capturedAngles = new Set(
    [...photoKinds]
      .filter((k) => k.startsWith(EXTERIOR_PREFIX))
      .map((k) => k.slice(EXTERIOR_PREFIX.length)),
  );
  const requiredAngles = resolveRequiredAngles(capturedAngles);
  const exteriorAngles = requiredAngles.filter((id) => !capturedAngles.has(id));

  // Panels: a reading AND a photo of the gauge showing it.
  const panels = new Map<string, number | undefined>();
  const thickness = data.thickness;
  if (thickness && typeof thickness === 'object') {
    const list = (thickness as { panels?: unknown }).panels;
    if (Array.isArray(list)) {
      for (const p of list) {
        if (!p || typeof p !== 'object') continue;
        const row = p as { panelId?: unknown; um?: unknown };
        if (typeof row.panelId !== 'string') continue;
        panels.set(row.panelId, typeof row.um === 'number' ? row.um : undefined);
      }
    }
  }
  // Every station the payload mentions in either way — a reading or a
  // photograph — so a build that photographed a sill without typing its number
  // is still recognised as knowing the sill exists.
  const mentionedPanels = new Set<string>(panels.keys());
  for (const kind of photoKinds) {
    if (kind.startsWith(THICKNESS_PREFIX)) {
      mentionedPanels.add(kind.slice(THICKNESS_PREFIX.length));
    }
  }

  const thicknessValues: string[] = [];
  const thicknessPhotos: string[] = [];
  for (const id of resolveRequiredPanels(mentionedPanels)) {
    if (panels.get(id) === undefined) thicknessValues.push(id);
    if (!photoKinds.has(`${THICKNESS_PREFIX}${id}`)) thicknessPhotos.push(id);
  }

  const calibration = CALIBRATION_KINDS.filter((k) => !photoKinds.has(k));

  const wheelRows = new Map<string, Record<string, unknown>>();
  if (Array.isArray(data.wheels)) {
    for (const w of data.wheels) {
      if (!w || typeof w !== 'object') continue;
      const row = w as { corner?: unknown };
      if (typeof row.corner === 'string') {
        wheelRows.set(row.corner, w as Record<string, unknown>);
      }
    }
  }
  const wheels: CompletenessMissing['wheels'] = [];
  for (const corner of WHEEL_CORNERS) {
    const row = wheelRows.get(corner);
    const gaps: string[] = [];
    if (!photoKinds.has(`${WHEEL_PREFIX}${corner}`)) gaps.push('photo');
    if (typeof row?.treadMm !== 'number') gaps.push('treadMm');
    if (!isNonEmptyString(row?.dot)) gaps.push('dot');
    if (!isNonEmptyString(row?.sizeSpec)) gaps.push('sizeSpec');
    if (gaps.length > 0) wheels.push({ corner, missing: gaps });
  }

  const newRules = appKnowsCabinAndDamageRules(data);
  const interior =
    !newRules || [...photoKinds].some((k) => k.startsWith(INTERIOR_PREFIX)) ? [] : ['photo'];

  const damages: CompletenessMissing['damages'] = [];
  if (newRules && Array.isArray(data.damages)) {
    for (const [index, d] of data.damages.entries()) {
      if (!d || typeof d !== 'object') continue;
      const row = d as Record<string, unknown>;
      // A row without an id cannot have its photo (`damage-<id>`), so it is
      // incomplete. It used to be skipped, so it passed the gate.
      if (!isNonEmptyString(row.id)) {
        damages.push({ id: `#${index + 1}`, missing: ['id'] });
        continue;
      }
      const id = row.id as string;
      const gaps = damageGaps(row);
      if (!photoKinds.has(`${DAMAGE_PREFIX}${id}`)) gaps.push('photo');
      if (gaps.length > 0) damages.push({ id, missing: gaps });
    }
  }

  const missing: CompletenessMissing = {
    exteriorAngles,
    thicknessValues,
    thicknessPhotos,
    calibration: [...calibration],
    wheels,
    interior,
    damages,
  };

  return {
    evaluable: true,
    complete:
      exteriorAngles.length === 0 &&
      thicknessValues.length === 0 &&
      thicknessPhotos.length === 0 &&
      calibration.length === 0 &&
      wheels.length === 0 &&
      interior.length === 0 &&
      damages.length === 0,
    exteriorAngleCount: requiredAngles.length,
    missing,
  };
}

/** How many single elements are missing, for a one-line refusal message. */
export function countMissing(m: CompletenessMissing): number {
  return (
    m.exteriorAngles.length +
    m.thicknessValues.length +
    m.thicknessPhotos.length +
    m.calibration.length +
    m.wheels.length +
    m.interior.length +
    m.damages.length
  );
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Which of part / type a damage row lacks. The same rule as the mobile app's
 * `isDamageRowIncomplete`: a legacy `C<number>` checklist row carries its own
 * title, a free-text row needs its part and damage text, and every other row
 * needs a part id and a damage type id.
 */
function damageGaps(row: Record<string, unknown>): string[] {
  if (typeof row.kstCode === 'string' && /^C\d+$/.test(row.kstCode)) return [];
  const gaps: string[] = [];
  if (row.manualEntry === true) {
    if (!isNonEmptyString(row.manualPart)) gaps.push('part');
    if (!isNonEmptyString(row.manualDamage)) gaps.push('type');
    return gaps;
  }
  if (!isNonEmptyString(row.partId)) gaps.push('part');
  if (!isNonEmptyString(row.typeId)) gaps.push('type');
  return gaps;
}
