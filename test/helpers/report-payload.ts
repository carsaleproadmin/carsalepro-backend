import {
  currentRequiredAngles,
  thicknessPanelIds,
} from '../../src/reports/report-completeness';

/**
 * A `reportData` v1 payload that satisfies the completeness gate.
 *
 * It lives in `helpers/` because four e2e suites need one and each of them
 * would otherwise carry its own copy of the same 36-slot photo manifest. When
 * the gate gains a family, one file changes and every suite follows — a fixture
 * duplicated per suite is a fixture that goes stale in three of them.
 *
 * The angle and panel ids are DERIVED from the catalog rather than listed,
 * because growing the walk-around must not turn every unrelated order suite
 * red. Which ids the catalog actually holds is pinned by `catalog.e2e-spec.ts`
 * and `report-completeness.spec.ts`; that is not this fixture's job.
 */

/** The walk-around as it stood before 2026-08-10. See the legacy amnesty. */
export const LEGACY_EXTERIOR_ANGLES_8 = [
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
 * A `type` and not an `interface` on purpose: only a type alias picks up an
 * implicit index signature, which is what lets a fixture be handed straight to
 * Prisma's `Json` input without a cast at every call site.
 */
export type CompleteReportData = {
  schemaVersion: 1;
  vehicle: { make?: string; model?: string; vin?: string };
  checklist: { itemNumber: number; state: string }[];
  wheels: {
    corner: string;
    treadMm?: number;
    dot?: string;
    sizeSpec?: string;
    tyreBrand?: string;
  }[];
  thickness: { panels: { panelId: string; um?: number }[] };
  photos: { kind: string }[];
  scores: { qualityScore: number };
};

/**
 * Every required element, with its reading AND its photo.
 *
 * `vehicle` defaults to the car the order suites create, because the vehicle
 * check runs BEFORE the gate — a fixture describing a different car would make
 * every completeness case fail as a mismatch instead.
 */
export function completeReportData(
  vehicle: CompleteReportData['vehicle'] = { make: 'BMW', model: '320d' },
): CompleteReportData {
  return {
    schemaVersion: 1,
    vehicle,
    checklist: [{ itemNumber: 1, state: 'ok' }],
    wheels: ['fl', 'fr', 'rl', 'rr'].map((corner) => ({
      corner,
      treadMm: 6.5,
      dot: '2419',
      sizeSpec: '205 / 55 R 16',
      // Additive since 2026-08-13. Carried here so the suites prove a newer
      // app's extra field still validates rather than 400-ing the whole report.
      tyreBrand: 'Continental',
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
    // Deliberately high. The score is still stored and still shown; a suite
    // that sets it to 100 and is still refused proves it no longer decides.
    scores: { qualityScore: 100 },
  };
}

/**
 * The same payload as an app that only ever knew the 8-angle walk-around would
 * file it: complete under the rule it was built for, and blind to the nine
 * angles added afterwards.
 */
export function legacyReportData(
  vehicle?: CompleteReportData['vehicle'],
): CompleteReportData {
  const data = completeReportData(vehicle);
  data.photos = [
    ...LEGACY_EXTERIOR_ANGLES_8.map((id) => ({ kind: `exterior-${id}` })),
    ...data.photos.filter((p) => !p.kind.startsWith('exterior-')),
  ];
  return data;
}

/** Remove one photo slot, so a suite can name the single element it drops. */
export function dropPhotoKind(
  data: CompleteReportData,
  kind: string,
): CompleteReportData {
  data.photos = data.photos.filter((p) => p.kind !== kind);
  return data;
}
