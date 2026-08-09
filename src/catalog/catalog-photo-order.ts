import { CATALOG_V1 } from './catalog.data';

/**
 * Turning a mobile photo slot key into a catalog angle, and putting a report's
 * photos in the order a human would look at them.
 *
 * Deliberately a plain module and not a Nest provider: both `src/reports/`
 * (which writes the manifest) and `src/listings/` (which reads it) need the
 * SAME rule, and the two must never disagree — a photo mirrored into the public
 * bucket under one order and read back under another is a broken image on a
 * live advert. A shared module makes that impossible; two injected copies of
 * the logic would not.
 *
 * It imports only `catalog.data.ts`, which imports nothing, so there is no
 * cycle. The i18n merge mutates label objects in place and never touches ids or
 * `order`, so reading the catalog at module scope is safe.
 */

/** `exterior-`, `interior-`, `wheel-`, … — the mobile slot-key prefixes. */
const GROUP_PREFIXES = ['exterior-', 'interior-', 'wheel-'] as const;

const ANGLE_IDS = new Set(CATALOG_V1.angles.map((a) => a.id));

const ANGLE_BY_ID = new Map(CATALOG_V1.angles.map((a) => [a.id, a] as const));

/**
 * How high a group sorts. Exterior first because a buyer opening an advert
 * wants the car, then its wheels, then its cabin.
 */
const GROUP_RANK: Record<string, number> = {
  exterior: 0,
  wheel: 1,
  interior: 2,
  misc: 3,
};

/**
 * Kinds that are not angles at all, ranked among themselves. They sort AFTER
 * every angle, which is the entire point of this module.
 *
 * Until 2026-08-10 the manifest was ordered by `kind ASC`, and `checklist-` and
 * `damage-` sort before `exterior-` in ASCII. A report with a dozen damage
 * close-ups therefore produced a showroom gallery containing no picture of the
 * car, and made a scratch macro the advert's thumbnail.
 */
const NON_ANGLE_RANK: ReadonlyArray<readonly [string, number]> = [
  ['thickness-', 0],
  ['zeroproof', 1],
  ['obd', 2],
  ['service', 3],
  ['underbody-rust', 4],
  ['damage-', 5],
  ['repair-', 6],
  ['checklist-', 7],
];

const NON_ANGLE_BASE = 4000;
const NON_ANGLE_FALLBACK = NON_ANGLE_BASE + 100;

/**
 * The bare catalog angle id behind a mobile photo slot key, or `undefined`.
 *
 * Returns the BARE id (`diag_front_left`), not the slot key
 * (`exterior-diag_front_left`): `angle` sits beside `kind` in the manifest, so
 * repeating the prefix would carry no information, and the website's label
 * index is keyed by bare id, making this a direct lookup in a render path.
 *
 * It never invents an id the catalog does not contain. `vin` in particular is
 * NOT mapped to the `vin_plate` angle — guessing at a near-match is how a
 * caption ends up describing the wrong photo.
 */
export function angleForKind(kind: string | null | undefined): string | undefined {
  if (typeof kind !== 'string' || kind.length === 0) return undefined;

  // Exact match first: the misc angles (`odometer`) and any legacy manifest
  // written before slot keys carried a group prefix (`front`, `rear`).
  if (ANGLE_IDS.has(kind)) return kind;

  for (const prefix of GROUP_PREFIXES) {
    if (!kind.startsWith(prefix)) continue;
    const rest = kind.slice(prefix.length);
    // `exterior-diag_front_left` -> `diag_front_left`,
    // `interior-interior_front` -> `interior_front` (the catalog id already
    // carries its own prefix).
    if (ANGLE_IDS.has(rest)) return rest;
    // `wheel-fl` -> `wheel_fl`: the slot key hyphenates where the catalog id
    // uses an underscore.
    const joined = `${prefix.slice(0, -1)}_${rest}`;
    if (ANGLE_IDS.has(joined)) return joined;
    return undefined;
  }

  return undefined;
}

/**
 * Sort rank for a photo slot key. Lower sorts first.
 *
 * Angles rank by group and then by the catalog's own `order`, so the gallery
 * follows the inspector's walk-around: the front-left three-quarter opens the
 * advert, and the boot and engine-bay shots sit where they were taken.
 */
export function photoSortRank(kind: string | null | undefined): number {
  const angleId = angleForKind(kind);
  if (angleId !== undefined) {
    const angle = ANGLE_BY_ID.get(angleId)!;
    return (GROUP_RANK[angle.group] ?? 3) * 1000 + angle.order;
  }
  const key = typeof kind === 'string' ? kind : '';
  for (const [prefix, rank] of NON_ANGLE_RANK) {
    if (key.startsWith(prefix)) return NON_ANGLE_BASE + rank;
  }
  return NON_ANGLE_FALLBACK;
}

/**
 * Comparator over photo slot keys. Callers must keep their sort STABLE, so
 * photos sharing a rank stay in `position` order — a slot can hold more than
 * one shot (`exterior-extra`, `damage-<id>`), and capture order is the only
 * meaningful order within it.
 */
export function comparePhotoKinds(a: string | null | undefined, b: string | null | undefined): number {
  const byRank = photoSortRank(a) - photoSortRank(b);
  if (byRank !== 0) return byRank;
  // Lexical tiebreak so two different unknown kinds have a defined order and a
  // re-run of the mirror produces a byte-identical manifest.
  return String(a ?? '').localeCompare(String(b ?? ''));
}
