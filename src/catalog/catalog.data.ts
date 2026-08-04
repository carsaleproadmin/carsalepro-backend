/**
 * Canonical trilingual (DE / EN / RU) reference catalog for the CarSalePro
 * vehicle-inspection app.
 *
 * Single source of truth consumed by the backend's `GET /catalog` endpoint
 * and (later) bundled into the mobile app as a read-only asset.
 *
 * Transcribed from `docs/05_Списки_осмотра_и_повреждений.md` (catalog v1.1):
 *  - §1.3  — 8 exterior view angles
 *  - §2.1  — 36 K-codes (body / paint)
 *  - §2.2  —  5 S-codes (service)
 *  - §2.3  — 27 T-codes (technical condition / equipment)
 *  - §3.1–3.8 — 98 expert checklist items
 *  - §4.1  — parts catalog by zone
 *  - §4.2  — 10 damage types
 *  - §4.3  — severity tiers T1 / T2 / T3
 *
 * German is the primary market: DE labels use correct automotive terminology.
 *
 * Additive extensions (catalog version stays '1'):
 *  - `angles[].hint`   — capture instruction explaining the walk-around order.
 *  - `thicknessPanels` — the 13 guided paint-thickness (Lackdicke) stations.
 */

export interface LocalizedLabel {
  de: string;
  en: string;
  ru: string;
  /** Ukrainian — added incrementally; checklist items carry it first. */
  uk?: string;
}

export interface AngleDef {
  id: string;
  group: 'exterior' | 'interior' | 'wheel' | 'misc';
  order: number;
  label: LocalizedLabel;
  required: boolean;
  /**
   * Short capture instruction rendered under the angle label. Explains why the
   * required walk-around zigzags: the near front wheel is turned outward for
   * the diagonal shots and straightened again for the side shots.
   */
  hint?: LocalizedLabel;
}

export interface PartDef {
  id: string;
  zone: string;
  label: LocalizedLabel;
}

export interface DamageTypeDef {
  id: string;
  label: LocalizedLabel;
}

/**
 * A guided paint-thickness (Lackdicke) measurement station.
 *
 * `THICKNESS_PANELS` lists the stations in the inspector's walk order; each one
 * maps to a real `parts` id, so a suspicious reading can become a damage
 * without re-picking the panel.
 *
 * NOTE on panelId namespaces: the catalog ids below are the only canonical
 * ones. The mobile app also lets the inspector add ad-hoc measurements, stored
 * with an `extra_`-prefixed panelId (e.g. `extra_1`). The `extra_` prefix is
 * RESERVED for those user-added rows — never mint a catalog panel id starting
 * with `extra_` (same convention as the reserved `C` prefix for
 * checklist-derived damage codes, see the KstCodeDef note below).
 */
export interface ThicknessPanelDef {
  id: string;
  order: number;
  /** Matching `parts` entry — every panel resolves to one. */
  partId: string;
  label: LocalizedLabel;
}

/**
 * NOTE on code namespaces: K/S/T codes live here; the mobile app additionally
 * stores checklist-derived damages as synthetic `C<number>` codes (e.g. `C42`)
 * in the same `kstCode` column/payload field. The `C` prefix is RESERVED for
 * that mapping — never mint real KST codes starting with `C`.
 */
export interface KstCodeDef {
  code: string;
  group: 'K' | 'S' | 'T';
  partId: string | null;
  typeId: string | null;
  defaultTier: 'T1' | 'T2' | 'T3';
  label: LocalizedLabel;
}

export type ChecklistCategory =
  | 'body'
  | 'glass'
  | 'interior'
  | 'engine'
  | 'chassis'
  | 'completeness'
  | 'electronics'
  | 'operational';

export interface ChecklistItemDef {
  number: number;
  category: ChecklistCategory;
  label: LocalizedLabel;
  frequent: boolean;
  /**
   * Severity tier pre-selected when the check is added as a damage in the
   * mobile app's defect catalog (drives the default labour-hours cost).
   * Category baselines (interior/completeness T1, body/glass/electronics/
   * operational T2, engine/chassis T3) with per-item curated overrides.
   */
  defaultTier: 'T1' | 'T2' | 'T3';
  /** Affected part where unambiguous, else null (cost works without it). */
  partId: string | null;
}

export const CATALOG_VERSION = '1';

export interface CatalogV1 {
  version: string;
  angles: AngleDef[];
  parts: PartDef[];
  damageTypes: DamageTypeDef[];
  kstCodes: KstCodeDef[];
  checklist: ChecklistItemDef[];
  thicknessPanels: ThicknessPanelDef[];
}

// ---------------------------------------------------------------------------
// Angles (§1.3 + interior / wheel / misc additions)
// ---------------------------------------------------------------------------

const ANGLES: AngleDef[] = [
  // Walk-around order dictated by the inspector: diagonal (near front wheel
  // turned outward) → side (wheels straight) → front, then the same on the
  // right half and finally the rear. Ids/labels are unchanged; only `order` is.
  //
  // All eight required angles carry a `hint`, and the two kinds carry different
  // guidance on purpose — that difference IS the instruction. The four rear and
  // straight angles shipped without one until 2026-08-05, so the capture screen
  // showed no wheel guidance on half the walk-around (QA scenario 10).
  //
  // The diagonal hint deliberately does NOT name a side ("near front wheel",
  // not "left front wheel"): on a diagonal the near wheel is the one closest to
  // the camera and the label already says which corner you are standing at, and
  // the longer wording wrapped to a second line in RU/UK, which pushed the
  // capture screen's instruction box past what a 320 dp screen can host at the
  // 1.3 font clamp (`capture_instruction_budget_test.dart`).
  {
    id: 'diag_front_left',
    group: 'exterior',
    order: 1,
    required: true,
    label: {
      de: 'Diagonal vorne links',
      en: 'Front left (3/4)',
      ru: 'Диагональ спереди-слева',
      uk: 'Діагональ спереду-зліва',
    },
    hint: {
      de: 'Schlagen Sie das Vorderrad nach außen ein.',
      en: 'Turn the near front wheel outward.',
      ru: 'Поверните переднее колесо наружу.',
      uk: 'Поверніть переднє колесо назовні.',
    },
  },
  {
    id: 'left',
    group: 'exterior',
    order: 2,
    required: true,
    label: { de: 'Linke Seite', en: 'Left side', ru: 'Левая сторона', uk: 'Ліва сторона' },
    hint: {
      de: 'Stellen Sie die Räder gerade.',
      en: 'Keep the wheels straight.',
      ru: 'Поставьте колёса прямо.',
      uk: 'Поставте колеса прямо.',
    },
  },
  {
    id: 'front',
    group: 'exterior',
    order: 3,
    required: true,
    label: { de: 'Vorderansicht', en: 'Front view', ru: 'Вид спереди', uk: 'Вид спереду' },
    hint: {
      de: 'Stellen Sie die Räder gerade.',
      en: 'Keep the wheels straight.',
      ru: 'Поставьте колёса прямо.',
      uk: 'Поставте колеса прямо.',
    },
  },
  {
    id: 'diag_front_right',
    group: 'exterior',
    order: 4,
    required: true,
    label: {
      de: 'Diagonal vorne rechts',
      en: 'Front right (3/4)',
      ru: 'Диагональ спереди-справа',
      uk: 'Діагональ спереду-справа',
    },
    hint: {
      de: 'Schlagen Sie das Vorderrad nach außen ein.',
      en: 'Turn the near front wheel outward.',
      ru: 'Поверните переднее колесо наружу.',
      uk: 'Поверніть переднє колесо назовні.',
    },
  },
  {
    id: 'right',
    group: 'exterior',
    order: 5,
    required: true,
    label: { de: 'Rechte Seite', en: 'Right side', ru: 'Правая сторона', uk: 'Права сторона' },
    hint: {
      de: 'Stellen Sie die Räder gerade.',
      en: 'Keep the wheels straight.',
      ru: 'Поставьте колёса прямо.',
      uk: 'Поставте колеса прямо.',
    },
  },
  {
    id: 'diag_rear_right',
    group: 'exterior',
    order: 6,
    required: true,
    label: {
      de: 'Diagonal hinten rechts',
      en: 'Rear right (3/4)',
      ru: 'Диагональ сзади-справа',
      uk: 'Діагональ ззаду-справа',
    },
    hint: {
      de: 'Schlagen Sie das Vorderrad nach außen ein.',
      en: 'Turn the near front wheel outward.',
      ru: 'Поверните переднее колесо наружу.',
      uk: 'Поверніть переднє колесо назовні.',
    },
  },
  {
    id: 'rear',
    group: 'exterior',
    order: 7,
    required: true,
    label: { de: 'Rückansicht', en: 'Rear view', ru: 'Задняя часть', uk: 'Задня частина' },
    hint: {
      de: 'Stellen Sie die Räder gerade.',
      en: 'Keep the wheels straight.',
      ru: 'Поставьте колёса прямо.',
      uk: 'Поставте колеса прямо.',
    },
  },
  {
    id: 'diag_rear_left',
    group: 'exterior',
    order: 8,
    required: true,
    label: {
      de: 'Diagonal hinten links',
      en: 'Rear left (3/4)',
      ru: 'Диагональ сзади-слева',
      uk: 'Діагональ ззаду-зліва',
    },
    hint: {
      de: 'Schlagen Sie das Vorderrad nach außen ein.',
      en: 'Turn the near front wheel outward.',
      ru: 'Поверните переднее колесо наружу.',
      uk: 'Поверніть переднє колесо назовні.',
    },
  },
  {
    id: 'interior_front',
    group: 'interior',
    order: 9,
    required: false,
    label: {
      de: 'Innenraum vorne',
      en: 'Interior front',
      ru: 'Салон спереди',
      uk: 'Салон спереду',
    },
  },
  {
    id: 'interior_rear',
    group: 'interior',
    order: 10,
    required: false,
    label: { de: 'Innenraum hinten', en: 'Interior rear', ru: 'Салон сзади', uk: 'Салон ззаду' },
  },
  {
    id: 'interior_dashboard',
    group: 'interior',
    order: 11,
    required: false,
    label: {
      de: 'Armaturenbrett',
      en: 'Dashboard',
      ru: 'Приборная панель',
      uk: 'Приладова панель',
    },
  },
  {
    id: 'interior_boot',
    group: 'interior',
    order: 12,
    required: false,
    label: { de: 'Kofferraum', en: 'Boot / trunk', ru: 'Багажник', uk: 'Багажник' },
  },
  {
    id: 'interior_seats',
    group: 'interior',
    order: 13,
    required: false,
    label: { de: 'Sitze', en: 'Seats', ru: 'Сиденья', uk: 'Сидіння' },
  },
  {
    id: 'interior_steering_wheel',
    group: 'interior',
    order: 14,
    required: false,
    label: { de: 'Lenkrad', en: 'Steering wheel', ru: 'Руль', uk: 'Кермо' },
  },
  {
    id: 'interior_pedals',
    group: 'interior',
    order: 15,
    required: false,
    label: { de: 'Pedalerie', en: 'Pedals', ru: 'Педали', uk: 'Педалі' },
  },
  {
    id: 'interior_overview',
    group: 'interior',
    order: 16,
    required: false,
    label: {
      de: 'Innenraum Gesamtübersicht',
      en: 'Cabin overview',
      ru: 'Салон — общий вид',
      uk: 'Салон — загальний вигляд',
    },
  },
  {
    id: 'interior_door_trim_fl',
    group: 'interior',
    order: 17,
    required: false,
    label: {
      de: 'Türverkleidung vorne links',
      en: 'Front left door trim',
      ru: 'Обшивка двери передняя левая',
      uk: 'Обшивка дверей передня ліва',
    },
  },
  {
    id: 'interior_door_trim_fr',
    group: 'interior',
    order: 18,
    required: false,
    label: {
      de: 'Türverkleidung vorne rechts',
      en: 'Front right door trim',
      ru: 'Обшивка двери передняя правая',
      uk: 'Обшивка дверей передня права',
    },
  },
  {
    id: 'interior_door_trim_rl',
    group: 'interior',
    order: 19,
    required: false,
    label: {
      de: 'Türverkleidung hinten links',
      en: 'Rear left door trim',
      ru: 'Обшивка двери задняя левая',
      uk: 'Обшивка дверей задня ліва',
    },
  },
  {
    id: 'interior_door_trim_rr',
    group: 'interior',
    order: 20,
    required: false,
    label: {
      de: 'Türverkleidung hinten rechts',
      en: 'Rear right door trim',
      ru: 'Обшивка двери задняя правая',
      uk: 'Обшивка дверей задня права',
    },
  },
  {
    id: 'wheel_fl',
    group: 'wheel',
    order: 21,
    required: false,
    label: {
      de: 'Rad vorne links',
      en: 'Front left wheel',
      ru: 'Колесо переднее левое',
      uk: 'Колесо переднє ліве',
    },
  },
  {
    id: 'wheel_fr',
    group: 'wheel',
    order: 22,
    required: false,
    label: {
      de: 'Rad vorne rechts',
      en: 'Front right wheel',
      ru: 'Колесо переднее правое',
      uk: 'Колесо переднє праве',
    },
  },
  {
    id: 'wheel_rl',
    group: 'wheel',
    order: 23,
    required: false,
    label: {
      de: 'Rad hinten links',
      en: 'Rear left wheel',
      ru: 'Колесо заднее левое',
      uk: 'Колесо заднє ліве',
    },
  },
  {
    id: 'wheel_rr',
    group: 'wheel',
    order: 24,
    required: false,
    label: {
      de: 'Rad hinten rechts',
      en: 'Rear right wheel',
      ru: 'Колесо заднее правое',
      uk: 'Колесо заднє праве',
    },
  },
  {
    id: 'odometer',
    group: 'misc',
    order: 25,
    required: false,
    label: { de: 'Kilometerstand', en: 'Odometer', ru: 'Одометр', uk: 'Одометр' },
  },
  {
    id: 'vin_plate',
    group: 'misc',
    order: 26,
    required: false,
    label: { de: 'FIN-Schild', en: 'VIN plate', ru: 'Табличка VIN', uk: 'Табличка VIN' },
  },
];

// ---------------------------------------------------------------------------
// Parts (§4.1)
// ---------------------------------------------------------------------------

const PARTS: PartDef[] = [
  // front
  {
    id: 'bumper_front',
    zone: 'front',
    label: {
      de: 'Stoßfänger vorne',
      en: 'Front bumper',
      ru: 'Передний бампер',
      uk: 'Передній бампер',
    },
  },
  {
    id: 'hood',
    zone: 'front',
    label: { de: 'Motorhaube', en: 'Hood / bonnet', ru: 'Капот', uk: 'Капот' },
  },
  {
    id: 'grille',
    zone: 'front',
    label: {
      de: 'Kühlergrill',
      en: 'Radiator grille',
      ru: 'Решётка радиатора',
      uk: 'Решітка радіатора',
    },
  },
  {
    id: 'headlight_left',
    zone: 'front',
    label: { de: 'Scheinwerfer links', en: 'Left headlight', ru: 'Фара левая', uk: 'Фара ліва' },
  },
  {
    id: 'headlight_right',
    zone: 'front',
    label: {
      de: 'Scheinwerfer rechts',
      en: 'Right headlight',
      ru: 'Фара правая',
      uk: 'Фара права',
    },
  },
  {
    id: 'fog_light_left',
    zone: 'front',
    label: {
      de: 'Nebelscheinwerfer links',
      en: 'Left fog light',
      ru: 'Противотуманка левая',
      uk: 'Протитуманна фара ліва',
    },
  },
  {
    id: 'fog_light_right',
    zone: 'front',
    label: {
      de: 'Nebelscheinwerfer rechts',
      en: 'Right fog light',
      ru: 'Противотуманка правая',
      uk: 'Протитуманна фара права',
    },
  },
  {
    id: 'windshield',
    zone: 'front',
    label: { de: 'Frontscheibe', en: 'Windshield', ru: 'Лобовое стекло', uk: 'Лобове скло' },
  },

  // left
  {
    id: 'fender_front_left',
    zone: 'left',
    label: {
      de: 'Kotflügel vorne links',
      en: 'Front left fender',
      ru: 'Переднее левое крыло',
      uk: 'Переднє ліве крило',
    },
  },
  {
    id: 'door_front_left',
    zone: 'left',
    label: {
      de: 'Tür vorne links',
      en: 'Front left door',
      ru: 'Передняя левая дверь',
      uk: 'Передні ліві двері',
    },
  },
  {
    id: 'door_rear_left',
    zone: 'left',
    label: {
      de: 'Tür hinten links',
      en: 'Rear left door',
      ru: 'Задняя левая дверь',
      uk: 'Задні ліві двері',
    },
  },
  {
    id: 'sill_left',
    zone: 'left',
    label: {
      de: 'Schwellerverkleidung links',
      en: 'Left sill trim',
      ru: 'Накладка порога слева',
      uk: 'Накладка порога зліва',
    },
  },
  {
    id: 'pillar_b_left',
    zone: 'left',
    label: {
      de: 'B-Säule links',
      en: 'Left B-pillar',
      ru: 'Центральная стойка (B) слева',
      uk: 'Центральна стійка (B) зліва',
    },
  },
  {
    id: 'side_panel_rear_left',
    zone: 'left',
    label: {
      de: 'Seitenwand hinten links',
      en: 'Rear left side panel',
      ru: 'Задняя боковина слева',
      uk: 'Задня боковина зліва',
    },
  },
  {
    id: 'mirror_left',
    zone: 'left',
    label: {
      de: 'Außenspiegel links',
      en: 'Left mirror',
      ru: 'Зеркало левое',
      uk: 'Дзеркало ліве',
    },
  },
  {
    id: 'wheel_arch_front_left',
    zone: 'left',
    label: {
      de: 'Radlauf vorne links',
      en: 'Front left wheel arch',
      ru: 'Колёсная арка передняя левая',
      uk: 'Колісна арка передня ліва',
    },
  },
  {
    id: 'wheel_arch_rear_left',
    zone: 'left',
    label: {
      de: 'Radlauf hinten links',
      en: 'Rear left wheel arch',
      ru: 'Колёсная арка задняя левая',
      uk: 'Колісна арка задня ліва',
    },
  },
  {
    id: 'window_front_left',
    zone: 'left',
    label: {
      de: 'Seitenscheibe vorne links',
      en: 'Front left window',
      ru: 'Боковое стекло переднее левое',
      uk: 'Бокове скло переднє ліве',
    },
  },
  {
    id: 'window_rear_left',
    zone: 'left',
    label: {
      de: 'Seitenscheibe hinten links',
      en: 'Rear left window',
      ru: 'Боковое стекло заднее левое',
      uk: 'Бокове скло заднє ліве',
    },
  },

  // right (mirror of left)
  {
    id: 'fender_front_right',
    zone: 'right',
    label: {
      de: 'Kotflügel vorne rechts',
      en: 'Front right fender',
      ru: 'Переднее правое крыло',
      uk: 'Переднє праве крило',
    },
  },
  {
    id: 'door_front_right',
    zone: 'right',
    label: {
      de: 'Tür vorne rechts',
      en: 'Front right door',
      ru: 'Передняя правая дверь',
      uk: 'Передні праві двері',
    },
  },
  {
    id: 'door_rear_right',
    zone: 'right',
    label: {
      de: 'Tür hinten rechts',
      en: 'Rear right door',
      ru: 'Задняя правая дверь',
      uk: 'Задні праві двері',
    },
  },
  {
    id: 'sill_right',
    zone: 'right',
    label: {
      de: 'Schwellerverkleidung rechts',
      en: 'Right sill trim',
      ru: 'Накладка порога справа',
      uk: 'Накладка порога справа',
    },
  },
  {
    id: 'pillar_b_right',
    zone: 'right',
    label: {
      de: 'B-Säule rechts',
      en: 'Right B-pillar',
      ru: 'Центральная стойка (B) справа',
      uk: 'Центральна стійка (B) справа',
    },
  },
  {
    id: 'side_panel_rear_right',
    zone: 'right',
    label: {
      de: 'Seitenwand hinten rechts',
      en: 'Rear right side panel',
      ru: 'Задняя боковина справа',
      uk: 'Задня боковина справа',
    },
  },
  {
    id: 'mirror_right',
    zone: 'right',
    label: {
      de: 'Außenspiegel rechts',
      en: 'Right mirror',
      ru: 'Зеркало правое',
      uk: 'Дзеркало праве',
    },
  },
  {
    id: 'wheel_arch_front_right',
    zone: 'right',
    label: {
      de: 'Radlauf vorne rechts',
      en: 'Front right wheel arch',
      ru: 'Колёсная арка передняя правая',
      uk: 'Колісна арка передня права',
    },
  },
  {
    id: 'wheel_arch_rear_right',
    zone: 'right',
    label: {
      de: 'Radlauf hinten rechts',
      en: 'Rear right wheel arch',
      ru: 'Колёсная арка задняя правая',
      uk: 'Колісна арка задня права',
    },
  },
  {
    id: 'window_front_right',
    zone: 'right',
    label: {
      de: 'Seitenscheibe vorne rechts',
      en: 'Front right window',
      ru: 'Боковое стекло переднее правое',
      uk: 'Бокове скло переднє праве',
    },
  },
  {
    id: 'window_rear_right',
    zone: 'right',
    label: {
      de: 'Seitenscheibe hinten rechts',
      en: 'Rear right window',
      ru: 'Боковое стекло заднее правое',
      uk: 'Бокове скло заднє праве',
    },
  },

  // rear
  {
    id: 'bumper_rear',
    zone: 'rear',
    label: { de: 'Stoßfänger hinten', en: 'Rear bumper', ru: 'Задний бампер', uk: 'Задній бампер' },
  },
  {
    id: 'trunk_lid',
    zone: 'rear',
    label: {
      de: 'Heckklappe',
      en: 'Trunk lid / tailgate',
      ru: 'Крышка багажника / 5-я дверь',
      uk: 'Кришка багажника / 5-ті двері',
    },
  },
  {
    id: 'rear_window',
    zone: 'rear',
    label: { de: 'Heckscheibe', en: 'Rear window', ru: 'Заднее стекло', uk: 'Заднє скло' },
  },
  {
    id: 'tail_light_left',
    zone: 'rear',
    label: {
      de: 'Rückleuchte links',
      en: 'Left tail light',
      ru: 'Задний фонарь левый',
      uk: 'Задній ліхтар лівий',
    },
  },
  {
    id: 'tail_light_right',
    zone: 'rear',
    label: {
      de: 'Rückleuchte rechts',
      en: 'Right tail light',
      ru: 'Задний фонарь правый',
      uk: 'Задній ліхтар правий',
    },
  },
  {
    id: 'heckspoiler',
    zone: 'rear',
    label: { de: 'Heckspoiler', en: 'Rear spoiler', ru: 'Задний спойлер', uk: 'Задній спойлер' },
  },
  {
    id: 'license_plate_holder',
    zone: 'rear',
    label: {
      de: 'Kennzeichenhalter',
      en: 'License plate holder',
      ru: 'Рамка номерного знака',
      uk: 'Рамка номерного знака',
    },
  },

  // roof
  {
    id: 'roof',
    zone: 'roof',
    label: { de: 'Dach', en: 'Roof', ru: 'Крыша', uk: 'Дах' },
  },
  {
    id: 'panoramic_roof',
    zone: 'roof',
    label: {
      de: 'Panoramadach',
      en: 'Panoramic roof',
      ru: 'Панорамная крыша',
      uk: 'Панорамний дах',
    },
  },
  {
    id: 'antenna',
    zone: 'roof',
    label: { de: 'Antenne', en: 'Antenna', ru: 'Антенна', uk: 'Антена' },
  },

  // interior
  {
    id: 'dashboard',
    zone: 'interior',
    label: { de: 'Armaturenbrett', en: 'Dashboard', ru: 'Торпедо', uk: 'Торпедо' },
  },
  {
    id: 'steering_wheel',
    zone: 'interior',
    label: { de: 'Lenkrad', en: 'Steering wheel', ru: 'Руль', uk: 'Кермо' },
  },
  {
    id: 'gear_lever',
    zone: 'interior',
    label: { de: 'Schalthebel', en: 'Gear lever', ru: 'Рычаг КПП', uk: 'Важіль КПП' },
  },
  {
    id: 'seat_driver',
    zone: 'interior',
    label: { de: 'Fahrersitz', en: 'Driver seat', ru: 'Сиденье водителя', uk: 'Сидіння водія' },
  },
  {
    id: 'seat_passenger',
    zone: 'interior',
    label: {
      de: 'Beifahrersitz',
      en: 'Passenger seat',
      ru: 'Сиденье пассажира',
      uk: 'Сидіння пасажира',
    },
  },
  {
    id: 'seat_rear',
    zone: 'interior',
    label: { de: 'Rücksitzbank', en: 'Rear seat', ru: 'Заднее сиденье', uk: 'Заднє сидіння' },
  },
  {
    id: 'door_card_FL',
    zone: 'interior',
    label: {
      de: 'Türverkleidung vorne links',
      en: 'Front left door card',
      ru: 'Обшивка двери перед. лев.',
      uk: 'Обшивка дверей передня ліва',
    },
  },
  {
    id: 'door_card_FR',
    zone: 'interior',
    label: {
      de: 'Türverkleidung vorne rechts',
      en: 'Front right door card',
      ru: 'Обшивка двери перед. прав.',
      uk: 'Обшивка дверей передня права',
    },
  },
  {
    id: 'door_card_RL',
    zone: 'interior',
    label: {
      de: 'Türverkleidung hinten links',
      en: 'Rear left door card',
      ru: 'Обшивка двери задн. лев.',
      uk: 'Обшивка дверей задня ліва',
    },
  },
  {
    id: 'door_card_RR',
    zone: 'interior',
    label: {
      de: 'Türverkleidung hinten rechts',
      en: 'Rear right door card',
      ru: 'Обшивка двери задн. прав.',
      uk: 'Обшивка дверей задня права',
    },
  },
  {
    id: 'headliner',
    zone: 'interior',
    label: { de: 'Dachhimmel', en: 'Headliner', ru: 'Обшивка потолка', uk: 'Оббивка стелі' },
  },
  {
    id: 'sun_visor',
    zone: 'interior',
    label: {
      de: 'Sonnenblende',
      en: 'Sun visor',
      ru: 'Солнцезащитный козырёк',
      uk: 'Сонцезахисний козирок',
    },
  },
  {
    id: 'infotainment_screen',
    zone: 'interior',
    label: {
      de: 'Infotainment-Display',
      en: 'Infotainment screen',
      ru: 'Дисплей мультимедиа',
      uk: 'Дисплей мультимедіа',
    },
  },
  {
    id: 'instrument_cluster',
    zone: 'interior',
    label: {
      de: 'Kombiinstrument',
      en: 'Instrument cluster',
      ru: 'Приборная панель',
      uk: 'Приладова панель',
    },
  },
  {
    id: 'floor_mats',
    zone: 'interior',
    label: { de: 'Fußmatten', en: 'Floor mats', ru: 'Коврики салона', uk: 'Килимки салону' },
  },
  {
    id: 'trunk_mat',
    zone: 'interior',
    label: {
      de: 'Kofferraummatte',
      en: 'Trunk mat',
      ru: 'Коврик багажника',
      uk: 'Килимок багажника',
    },
  },
  {
    id: 'airbag_indicator',
    zone: 'interior',
    label: {
      de: 'Airbag-Kontrollleuchte',
      en: 'Airbag indicator',
      ru: 'Индикатор подушки безопасности',
      uk: 'Індикатор подушки безпеки',
    },
  },

  // wheels
  {
    id: 'rim',
    zone: 'wheels',
    label: { de: 'Felge', en: 'Rim', ru: 'Диск', uk: 'Диск' },
  },
  {
    id: 'tire',
    zone: 'wheels',
    label: { de: 'Reifen', en: 'Tire', ru: 'Шина', uk: 'Шина' },
  },
  {
    id: 'brake_disc',
    zone: 'wheels',
    label: { de: 'Bremsscheibe', en: 'Brake disc', ru: 'Тормозной диск', uk: 'Гальмівний диск' },
  },
  {
    id: 'brake_caliper',
    zone: 'wheels',
    label: {
      de: 'Bremssattel',
      en: 'Brake caliper',
      ru: 'Тормозной суппорт',
      uk: 'Гальмівний супорт',
    },
  },
  {
    id: 'hub_dust_cap',
    zone: 'wheels',
    label: { de: 'Nabendeckel', en: 'Hub dust cap', ru: 'Колпак ступицы', uk: 'Ковпак маточини' },
  },

  // undercarriage
  {
    id: 'underbody_panel',
    zone: 'undercarriage',
    label: {
      de: 'Unterbodenverkleidung',
      en: 'Underbody panel',
      ru: 'Защита днища',
      uk: 'Захист днища',
    },
  },
  {
    id: 'oil_pan_guard',
    zone: 'undercarriage',
    label: {
      de: 'Ölwannenschutz',
      en: 'Oil pan guard',
      ru: 'Защита картера',
      uk: 'Захист картера',
    },
  },
  {
    id: 'exhaust',
    zone: 'undercarriage',
    label: { de: 'Auspuffanlage', en: 'Exhaust', ru: 'Выхлопная система', uk: 'Вихлопна система' },
  },
  {
    id: 'catalytic_converter',
    zone: 'undercarriage',
    label: { de: 'Katalysator', en: 'Catalytic converter', ru: 'Катализатор', uk: 'Каталізатор' },
  },
  {
    id: 'cv_joint_dust_cover',
    zone: 'undercarriage',
    label: {
      de: 'Achsmanschette',
      en: 'CV joint dust cover',
      ru: 'Пыльник ШРУС',
      uk: 'Пильник ШРКШ',
    },
  },
  {
    id: 'suspension_arm',
    zone: 'undercarriage',
    label: { de: 'Querlenker', en: 'Suspension arm', ru: 'Рычаг подвески', uk: 'Важіль підвіски' },
  },
  {
    id: 'shock_absorber',
    zone: 'undercarriage',
    label: { de: 'Stoßdämpfer', en: 'Shock absorber', ru: 'Амортизатор', uk: 'Амортизатор' },
  },
];

// ---------------------------------------------------------------------------
// Damage types (§4.2)
// ---------------------------------------------------------------------------

const DAMAGE_TYPES: DamageTypeDef[] = [
  {
    id: 'scratch',
    label: { de: 'Kratzer', en: 'Scratch', ru: 'Царапина', uk: 'Подряпина' },
  },
  {
    id: 'dent',
    label: { de: 'Delle', en: 'Dent', ru: 'Вмятина', uk: 'Вм’ятина' },
  },
  {
    id: 'chip',
    label: { de: 'Steinschlag', en: 'Chip', ru: 'Скол', uk: 'Скол' },
  },
  {
    id: 'crack',
    label: { de: 'Riss', en: 'Crack', ru: 'Трещина', uk: 'Тріщина' },
  },
  {
    id: 'corrosion',
    label: { de: 'Rost', en: 'Corrosion', ru: 'Коррозия / ржавчина', uk: 'Корозія / іржа' },
  },
  {
    id: 'broken',
    label: { de: 'Beschädigt / kaputt', en: 'Broken', ru: 'Разбито', uk: 'Розбито' },
  },
  {
    id: 'missing',
    label: { de: 'Fehlt', en: 'Missing', ru: 'Отсутствует', uk: 'Відсутнє' },
  },
  {
    id: 'paint-peeling',
    label: {
      de: 'Lack abgeplatzt',
      en: 'Paint peeling',
      ru: 'Облупилась краска',
      uk: 'Відшарування лаку',
    },
  },
  {
    id: 'deformation',
    label: { de: 'Verformung', en: 'Deformation', ru: 'Деформация', uk: 'Деформація' },
  },
  {
    id: 'dirt',
    label: {
      de: 'Verschmutzung',
      en: 'Dirt / soiling',
      ru: 'Загрязнение / следы',
      uk: 'Забруднення / сліди',
    },
  },
];

// ---------------------------------------------------------------------------
// K / S / T codes (§2.1–2.3, mapping logic §4.5)
// ---------------------------------------------------------------------------

const KST_CODES: KstCodeDef[] = [
  // --- K group: body & paint (36) ---
  {
    code: 'K01',
    group: 'K',
    partId: 'trunk_lid',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Heckklappe verkratzt',
      en: 'Trunk lid scratched',
      ru: 'Крышка багажника / 5-я дверь — царапины ЛКП',
      uk: 'Кришка багажника / 5-ті двері — подряпини ЛФП',
    },
  },
  {
    code: 'K02',
    group: 'K',
    partId: 'fender_front_left',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Kotflügel vorne links verkratzt',
      en: 'Front left fender scratched',
      ru: 'Переднее левое крыло — царапины',
      uk: 'Переднє ліве крило — подряпини',
    },
  },
  {
    code: 'K03',
    group: 'K',
    partId: 'fender_front_right',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Kotflügel vorne rechts verkratzt',
      en: 'Front right fender scratched',
      ru: 'Переднее правое крыло — царапины',
      uk: 'Переднє праве крило — подряпини',
    },
  },
  {
    code: 'K04',
    group: 'K',
    partId: 'hood',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Motorhaube verkratzt',
      en: 'Hood scratched',
      ru: 'Капот — царапины',
      uk: 'Капот — подряпини',
    },
  },
  {
    code: 'K05',
    group: 'K',
    partId: 'side_panel_rear_left',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Seitenwand hinten links verkratzt',
      en: 'Rear left side panel scratched',
      ru: 'Задняя боковина слева — царапины',
      uk: 'Задня боковина зліва — подряпини',
    },
  },
  {
    code: 'K06',
    group: 'K',
    partId: 'side_panel_rear_right',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Seitenwand hinten rechts verkratzt',
      en: 'Rear right side panel scratched',
      ru: 'Задняя боковина справа — царапины',
      uk: 'Задня боковина справа — подряпини',
    },
  },
  {
    code: 'K07',
    group: 'K',
    partId: 'bumper_rear',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Stoßfänger hinten verkratzt',
      en: 'Rear bumper scratched',
      ru: 'Задний бампер — царапины',
      uk: 'Задній бампер — подряпини',
    },
  },
  {
    code: 'K08',
    group: 'K',
    partId: 'bumper_front',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Stoßfänger vorne verkratzt',
      en: 'Front bumper scratched',
      ru: 'Передний бампер — царапины',
      uk: 'Передній бампер — подряпини',
    },
  },
  {
    code: 'K09',
    group: 'K',
    partId: 'door_rear_left',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Tür hinten links verkratzt',
      en: 'Rear left door scratched',
      ru: 'Задняя левая дверь — царапины',
      uk: 'Задні ліві двері — подряпини',
    },
  },
  {
    code: 'K10',
    group: 'K',
    partId: 'door_rear_right',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Tür hinten rechts verkratzt',
      en: 'Rear right door scratched',
      ru: 'Задняя правая дверь — царапины',
      uk: 'Задні праві двері — подряпини',
    },
  },
  {
    code: 'K11',
    group: 'K',
    partId: 'door_front_left',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Tür vorne links verkratzt',
      en: 'Front left door scratched',
      ru: 'Передняя левая дверь — царапины',
      uk: 'Передні ліві двері — подряпини',
    },
  },
  {
    code: 'K12',
    group: 'K',
    partId: 'door_front_right',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Tür vorne rechts verkratzt',
      en: 'Front right door scratched',
      ru: 'Передняя правая дверь — царапины',
      uk: 'Передні праві двері — подряпини',
    },
  },
  {
    code: 'K13',
    group: 'K',
    partId: 'sill_left',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Schwellerverkleidung links verkratzt',
      en: 'Left sill trim scratched',
      ru: 'Накладка порога слева — повреждение / царапина',
      uk: 'Накладка порога зліва — пошкодження / подряпина',
    },
  },
  {
    code: 'K14',
    group: 'K',
    partId: 'sill_right',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Schwellerverkleidung rechts verkratzt',
      en: 'Right sill trim scratched',
      ru: 'Накладка порога справа — повреждение / царапина',
      uk: 'Накладка порога справа — пошкодження / подряпина',
    },
  },
  {
    code: 'K15',
    group: 'K',
    partId: 'heckspoiler',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Heckspoiler verkratzt',
      en: 'Rear spoiler scratched',
      ru: 'Задний спойлер — царапины',
      uk: 'Задній спойлер — подряпини',
    },
  },
  {
    code: 'K16',
    group: 'K',
    partId: 'roof',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Dach verkratzt / beklebt',
      en: 'Roof scratched / wrapped',
      ru: 'Крыша — царапины / потёртости',
      uk: 'Дах — подряпини / потертості',
    },
  },
  {
    code: 'K17',
    group: 'K',
    partId: 'wheel_arch_front_left',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Radlauf verkratzt',
      en: 'Wheel arch scratched',
      ru: 'Колёсная арка — царапины / задиры',
      uk: 'Колісна арка — подряпини / задири',
    },
  },
  {
    code: 'K18',
    group: 'K',
    partId: 'windshield',
    typeId: 'chip',
    defaultTier: 'T2',
    label: {
      de: 'Frontscheibe beschädigt',
      en: 'Windshield damaged (chip / crack)',
      ru: 'Лобовое стекло — скол / трещина',
      uk: 'Лобове скло — скол / тріщина',
    },
  },
  {
    code: 'K19',
    group: 'K',
    partId: 'mirror_left',
    typeId: 'scratch',
    defaultTier: 'T1',
    label: {
      de: 'Spiegelkappe verkratzt',
      en: 'Mirror cap scratched',
      ru: 'Корпус зеркала — царапины / повреждения',
      uk: 'Корпус дзеркала — подряпини / пошкодження',
    },
  },
  {
    code: 'K20',
    group: 'K',
    partId: null,
    typeId: 'dent',
    defaultTier: 'T3',
    label: {
      de: 'Fahrzeug mit Hagelschaden',
      en: 'Vehicle with hail damage',
      ru: 'Автомобиль — градобой (Hagelschaden)',
      uk: 'Автомобіль — градобій (Hagelschaden)',
    },
  },
  {
    code: 'K21',
    group: 'K',
    partId: 'trunk_lid',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Heckklappe Delle/Dellen',
      en: 'Trunk lid dent(s)',
      ru: 'Крышка багажника — вмятина',
      uk: 'Кришка багажника — вм’ятина',
    },
  },
  {
    code: 'K22',
    group: 'K',
    partId: 'fender_front_left',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Kotflügel vorne links Delle',
      en: 'Front left fender dent',
      ru: 'Переднее левое крыло — вмятина',
      uk: 'Переднє ліве крило — вм’ятина',
    },
  },
  {
    code: 'K23',
    group: 'K',
    partId: 'fender_front_right',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Kotflügel vorne rechts Delle',
      en: 'Front right fender dent',
      ru: 'Переднее правое крыло — вмятина',
      uk: 'Переднє праве крило — вм’ятина',
    },
  },
  {
    code: 'K24',
    group: 'K',
    partId: 'hood',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Motorhaube Delle',
      en: 'Hood dent',
      ru: 'Капот — вмятина',
      uk: 'Капот — вм’ятина',
    },
  },
  {
    code: 'K25',
    group: 'K',
    partId: 'side_panel_rear_left',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Seitenwand hinten links Delle',
      en: 'Rear left side panel dent',
      ru: 'Задняя боковина слева — вмятина',
      uk: 'Задня боковина зліва — вм’ятина',
    },
  },
  {
    code: 'K26',
    group: 'K',
    partId: 'side_panel_rear_right',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Seitenwand hinten rechts Delle',
      en: 'Rear right side panel dent',
      ru: 'Задняя боковина справа — вмятина',
      uk: 'Задня боковина справа — вм’ятина',
    },
  },
  {
    code: 'K27',
    group: 'K',
    partId: 'bumper_rear',
    typeId: 'deformation',
    defaultTier: 'T2',
    label: {
      de: 'Stoßfänger hinten Delle',
      en: 'Rear bumper dent / deformation',
      ru: 'Задний бампер — вмятина / деформация',
      uk: 'Задній бампер — вм’ятина / деформація',
    },
  },
  {
    code: 'K28',
    group: 'K',
    partId: 'bumper_front',
    typeId: 'deformation',
    defaultTier: 'T2',
    label: {
      de: 'Stoßfänger vorne Delle',
      en: 'Front bumper dent / deformation',
      ru: 'Передний бампер — вмятина / деформация',
      uk: 'Передній бампер — вм’ятина / деформація',
    },
  },
  {
    code: 'K29',
    group: 'K',
    partId: 'door_rear_left',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Tür hinten links Delle',
      en: 'Rear left door dent',
      ru: 'Задняя левая дверь — вмятина',
      uk: 'Задні ліві двері — вм’ятина',
    },
  },
  {
    code: 'K30',
    group: 'K',
    partId: 'door_rear_right',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Tür hinten rechts Delle',
      en: 'Rear right door dent',
      ru: 'Задняя правая дверь — вмятина',
      uk: 'Задні праві двері — вм’ятина',
    },
  },
  {
    code: 'K31',
    group: 'K',
    partId: 'door_front_left',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Tür vorne links Delle',
      en: 'Front left door dent',
      ru: 'Передняя левая дверь — вмятина',
      uk: 'Передні ліві двері — вм’ятина',
    },
  },
  {
    code: 'K32',
    group: 'K',
    partId: 'door_front_right',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Tür vorne rechts Delle',
      en: 'Front right door dent',
      ru: 'Передняя правая дверь — вмятина',
      uk: 'Передні праві двері — вм’ятина',
    },
  },
  {
    code: 'K33',
    group: 'K',
    partId: 'sill_left',
    typeId: 'deformation',
    defaultTier: 'T2',
    label: {
      de: 'Schwellerverkleidung links Delle',
      en: 'Left sill trim deformation',
      ru: 'Накладка порога слева — деформация',
      uk: 'Накладка порога зліва — деформація',
    },
  },
  {
    code: 'K34',
    group: 'K',
    partId: 'sill_right',
    typeId: 'deformation',
    defaultTier: 'T2',
    label: {
      de: 'Schwellerverkleidung rechts Delle',
      en: 'Right sill trim deformation',
      ru: 'Накладка порога справа — деформация',
      uk: 'Накладка порога справа — деформація',
    },
  },
  {
    code: 'K35',
    group: 'K',
    partId: 'heckspoiler',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Heckspoiler Delle',
      en: 'Rear spoiler dent',
      ru: 'Задний спойлер — вмятина',
      uk: 'Задній спойлер — вм’ятина',
    },
  },
  {
    code: 'K36',
    group: 'K',
    partId: 'roof',
    typeId: 'dent',
    defaultTier: 'T2',
    label: {
      de: 'Dach Delle/Dellen',
      en: 'Roof dent(s)',
      ru: 'Крыша — вмятина',
      uk: 'Дах — вм’ятина',
    },
  },

  // --- S group: service (5) ---
  {
    code: 'S01',
    group: 'S',
    partId: null,
    typeId: null,
    defaultTier: 'T1',
    label: {
      de: 'Fahrzeug-Check',
      en: 'Scheduled vehicle check',
      ru: 'Общий техосмотр по регламенту',
      uk: 'Загальний техогляд за регламентом',
    },
  },
  {
    code: 'S02',
    group: 'S',
    partId: null,
    typeId: null,
    defaultTier: 'T1',
    label: {
      de: 'Ölservice fällig',
      en: 'Oil service due',
      ru: 'Просрочена замена моторного масла',
      uk: 'Прострочена заміна моторного масла',
    },
  },
  {
    code: 'S03',
    group: 'S',
    partId: null,
    typeId: null,
    defaultTier: 'T1',
    label: {
      de: 'Service Bremsflüssigkeit',
      en: 'Brake fluid service due',
      ru: 'Просрочен сервис тормозной жидкости',
      uk: 'Прострочений сервіс гальмівної рідини',
    },
  },
  {
    code: 'S04',
    group: 'S',
    partId: null,
    typeId: null,
    defaultTier: 'T1',
    label: {
      de: 'Service überzogen',
      en: 'Service overdue (interval exceeded)',
      ru: 'ТО просрочено (превышен интервал)',
      uk: 'ТО прострочено (перевищено інтервал)',
    },
  },
  {
    code: 'S05',
    group: 'S',
    partId: null,
    typeId: null,
    defaultTier: 'T1',
    label: {
      de: 'Service (Elektrofahrzeug)',
      en: 'EV / HV battery service',
      ru: 'Сервис электромобиля / ВВ-батареи',
      uk: 'Сервіс електромобіля / ВВ-батареї',
    },
  },

  // --- T group: technical condition & equipment (27) ---
  {
    code: 'T01',
    group: 'T',
    partId: null,
    typeId: 'broken',
    defaultTier: 'T1',
    label: {
      de: 'Batterie-/Schlüsselfernbedienung',
      en: 'Key fob / remote not working or missing',
      ru: 'Не работает / отсутствует брелок, пульт-ключ от АКБ',
      uk: 'Не працює / відсутній брелок, пульт-ключ від АКБ',
    },
  },
  {
    code: 'T02',
    group: 'T',
    partId: 'brake_disc',
    typeId: null,
    defaultTier: 'T2',
    label: {
      de: 'Bremsbeläge hinten verschlissen',
      en: 'Rear brake pads worn',
      ru: 'Тормозные колодки сзади — износ',
      uk: 'Гальмівні колодки ззаду — знос',
    },
  },
  {
    code: 'T03',
    group: 'T',
    partId: 'brake_disc',
    typeId: null,
    defaultTier: 'T2',
    label: {
      de: 'Bremsbeläge vorne verschlissen',
      en: 'Front brake pads worn',
      ru: 'Тормозные колодки спереди — износ',
      uk: 'Гальмівні колодки спереду — знос',
    },
  },
  {
    code: 'T04',
    group: 'T',
    partId: 'brake_caliper',
    typeId: null,
    defaultTier: 'T2',
    label: {
      de: 'Bremse hinten verschlissen',
      en: 'Rear brake worn / faulty',
      ru: 'Задний тормозной механизм — износ / неисправность',
      uk: 'Задній гальмівний механізм — знос / несправність',
    },
  },
  {
    code: 'T05',
    group: 'T',
    partId: 'brake_caliper',
    typeId: null,
    defaultTier: 'T2',
    label: {
      de: 'Bremse vorne verschlissen',
      en: 'Front brake worn / faulty',
      ru: 'Передний тормозной механизм — износ / неисправность',
      uk: 'Передній гальмівний механізм — знос / несправність',
    },
  },
  {
    code: 'T06',
    group: 'T',
    partId: 'brake_disc',
    typeId: 'deformation',
    defaultTier: 'T2',
    label: {
      de: 'Bremsscheiben vorne',
      en: 'Front brake discs worn / warped',
      ru: 'Тормозные диски передние — износ / деформация',
      uk: 'Гальмівні диски передні — знос / деформація',
    },
  },
  {
    code: 'T07',
    group: 'T',
    partId: 'brake_disc',
    typeId: 'deformation',
    defaultTier: 'T2',
    label: {
      de: 'Bremsscheiben hinten',
      en: 'Rear brake discs worn / warped',
      ru: 'Тормозные диски задние — износ / деформация',
      uk: 'Гальмівні диски задні — знос / деформація',
    },
  },
  {
    code: 'T08',
    group: 'T',
    partId: 'hood',
    typeId: 'broken',
    defaultTier: 'T1',
    label: {
      de: 'Dämmmatte Motorhaube',
      en: 'Hood insulation mat damaged / missing',
      ru: 'Шумопоглотитель капота — повреждён / отсутствует',
      uk: 'Шумоізоляція капота — пошкоджена / відсутня',
    },
  },
  {
    code: 'T09',
    group: 'T',
    partId: 'rim',
    typeId: 'broken',
    defaultTier: 'T1',
    label: {
      de: 'Felge hinten links',
      en: 'Rear left rim damaged / repainted',
      ru: 'Диск задний левый — повреждён / перекрашен',
      uk: 'Диск задній лівий — пошкоджений / перефарбований',
    },
  },
  {
    code: 'T10',
    group: 'T',
    partId: 'rim',
    typeId: 'broken',
    defaultTier: 'T1',
    label: {
      de: 'Felge hinten rechts',
      en: 'Rear right rim damaged',
      ru: 'Диск задний правый — повреждён',
      uk: 'Диск задній правий — пошкоджений',
    },
  },
  {
    code: 'T11',
    group: 'T',
    partId: 'rim',
    typeId: 'broken',
    defaultTier: 'T1',
    label: {
      de: 'Felge vorne links',
      en: 'Front left rim damaged',
      ru: 'Диск передний левый — повреждён',
      uk: 'Диск передній лівий — пошкоджений',
    },
  },
  {
    code: 'T12',
    group: 'T',
    partId: 'rim',
    typeId: 'broken',
    defaultTier: 'T1',
    label: {
      de: 'Felge vorne rechts',
      en: 'Front right rim damaged',
      ru: 'Диск передний правый — повреждён',
      uk: 'Диск передній правий — пошкоджений',
    },
  },
  {
    code: 'T13',
    group: 'T',
    partId: 'floor_mats',
    typeId: 'missing',
    defaultTier: 'T1',
    label: {
      de: 'Fußmatte vorne',
      en: 'Front floor mat missing / damaged',
      ru: 'Передний коврик — отсутствует / повреждён',
      uk: 'Передній килимок — відсутній / пошкоджений',
    },
  },
  {
    code: 'T14',
    group: 'T',
    partId: 'floor_mats',
    typeId: 'missing',
    defaultTier: 'T1',
    label: {
      de: 'Fußmatten fehlen',
      en: 'Floor mats missing',
      ru: 'Коврики салона отсутствуют',
      uk: 'Килимки салону відсутні',
    },
  },
  {
    code: 'T15',
    group: 'T',
    partId: 'cv_joint_dust_cover',
    typeId: 'broken',
    defaultTier: 'T2',
    label: {
      de: 'Gelenkscheibe / Gummiring',
      en: 'CV joint / flex disc damaged',
      ru: 'ШРУС / защита шарнира — повреждение',
      uk: 'ШРКШ / пильник шарніра — пошкодження',
    },
  },
  {
    code: 'T16',
    group: 'T',
    partId: 'fog_light_left',
    typeId: 'broken',
    defaultTier: 'T1',
    label: {
      de: 'Nebelscheinwerfer links',
      en: 'Left fog light damaged',
      ru: 'Противотуманная фара левая — повреждена',
      uk: 'Протитуманна фара ліва — пошкоджена',
    },
  },
  {
    code: 'T17',
    group: 'T',
    partId: 'fog_light_right',
    typeId: 'broken',
    defaultTier: 'T1',
    label: {
      de: 'Nebelscheinwerfer rechts',
      en: 'Right fog light damaged',
      ru: 'Противотуманная фара правая — повреждена',
      uk: 'Протитуманна фара права — пошкоджена',
    },
  },
  {
    code: 'T18',
    group: 'T',
    partId: 'tire',
    typeId: null,
    defaultTier: 'T2',
    label: {
      de: 'Reifen alle verschlissen',
      en: 'All tires worn',
      ru: 'Все шины изношены',
      uk: 'Всі шини зношені',
    },
  },
  {
    code: 'T19',
    group: 'T',
    partId: 'tire',
    typeId: null,
    defaultTier: 'T2',
    label: {
      de: 'Reifen hinten verschlissen',
      en: 'Rear tires worn',
      ru: 'Задние шины изношены',
      uk: 'Задні шини зношені',
    },
  },
  {
    code: 'T20',
    group: 'T',
    partId: 'tire',
    typeId: null,
    defaultTier: 'T2',
    label: {
      de: 'Reifen vorne verschlissen',
      en: 'Front tires worn',
      ru: 'Передние шины изношены',
      uk: 'Передні шини зношені',
    },
  },
  {
    code: 'T21',
    group: 'T',
    partId: null,
    typeId: 'missing',
    defaultTier: 'T1',
    label: {
      de: 'Schlüssel / Fernbedienung fehlt',
      en: 'Key / remote missing',
      ru: 'Отсутствует ключ / брелок-пульт',
      uk: 'Відсутній ключ / брелок-пульт',
    },
  },
  {
    code: 'T22',
    group: 'T',
    partId: 'tire',
    typeId: 'missing',
    defaultTier: 'T2',
    label: {
      de: 'Sommerräder fehlen',
      en: 'Summer wheels missing',
      ru: 'Летние колёса отсутствуют',
      uk: 'Літні колеса відсутні',
    },
  },
  {
    code: 'T23',
    group: 'T',
    partId: 'underbody_panel',
    typeId: 'broken',
    defaultTier: 'T2',
    label: {
      de: 'Unterbodenverkleidung',
      en: 'Underbody panel / wheel liners damaged',
      ru: 'Защита днища / подкрылки — повреждены',
      uk: 'Захист днища / підкрилки — пошкоджені',
    },
  },
  {
    code: 'T24',
    group: 'T',
    partId: 'tire',
    typeId: null,
    defaultTier: 'T2',
    label: {
      de: 'Reifen alle Profiltiefe',
      en: 'All tires below tread limit',
      ru: 'Все шины ниже допустимого протектора',
      uk: 'Всі шини нижче допустимого протектора',
    },
  },
  {
    code: 'T25',
    group: 'T',
    partId: 'tire',
    typeId: null,
    defaultTier: 'T2',
    label: {
      de: 'Reifen hinten Profiltiefe',
      en: 'Rear tires low tread',
      ru: 'Задние шины — низкий протектор',
      uk: 'Задні шини — низький протектор',
    },
  },
  {
    code: 'T26',
    group: 'T',
    partId: 'tire',
    typeId: null,
    defaultTier: 'T2',
    label: {
      de: 'Reifen vorne Profiltiefe',
      en: 'Front tires low tread',
      ru: 'Передние шины — низкий протектор',
      uk: 'Передні шини — низький протектор',
    },
  },
  {
    code: 'T27',
    group: 'T',
    partId: 'tire',
    typeId: null,
    defaultTier: 'T1',
    label: {
      de: 'Reifen ohne Erstausrüstung',
      en: 'Tires not OEM-marked',
      ru: 'Шины без заводской маркировки (не OEM)',
      uk: 'Шини без заводського маркування (не OEM)',
    },
  },
];

// ---------------------------------------------------------------------------
// Expert checklist (§3.1–3.8) — 98 items
// ---------------------------------------------------------------------------

const CHECKLIST: ChecklistItemDef[] = [
  // §3.1 Body & paint (1–15)
  {
    number: 1,
    category: 'body',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Durchrostung von Karosserieblechen (Rost)',
      en: 'Through-corrosion of body panels (rust)',
      ru: 'Сквозная коррозия кузовных панелей (ржавчина)',
      uk: 'Наскрізна корозія кузовних панелей (іржа)',
    },
  },
  {
    number: 2,
    category: 'body',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Oberflächenrost an Türkanten, Schwellern, Radläufen',
      en: 'Surface rust on door edges, sills, wheel arches',
      ru: 'Поверхностная коррозия на кромках дверей, порогов, колёсных арок',
      uk: 'Поверхнева корозія на кромках дверей, порогах, колісних арках',
    },
  },
  {
    number: 3,
    category: 'body',
    frequent: false,
    defaultTier: 'T2',
    partId: 'trunk_lid',
    label: {
      de: 'Rost an der Heckklappe im Bereich Emblem / Kennzeichen',
      en: 'Rust on tailgate near emblem / license plate',
      ru: 'Коррозия крышки багажника в районе эмблемы / номерного знака',
      uk: 'Корозія кришки багажника в зоні емблеми / номерного знака',
    },
  },
  {
    number: 4,
    category: 'body',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Verformung von Längsträger / tragender Struktur',
      en: 'Deformation of frame rail / structural member',
      ru: 'Деформация лонжерона / силовой структуры',
      uk: 'Деформація лонжерона / силової структури',
    },
  },
  {
    number: 5,
    category: 'body',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Blasenbildung im Lack (Lackblasen)',
      en: 'Paint blistering / bubbling',
      ru: 'Вздутие / пузыри на ЛКП (пузырение краски)',
      uk: 'Здуття / бульбашки на ЛФП (спучування фарби)',
    },
  },
  {
    number: 6,
    category: 'body',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Abplatzender Klarlack (Abblättern, Delamination)',
      en: 'Clear-coat peeling (flaking, delamination)',
      ru: 'Отслоение лака (шелушение, ламинация)',
      uk: 'Відшарування лаку (лущення, деламінація)',
    },
  },
  {
    number: 7,
    category: 'body',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Trübung und Ausbleichen des Lacks an Dach / Motorhaube',
      en: 'Clouding and fading of paint on roof / hood',
      ru: 'Помутнение и выгорание лака на крыше / капоте',
      uk: 'Помутніння та вигорання лаку на даху / капоті',
    },
  },
  {
    number: 8,
    category: 'body',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Durchpolierter / übermäßig polierter Lack',
      en: 'Burned-through / over-polished paint',
      ru: 'Следы полировки «под воронку» / перетёртый лак',
      uk: 'Протертий / надмірно полірований лак',
    },
  },
  {
    number: 9,
    category: 'body',
    frequent: true,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Farbtonabweichung benachbarter Teile (Nachlackierung)',
      en: 'Color mismatch of adjacent panels (respray)',
      ru: 'Несоответствие оттенков соседних элементов (перекрас)',
      uk: 'Розбіжність відтінків сусідніх елементів (перефарбування)',
    },
  },
  {
    number: 10,
    category: 'body',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Verzogener Türrahmen / Türöffnung',
      en: 'Misaligned door frame / opening',
      ru: 'Перекошенный дверной проём / рамка двери',
      uk: 'Перекошений дверний проєм / рамка дверей',
    },
  },
  {
    number: 11,
    category: 'body',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Undichter oder verzogener Tankdeckel',
      en: 'Leaking or misaligned fuel filler flap',
      ru: 'Негерметичная или перекошенная крышка лючка бензобака',
      uk: 'Негерметична або перекошена кришка лючка бензобака',
    },
  },
  {
    number: 12,
    category: 'body',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Karosserieschaden im Bereich der Abschleppöse',
      en: 'Body damage near the tow hook',
      ru: 'Повреждение кузова в районе буксировочной петли',
      uk: 'Пошкодження кузова в зоні буксирувальної петлі',
    },
  },
  {
    number: 13,
    category: 'body',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Schwellerschaden an der Wagenheberaufnahme',
      en: 'Sill damage at the jack point',
      ru: 'Повреждение порога в месте установки домкрата',
      uk: 'Пошкодження порога в місці встановлення домкрата',
    },
  },
  {
    number: 14,
    category: 'body',
    frequent: false,
    defaultTier: 'T3',
    partId: 'roof',
    label: {
      de: 'Dachverzug / Falten an den Panelübergängen',
      en: 'Roof distortion / creases at panel joints',
      ru: 'Перекос крыши / заломы на стыках панелей',
      uk: 'Перекіс даху / заломи на стиках панелей',
    },
  },
  {
    number: 15,
    category: 'body',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Ungleichmäßige Spaltmaße (Karosserie nach Reparatur)',
      en: 'Uneven panel gaps (body after repair)',
      ru: 'Невыставленные зазоры (кузов после ремонта)',
      uk: 'Нерівномірні зазори (кузов після ремонту)',
    },
  },

  // §3.2 Glass, mirrors, lighting (16–28)
  {
    number: 16,
    category: 'glass',
    frequent: false,
    defaultTier: 'T2',
    partId: 'rear_window',
    label: {
      de: 'Steinschlag / Riss in der Heckscheibe',
      en: 'Chip / crack in the rear window',
      ru: 'Скол / трещина на заднем стекле',
      uk: 'Скол / тріщина на задньому склі',
    },
  },
  {
    number: 17,
    category: 'glass',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Steinschlag / Riss in der Seitenscheibe (versenkbar oder fest)',
      en: 'Chip / crack in a side window (drop or fixed)',
      ru: 'Скол / трещина на боковом стекле (опускном или глухом)',
      uk: 'Скол / тріщина на боковому склі (опускному або глухому)',
    },
  },
  {
    number: 18,
    category: 'glass',
    frequent: false,
    defaultTier: 'T2',
    partId: 'panoramic_roof',
    label: {
      de: 'Beschädigung der Glasfläche des Panoramadachs',
      en: 'Damage to the panoramic roof glass panel',
      ru: 'Повреждение стеклянной панели панорамной крыши',
      uk: 'Пошкодження скляної панелі панорамного даху',
    },
  },
  {
    number: 19,
    category: 'glass',
    frequent: false,
    defaultTier: 'T2',
    partId: 'windshield',
    label: {
      de: 'Wischerkratzer auf der Frontscheibe',
      en: 'Wiper scratches on the windshield',
      ru: 'Царапины от стеклоочистителей на ветровом стекле',
      uk: 'Подряпини від склоочисників на лобовому склі',
    },
  },
  {
    number: 20,
    category: 'glass',
    frequent: true,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Trübung / Mattierung der Scheinwerfer (Polycarbonat)',
      en: 'Clouded / hazy headlights (polycarbonate)',
      ru: 'Помутнение / «матовость» фар (поликарбонат)',
      uk: 'Помутніння / «матовість» фар (полікарбонат)',
    },
  },
  {
    number: 21,
    category: 'glass',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Riss im Glas von Scheinwerfer, Blinker, Bremslicht',
      en: 'Cracked lens of headlight, indicator, brake light',
      ru: 'Трещина стекла фары, поворотника, стопа',
      uk: 'Тріщина скла фари, поворотника, стоп-сигналу',
    },
  },
  {
    number: 22,
    category: 'glass',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Beschlagen von Scheinwerfer oder Rückleuchte von innen',
      en: 'Condensation inside headlight or tail light',
      ru: 'Запотевание фары или заднего фонаря изнутри',
      uk: 'Запотівання фари або заднього ліхтаря зсередини',
    },
  },
  {
    number: 23,
    category: 'glass',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Riss / Absplitterung im Spiegelglas',
      en: 'Crack / chip in the mirror glass',
      ru: 'Трещина / скол на стекле зеркала',
      uk: 'Тріщина / скол на склі дзеркала',
    },
  },
  {
    number: 24,
    category: 'glass',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Spiegelverstellung / -heizung ohne Funktion',
      en: 'Mirror adjustment / heating not working',
      ru: 'Не работает электропривод / обогрев зеркала',
      uk: 'Не працює електропривід / обігрів дзеркала',
    },
  },
  {
    number: 25,
    category: 'glass',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Seitenblinker am Kotflügel oder Spiegel fehlt / defekt',
      en: 'Side turn-signal repeater on fender or mirror missing / broken',
      ru: 'Отсутствует / сломан повторитель поворота на крыле или зеркале',
      uk: 'Відсутній / зламаний повторювач повороту на крилі або дзеркалі',
    },
  },
  {
    number: 26,
    category: 'glass',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Parksensor (PDC) fehlt / beschädigt',
      en: 'Parking sensor missing / damaged',
      ru: 'Отсутствует / повреждён датчик парктроника',
      uk: 'Відсутній / пошкоджений датчик парктроніка',
    },
  },
  {
    number: 27,
    category: 'glass',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Rückfahr- oder Rundumkamera fehlt / beschädigt',
      en: 'Rear-view or surround camera missing / damaged',
      ru: 'Отсутствует / повреждена камера заднего или кругового обзора',
      uk: 'Відсутня / пошкоджена камера заднього або кругового огляду',
    },
  },
  {
    number: 28,
    category: 'glass',
    frequent: false,
    defaultTier: 'T1',
    partId: 'antenna',
    label: {
      de: 'Antenne (Dachantenne) beschädigt / ohne Funktion',
      en: 'Antenna (shark fin) damaged / not working',
      ru: 'Повреждённая / нерабочая антенна («плавник»)',
      uk: 'Пошкоджена / неробоча антена («плавник»)',
    },
  },

  // §3.3 Interior (29–42)
  {
    number: 29,
    category: 'interior',
    frequent: true,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Schnitte, Brandlöcher, Flecken auf den Sitzbezügen',
      en: 'Cuts, burn holes, stains on seat upholstery',
      ru: 'Порезы, прожоги, пятна на обивке сидений',
      uk: 'Порізи, пропалини, плями на оббивці сидінь',
    },
  },
  {
    number: 30,
    category: 'interior',
    frequent: false,
    defaultTier: 'T1',
    partId: 'steering_wheel',
    label: {
      de: 'Abnutzung von Lenkradleder und Schaltknauf',
      en: 'Wear of steering-wheel leather and gear knob',
      ru: 'Износ кожи руля, рукоятки КПП',
      uk: 'Знос шкіри керма, ручки КПП',
    },
  },
  {
    number: 31,
    category: 'interior',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Abgenutzte / verblasste Symbole auf den Tasten',
      en: 'Worn / faded pictograms on buttons',
      ru: 'Потёртости / стёртые пиктограммы на кнопках',
      uk: 'Потертості / стерті піктограми на кнопках',
    },
  },
  {
    number: 32,
    category: 'interior',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Defekte Armlehne / defekter Becherhalter',
      en: 'Broken armrest / cup holder',
      ru: 'Сломанный подлокотник / подстаканник',
      uk: 'Зламаний підлокітник / підсклянник',
    },
  },
  {
    number: 33,
    category: 'interior',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Klemmender oder defekter Sitzverstellmechanismus',
      en: 'Sticking or broken seat adjustment mechanism',
      ru: 'Заедающий или сломанный механизм регулировки сиденья',
      uk: 'Заїдає або зламаний механізм регулювання сидіння',
    },
  },
  {
    number: 34,
    category: 'interior',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Sitzheizung / Sitzbelüftung ohne Funktion',
      en: 'Seat heating / ventilation not working',
      ru: 'Не работает подогрев / вентиляция сидений',
      uk: 'Не працює підігрів / вентиляція сидінь',
    },
  },
  {
    number: 35,
    category: 'interior',
    frequent: false,
    defaultTier: 'T2',
    partId: 'headliner',
    label: {
      de: 'Beschädigter Dachhimmel (Durchhängen, Flecken)',
      en: 'Damaged headliner (sagging, stains)',
      ru: 'Повреждённая обшивка потолка (провисание, пятна)',
      uk: 'Пошкоджена оббивка стелі (провисання, плями)',
    },
  },
  {
    number: 36,
    category: 'interior',
    frequent: false,
    defaultTier: 'T1',
    partId: 'sun_visor',
    label: {
      de: 'Defekte Sonnenblende / Spiegel in der Sonnenblende',
      en: 'Broken sun visor / vanity mirror',
      ru: 'Поломка солнцезащитного козырька / зеркала в козырьке',
      uk: 'Поломка сонцезахисного козирка / дзеркала в козирку',
    },
  },
  {
    number: 37,
    category: 'interior',
    frequent: false,
    defaultTier: 'T2',
    partId: 'dashboard',
    label: {
      de: 'Risse / Kratzer im Armaturenbrett-Kunststoff',
      en: 'Cracks / scratches in dashboard plastic',
      ru: 'Трещины / царапины на пластике торпедо',
      uk: 'Тріщини / подряпини на пластику торпедо',
    },
  },
  {
    number: 38,
    category: 'interior',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Gebrochenes oder gerissenes Display von Infotainment / Kombiinstrument',
      en: 'Broken or cracked infotainment / cluster display',
      ru: 'Разбитый или треснувший дисплей мультимедиа / приборки',
      uk: 'Розбитий або тріснутий дисплей мультимедіа / приладової панелі',
    },
  },
  {
    number: 39,
    category: 'interior',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Handschuhfachklappe gebrochen oder fehlend',
      en: 'Glovebox lid broken or missing',
      ru: 'Сломан или отсутствует лючок бардачка',
      uk: 'Зламана або відсутня кришка бардачка',
    },
  },
  {
    number: 40,
    category: 'interior',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Pedalauflagen fehlen',
      en: 'Pedal pads missing',
      ru: 'Отсутствуют накладки на педали',
      uk: 'Відсутні накладки на педалі',
    },
  },
  {
    number: 41,
    category: 'interior',
    frequent: true,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Flecken und Geruch im Innenraum (Tiere, Tabak, Schimmel)',
      en: 'Stains and odor in the cabin (pets, tobacco, mold)',
      ru: 'Пятна и запах в салоне (животные, табак, плесень)',
      uk: 'Плями та запах у салоні (тварини, тютюн, пліснява)',
    },
  },
  {
    number: 42,
    category: 'interior',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Zigarettenanzünder / USB-Anschluss defekt oder fehlend',
      en: 'Cigarette lighter / USB port faulty or missing',
      ru: 'Неисправный / отсутствующий прикуриватель, USB-порт',
      uk: 'Несправний / відсутній прикурювач, USB-порт',
    },
  },

  // §3.4 Engine, transmission, suspension (43–60)
  {
    number: 43,
    category: 'engine',
    frequent: true,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Batterie hält keine Ladung / Tiefentladung, Korrosion an Polen',
      en: 'Battery not holding charge / deeply discharged, terminal corrosion',
      ru: 'Не держит заряд / глубокий разряд АКБ, коррозия клемм',
      uk: 'Не тримає заряд / глибокий розряд АКБ, корозія клем',
    },
  },
  {
    number: 44,
    category: 'engine',
    frequent: false,
    defaultTier: 'T2',
    partId: 'oil_pan_guard',
    label: {
      de: 'Riss / Verformung des Unterfahrschutzes (Ölwanne)',
      en: 'Crack / deformation of the skid plate (oil pan guard)',
      ru: 'Трещина / деформация защиты картера',
      uk: 'Тріщина / деформація захисту картера',
    },
  },
  {
    number: 45,
    category: 'engine',
    frequent: false,
    defaultTier: 'T2',
    partId: 'exhaust',
    label: {
      de: 'Beschädigtes oder abgerissenes Abgasanlagenteil',
      en: 'Damaged or detached exhaust-system part',
      ru: 'Повреждённая или оторванная часть выхлопной системы',
      uk: 'Пошкоджена або відірвана частина вихлопної системи',
    },
  },
  {
    number: 46,
    category: 'engine',
    frequent: false,
    defaultTier: 'T3',
    partId: 'catalytic_converter',
    label: {
      de: 'Herausgeschnittener oder fehlender Katalysator (DPF/SCR)',
      en: 'Cut-out or missing catalytic converter (DPF/SCR)',
      ru: 'Вырезанный или отсутствующий катализатор (DPF/SCR)',
      uk: 'Вирізаний або відсутній каталізатор (DPF/SCR)',
    },
  },
  {
    number: 47,
    category: 'engine',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Kühlmittelleckage (Schläuche, Ausgleichsbehälter)',
      en: 'Coolant leak (hoses, expansion tank)',
      ru: 'Подтёки охлаждающей жидкости (патрубки, расширительный бачок)',
      uk: 'Підтікання охолоджувальної рідини (патрубки, розширювальний бачок)',
    },
  },
  {
    number: 48,
    category: 'engine',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Leckage der Servolenkung',
      en: 'Power-steering leak',
      ru: 'Течь гидроусилителя руля',
      uk: 'Теча гідропідсилювача керма',
    },
  },
  {
    number: 49,
    category: 'engine',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Leckage / Verschmutzung der Waschdüsen, Scheinwerferwaschanlage defekt',
      en: 'Washer-jet leak / clogging, headlight washer not working',
      ru: 'Течь / загрязнение форсунок омывателя, неработающий омыватель фар',
      uk: 'Теча / забруднення форсунок омивача, непрацюючий омивач фар',
    },
  },
  {
    number: 50,
    category: 'engine',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Defekter Generator oder Anlasser (Geräusch, keine Ladung)',
      en: 'Faulty alternator or starter (noise, no charging)',
      ru: 'Неисправный генератор или стартер (шум, нет зарядки)',
      uk: 'Несправний генератор або стартер (шум, немає зарядки)',
    },
  },
  {
    number: 51,
    category: 'engine',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Öleinfülldeckel fehlt / beschädigt',
      en: 'Oil filler cap missing / damaged',
      ru: 'Отсутствующая / повреждённая крышка заливной горловины масла',
      uk: 'Відсутня / пошкоджена кришка маслозаливної горловини',
    },
  },
  {
    number: 52,
    category: 'engine',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Tankdeckel beschädigt / fehlend',
      en: 'Fuel cap damaged / missing',
      ru: 'Повреждённая / отсутствующая крышка топливного бака',
      uk: 'Пошкоджена / відсутня кришка паливного бака',
    },
  },
  {
    number: 53,
    category: 'engine',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Verschmutzter Luft- oder Innenraumfilter',
      en: 'Dirty air or cabin filter',
      ru: 'Загрязнённый воздушный или салонный фильтр',
      uk: 'Забруднений повітряний або салонний фільтр',
    },
  },
  {
    number: 54,
    category: 'engine',
    frequent: true,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Wischerblätter verschlissen / beschädigt',
      en: 'Wiper blades worn / damaged',
      ru: 'Щётки стеклоочистителей изношены / повреждены',
      uk: 'Щітки склоочисників зношені / пошкоджені',
    },
  },
  {
    number: 55,
    category: 'engine',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Geräusch der Radlager',
      en: 'Wheel-bearing noise',
      ru: 'Шум ступичных подшипников',
      uk: 'Шум маточинних підшипників',
    },
  },
  {
    number: 56,
    category: 'engine',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Spiel in Spurstangen / Spurstangenköpfen',
      en: 'Play in tie rods / tie-rod ends',
      ru: 'Люфт рулевых тяг / наконечников',
      uk: 'Люфт рульових тяг / наконечників',
    },
  },
  {
    number: 57,
    category: 'engine',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Verschleiß von Silentblöcken / Stabilisatorstreben',
      en: 'Wear of bushings / stabilizer links',
      ru: 'Износ сайлент-блоков / стоек стабилизатора',
      uk: 'Знос сайлентблоків / стійок стабілізатора',
    },
  },
  {
    number: 58,
    category: 'engine',
    frequent: false,
    defaultTier: 'T3',
    partId: 'shock_absorber',
    label: {
      de: 'Leckage oder Defekt der Stoßdämpfer',
      en: 'Shock-absorber leak or fault',
      ru: 'Течь или неисправность амортизаторов',
      uk: 'Теча або несправність амортизаторів',
    },
  },
  {
    number: 59,
    category: 'engine',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Fremdgeräusche im Fahrwerk',
      en: 'Knocking noises in the suspension',
      ru: 'Посторонние стуки в подвеске',
      uk: 'Сторонні стуки в підвісці',
    },
  },
  {
    number: 60,
    category: 'engine',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Defekte / gerissene Motor- und Getriebelager',
      en: 'Broken / cracked engine and transmission mounts',
      ru: 'Разбитые / треснувшие опоры двигателя, подушки КПП',
      uk: 'Розбиті / тріснуті опори двигуна, подушки КПП',
    },
  },

  // §3.5 Chassis, tires, wheels, brakes (61–70)
  {
    number: 61,
    category: 'chassis',
    frequent: false,
    defaultTier: 'T2',
    partId: 'tire',
    label: {
      de: 'Unterschiedliche oder gegenläufige Reifen auf einer Achse',
      en: 'Mismatched or differently-directed tires on one axle',
      ru: 'Разноразмерные или разнонаправленные шины на одной оси',
      uk: 'Різнорозмірні або різноспрямовані шини на одній осі',
    },
  },
  {
    number: 62,
    category: 'chassis',
    frequent: false,
    defaultTier: 'T2',
    partId: 'tire',
    label: {
      de: 'Reifen mit abgelaufenem DOT (älter als 6 Jahre)',
      en: 'Tires with expired DOT (older than 6 years)',
      ru: 'Шины с просроченным DOT (старше 6 лет)',
      uk: 'Шини з простроченим DOT (старші за 6 років)',
    },
  },
  {
    number: 63,
    category: 'chassis',
    frequent: false,
    defaultTier: 'T3',
    partId: 'tire',
    label: {
      de: 'Beulen (seitliche Wölbungen), Schnitte an den Reifen',
      en: 'Bulges (sidewall blisters), cuts on the tires',
      ru: '«Грыжи» (боковые вздутия), порезы на шинах',
      uk: '«Грижі» (бокові здуття), порізи на шинах',
    },
  },
  {
    number: 64,
    category: 'chassis',
    frequent: false,
    defaultTier: 'T2',
    partId: 'tire',
    label: {
      de: 'Ungleichmäßiger Reifenverschleiß (Anzeichen für Spur / Sturz)',
      en: 'Uneven tire wear (sign of toe / camber issue)',
      ru: 'Неравномерный износ шин (признак схождения / развала)',
      uk: 'Нерівномірний знос шин (ознака порушення сходження / розвалу)',
    },
  },
  {
    number: 65,
    category: 'chassis',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Reserverad / Notrad / Reparaturset / Kompressor fehlt',
      en: 'Spare wheel / space-saver / repair kit / compressor missing',
      ru: 'Отсутствует запасное колесо / докатка / ремкомплект / компрессор',
      uk: 'Відсутнє запасне колесо / докатка / ремкомплект / компресор',
    },
  },
  {
    number: 66,
    category: 'chassis',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Felgenschloss / Sicherungsschraube fehlt oder beschädigt',
      en: 'Locking wheel bolt missing or damaged',
      ru: 'Отсутствует или повреждён секретный болт («секретка»)',
      uk: 'Відсутній або пошкоджений секретний болт («секретка»)',
    },
  },
  {
    number: 67,
    category: 'chassis',
    frequent: false,
    defaultTier: 'T3',
    partId: 'brake_caliper',
    label: {
      de: 'Festsitzender / defekter Bremssattel, Beläge klemmen',
      en: 'Seized / faulty brake caliper, pads sticking',
      ru: '«Закисший» / сломанный суппорт, клинит колодки',
      uk: 'Прикипілий / зламаний супорт, клинить колодки',
    },
  },
  {
    number: 68,
    category: 'chassis',
    frequent: false,
    defaultTier: 'T3',
    partId: 'brake_disc',
    label: {
      de: 'Überhitzte / verformte Bremsscheiben (Blaufärbung, Schlag)',
      en: 'Overheated / warped brake discs (bluing, runout)',
      ru: 'Перегретые / деформированные тормозные диски (посинение, биение)',
      uk: 'Перегріті / деформовані гальмівні диски (посиніння, биття)',
    },
  },
  {
    number: 69,
    category: 'chassis',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Beschädigter Bremsschlauch, schwitzender Schlauch',
      en: 'Damaged brake hose, weeping hose',
      ru: 'Повреждение тормозного шланга, «потеющий» шланг',
      uk: 'Пошкоджений гальмівний шланг, шланг «пітніє»',
    },
  },
  {
    number: 70,
    category: 'chassis',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Rost / Riefen an Achsmanschetten, Bremskolben',
      en: 'Rust / scoring on CV boots, brake pistons',
      ru: 'Ржавчина / задиры на пыльниках ШРУС, тормозных поршнях',
      uk: 'Іржа / задири на пильниках ШРКШ, гальмівних поршнях',
    },
  },

  // §3.6 Completeness & documentation (71–78)
  {
    number: 71,
    category: 'completeness',
    frequent: true,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Fehlendes Serviceheft / fehlende Servicestempel',
      en: 'Missing service booklet / service stamps',
      ru: 'Отсутствие сервисной книжки / штампов ТО',
      uk: 'Відсутність сервісної книжки / штампів ТО',
    },
  },
  {
    number: 72,
    category: 'completeness',
    frequent: true,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Fehlender Zweitschlüssel / fehlende Keyless-Karte',
      en: 'Missing second key / Keyless card',
      ru: 'Отсутствие второго ключа / карточки Keyless',
      uk: 'Відсутність другого ключа / картки Keyless',
    },
  },
  {
    number: 73,
    category: 'completeness',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Fehlendes Warndreieck, Verbandskasten, Feuerlöscher, Warnweste',
      en: 'Missing warning triangle, first-aid kit, fire extinguisher, hi-vis vest',
      ru: 'Отсутствие знака аварийной остановки, аптечки, огнетушителя, жилета',
      uk: 'Відсутність знака аварійної зупинки, аптечки, вогнегасника, жилета',
    },
  },
  {
    number: 74,
    category: 'completeness',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Fehlender Wagenheber, Radmutternschlüssel, Abschleppöse',
      en: 'Missing jack, wheel wrench, tow hook',
      ru: 'Отсутствие домкрата, баллонного ключа, буксировочной петли',
      uk: 'Відсутність домкрата, балонного ключа, буксирувальної петлі',
    },
  },
  {
    number: 75,
    category: 'completeness',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Fehlende Betriebsanleitung / FIN-Aufkleber an der Säule',
      en: 'Missing owner manual / VIN sticker on the pillar',
      ru: 'Отсутствие инструкции / VIN-наклейки на стойке',
      uk: 'Відсутність інструкції / VIN-наклейки на стійці',
    },
  },
  {
    number: 76,
    category: 'completeness',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Unleserliche / beschädigte FIN an Karosserie oder Typenschild',
      en: 'Illegible / damaged VIN on body or plate',
      ru: 'Нечитаемый / повреждённый номер VIN на кузове или табличке',
      uk: 'Нечитабельний / пошкоджений номер VIN на кузові або табличці',
    },
  },
  {
    number: 77,
    category: 'completeness',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'FIN in den Papieren stimmt nicht mit der Karosserie überein',
      en: 'VIN in documents does not match the body',
      ru: 'Несоответствие VIN в ПТС и на кузове',
      uk: 'Невідповідність VIN у документах і на кузові',
    },
  },
  {
    number: 78,
    category: 'completeness',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Nicht eingetragene / nicht zertifizierte Umbauten (Tuning, Lift, Chip)',
      en: 'Non-certified / unregistered modifications (tuning, lift, chip)',
      ru: 'Нестандартные / несертифицированные доработки (тюнинг, лифт, чип)',
      uk: 'Нестандартні / несертифіковані доробки (тюнінг, ліфт, чип)',
    },
  },

  // §3.7 Electronics & electronic systems (79–87)
  {
    number: 79,
    category: 'electronics',
    frequent: true,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Check-Engine / ABS / ESP / Airbag / EPC leuchtet',
      en: 'Check Engine / ABS / ESP / Airbag / EPC light on',
      ru: 'Горит Check Engine / ABS / ESP / Airbag / EPC',
      uk: 'Горить Check Engine / ABS / ESP / Airbag / EPC',
    },
  },
  {
    number: 80,
    category: 'electronics',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Klimaanlage ohne Funktion, kein Kältemittel',
      en: 'Air conditioning not working, no refrigerant',
      ru: 'Не работает кондиционер, нет хладагента',
      uk: 'Не працює кондиціонер, немає холодоагенту',
    },
  },
  {
    number: 81,
    category: 'electronics',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Schiebedach öffnet / schließt nicht',
      en: 'Sunroof does not open / close',
      ru: 'Не открывается / не закрывается люк',
      uk: 'Не відкривається / не закривається люк',
    },
  },
  {
    number: 82,
    category: 'electronics',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Elektrischer Fensterheber ohne Funktion',
      en: 'Power window not working',
      ru: 'Не работает электроподъёмник стекла',
      uk: 'Не працює електросклопідйомник',
    },
  },
  {
    number: 83,
    category: 'electronics',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Zentralverriegelung reagiert nicht / mit Fehlfunktion',
      en: 'Central locking not responding / malfunctioning',
      ru: 'Не срабатывает / глючит центральный замок',
      uk: 'Не спрацьовує / збоїть центральний замок',
    },
  },
  {
    number: 84,
    category: 'electronics',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Defekter Regen- / Lichtsensor',
      en: 'Faulty rain / light sensor',
      ru: 'Неисправный датчик дождя / света',
      uk: 'Несправний датчик дощу / світла',
    },
  },
  {
    number: 85,
    category: 'electronics',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Parkassistent, adaptiver Tempomat, Lane Assist ohne Funktion',
      en: 'Park assist, adaptive cruise, Lane Assist not working',
      ru: 'Не работает система помощи парковки, адаптивный круиз, Lane Assist',
      uk: 'Не працює система допомоги при паркуванні, адаптивний круїз, Lane Assist',
    },
  },
  {
    number: 86,
    category: 'electronics',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Fehler im eCall- / Telematiksystem',
      en: 'eCall / telematics system errors',
      ru: 'Ошибки системы eCall / телематики',
      uk: 'Помилки системи eCall / телематики',
    },
  },
  {
    number: 87,
    category: 'electronics',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Keine Verbindung zum Schlüssel (toter Chip)',
      en: 'No connection to the key (dead chip)',
      ru: 'Нет связи с ключом (мёртвый чип)',
      uk: 'Немає зв’язку з ключем (неробочий чип)',
    },
  },

  // §3.8 Other operational signs (88–98)
  {
    number: 88,
    category: 'operational',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Kraftstoff- / Abgasgeruch im Innenraum',
      en: 'Fuel / exhaust smell in the cabin',
      ru: 'Запах топлива / выхлопа в салоне',
      uk: 'Запах палива / вихлопу в салоні',
    },
  },
  {
    number: 89,
    category: 'operational',
    frequent: true,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Feuchtigkeit, Wasser, Schimmel unter Matten oder im Kofferraum',
      en: 'Damp, water, mold under mats or in the boot',
      ru: 'Сырость, вода, плесень под ковриками или в багажнике',
      uk: 'Вологість, вода, пліснява під килимками або в багажнику',
    },
  },
  {
    number: 90,
    category: 'operational',
    frequent: false,
    defaultTier: 'T3',
    partId: null,
    label: {
      de: 'Öl- / ATF-Flecken unter dem Fahrzeug nach dem Parken',
      en: 'Oil / ATF stains under the vehicle after parking',
      ru: 'Пятна масла / ATF под автомобилем после стоянки',
      uk: 'Плями оливи / ATF під автомобілем після стоянки',
    },
  },
  {
    number: 91,
    category: 'operational',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Hupe ohne Funktion',
      en: 'Horn not working',
      ru: 'Не работает звуковой сигнал',
      uk: 'Не працює звуковий сигнал',
    },
  },
  {
    number: 92,
    category: 'operational',
    frequent: false,
    defaultTier: 'T2',
    partId: 'gear_lever',
    label: {
      de: 'Beschädigter Schalthebel, Wählhebel AT / CVT / DSG',
      en: 'Damaged gear lever, AT / CVT / DSG selector',
      ru: 'Повреждённый рычаг КПП, селектор AT / CVT / DSG',
      uk: 'Пошкоджений важіль КПП, селектор AT / CVT / DSG',
    },
  },
  {
    number: 93,
    category: 'operational',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Beschädigte AdBlue-Klappe / leerer AdBlue-Tank (Diesel)',
      en: 'Damaged AdBlue flap / empty AdBlue tank (diesel)',
      ru: 'Повреждение лючка AdBlue / пустой бак AdBlue (дизель)',
      uk: 'Пошкодження лючка AdBlue / порожній бак AdBlue (дизель)',
    },
  },
  {
    number: 94,
    category: 'operational',
    frequent: false,
    defaultTier: 'T1',
    partId: 'trunk_mat',
    label: {
      de: 'Verrotteter / beschädigter Kofferraummatte',
      en: 'Rotted / damaged boot mat',
      ru: 'Сгнивший / повреждённый коврик в багажнике',
      uk: 'Згнилий / пошкоджений килимок багажника',
    },
  },
  {
    number: 95,
    category: 'operational',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Kältemittelaustritt, Geruch aus der Klimaanlage',
      en: 'Refrigerant leak, smell from the AC system',
      ru: 'Утечка фреона, запах из климатической системы',
      uk: 'Витік холодоагенту, запах із системи клімат-контролю',
    },
  },
  {
    number: 96,
    category: 'operational',
    frequent: false,
    defaultTier: 'T1',
    partId: null,
    label: {
      de: 'Nicht zugelassene Werbung / Aufkleber an Karosserie und Scheiben',
      en: 'Non-permitted advertising / stickers on body and glass',
      ru: 'Нерегламентная реклама / наклейки на кузове и стёклах',
      uk: 'Нерегламентована реклама / наклейки на кузові та склі',
    },
  },
  {
    number: 97,
    category: 'operational',
    frequent: false,
    defaultTier: 'T1',
    partId: 'license_plate_holder',
    label: {
      de: 'Defekte / fehlende Kennzeichenhalterung, Rahmen',
      en: 'Broken / missing license-plate mount, frame',
      ru: 'Сломанный / отсутствующий крепёж номерного знака, рамка',
      uk: 'Зламане / відсутнє кріплення номерного знака, рамка',
    },
  },
  {
    number: 98,
    category: 'operational',
    frequent: false,
    defaultTier: 'T2',
    partId: null,
    label: {
      de: 'Abweichung von der Werksausstattung (Felgen, Scheinwerfer, Grill)',
      en: 'Deviation from factory equipment (rims, headlights, grille)',
      ru: 'Несоответствие элементов заводской комплектации (диски, фары, решётка)',
      uk: 'Невідповідність елементів заводської комплектації (диски, фари, решітка)',
    },
  },
];

// ---------------------------------------------------------------------------
// Paint-thickness (Lackdicke) measurement stations — guided walk order
// ---------------------------------------------------------------------------

const THICKNESS_PANELS: ThicknessPanelDef[] = [
  {
    id: 'roof_rear_left',
    order: 1,
    partId: 'roof',
    label: {
      de: 'Dach (hintere linke Ecke)',
      en: 'Roof (rear left corner)',
      ru: 'Крыша (задний левый угол)',
      uk: 'Дах (задній лівий кут)',
    },
  },
  {
    id: 'fender_rear_left',
    order: 2,
    partId: 'side_panel_rear_left',
    label: {
      de: 'Seitenwand hinten links',
      en: 'Rear left quarter panel',
      ru: 'Задняя боковина слева',
      uk: 'Задня боковина зліва',
    },
  },
  {
    id: 'door_rear_left',
    order: 3,
    partId: 'door_rear_left',
    label: {
      de: 'Tür hinten links',
      en: 'Rear left door',
      ru: 'Задняя левая дверь',
      uk: 'Задні ліві двері',
    },
  },
  {
    id: 'opening_left',
    order: 4,
    partId: 'pillar_b_left',
    label: {
      de: 'Türöffnung / B-Säule links',
      en: 'Left door opening / B-pillar',
      ru: 'Дверной проём / стойка B слева',
      uk: 'Дверний проєм / стійка B зліва',
    },
  },
  {
    id: 'door_front_left',
    order: 5,
    partId: 'door_front_left',
    label: {
      de: 'Tür vorne links',
      en: 'Front left door',
      ru: 'Передняя левая дверь',
      uk: 'Передні ліві двері',
    },
  },
  {
    id: 'fender_front_left',
    order: 6,
    partId: 'fender_front_left',
    label: {
      de: 'Kotflügel vorne links',
      en: 'Front left fender',
      ru: 'Переднее левое крыло',
      uk: 'Переднє ліве крило',
    },
  },
  {
    id: 'hood',
    order: 7,
    partId: 'hood',
    label: {
      de: 'Motorhaube',
      en: 'Hood / bonnet',
      ru: 'Капот',
      uk: 'Капот',
    },
  },
  {
    id: 'fender_front_right',
    order: 8,
    partId: 'fender_front_right',
    label: {
      de: 'Kotflügel vorne rechts',
      en: 'Front right fender',
      ru: 'Переднее правое крыло',
      uk: 'Переднє праве крило',
    },
  },
  {
    id: 'door_front_right',
    order: 9,
    partId: 'door_front_right',
    label: {
      de: 'Tür vorne rechts',
      en: 'Front right door',
      ru: 'Передняя правая дверь',
      uk: 'Передні праві двері',
    },
  },
  {
    id: 'opening_right',
    order: 10,
    partId: 'pillar_b_right',
    label: {
      de: 'Türöffnung / B-Säule rechts',
      en: 'Right door opening / B-pillar',
      ru: 'Дверной проём / стойка B справа',
      uk: 'Дверний проєм / стійка B справа',
    },
  },
  {
    id: 'door_rear_right',
    order: 11,
    partId: 'door_rear_right',
    label: {
      de: 'Tür hinten rechts',
      en: 'Rear right door',
      ru: 'Задняя правая дверь',
      uk: 'Задні праві двері',
    },
  },
  {
    id: 'fender_rear_right',
    order: 12,
    partId: 'side_panel_rear_right',
    label: {
      de: 'Seitenwand hinten rechts',
      en: 'Rear right quarter panel',
      ru: 'Задняя боковина справа',
      uk: 'Задня боковина справа',
    },
  },
  {
    id: 'trunk_lid',
    order: 13,
    partId: 'trunk_lid',
    label: {
      de: 'Heckklappe',
      en: 'Trunk lid / tailgate',
      ru: 'Крышка багажника',
      uk: 'Кришка багажника',
    },
  },
];

// ---------------------------------------------------------------------------
// Assembled catalog
// ---------------------------------------------------------------------------

export const CATALOG_V1: CatalogV1 = {
  version: CATALOG_VERSION,
  angles: ANGLES,
  parts: PARTS,
  damageTypes: DAMAGE_TYPES,
  kstCodes: KST_CODES,
  checklist: CHECKLIST,
  thicknessPanels: THICKNESS_PANELS,
};
