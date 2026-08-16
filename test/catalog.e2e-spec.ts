import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';

/**
 * The inspector's dictated walk-around, as revised on 2026-08-10: down the left
 * flank, across the rear, open the boot, round to the front, open the bonnet,
 * then down the right flank.
 *
 * This is the client's requirement expressed as a SEQUENCE. Asserting it as a
 * set would let a reordering through, and the order is the deliverable.
 */
const REQUIRED_EXTERIOR_ORDER = [
  'diag_front_left',
  'left',
  'diag_rear_left',
  'rear',
  'trunk_open',
  'trunk_left',
  'trunk_right',
  'trunk_tools',
  'front',
  'hood_open',
  'engine_bay',
  'hood_underside',
  'engine_bay_left',
  'engine_bay_right',
  'diag_front_right',
  'right',
  'diag_rear_right',
];

/**
 * Every required exterior angle carries a hint, and the hints fall into THREE
 * families that say different things — that difference is the instruction.
 * On a diagonal the near front wheel is turned outward so the rim reads; on a
 * straight view the wheels are square; on a boot or bonnet angle nothing is
 * visible until something is opened or lifted. QA scenario 10 checks exactly
 * that, which is why the four straight angles that once shipped with no hint at
 * all are no longer allowed to be empty — and why the nine added in August are
 * not allowed to inherit a wheel-position hint that makes no sense for them.
 */
const DIAGONAL_ANGLES = [
  'diag_front_left',
  'diag_front_right',
  'diag_rear_right',
  'diag_rear_left',
];
const STRAIGHT_ANGLES = ['left', 'right', 'front', 'rear'];
/** The luggage-compartment and engine-bay angles added on 2026-08-10. */
const OPENING_ANGLES = [
  'trunk_open',
  'trunk_left',
  'trunk_right',
  'trunk_tools',
  'hood_open',
  'engine_bay',
  'hood_underside',
  'engine_bay_left',
  'engine_bay_right',
];
const HINTED_ANGLES = [...DIAGONAL_ANGLES, ...STRAIGHT_ANGLES, ...OPENING_ANGLES];

interface Label {
  de?: string;
  en?: string;
  ru?: string;
  uk?: string;
}
interface Angle {
  id: string;
  group: string;
  order: number;
  required: boolean;
  label: Label;
  hint?: Label;
}
interface Part {
  id: string;
  zone: string;
  label: Label;
}
interface ThicknessPanel {
  id: string;
  order: number;
  partId: string;
  label: Label;
}

describe('Catalog (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const getCatalog = async () => {
    const res = await request(app.getHttpServer()).get('/catalog').expect(200);
    return res.body as {
      version: string;
      angles: Angle[];
      parts: Part[];
      thicknessPanels: ThicknessPanel[];
    };
  };

  it('GET /catalog returns the full versioned catalog', async () => {
    const res = await request(app.getHttpServer()).get('/catalog').expect(200);
    expect(res.body.version).toBeDefined();
    expect(Array.isArray(res.body.angles)).toBe(true);
    // Exact, not a floor: a count that can only go up catches nothing, and this
    // one has moved twice (26 -> 35 on 2026-08-10).
    expect(res.body.angles.length).toBe(35);
    expect(Array.isArray(res.body.kstCodes)).toBe(true);
    expect(res.body.kstCodes.length).toBe(68);
    expect(Array.isArray(res.body.checklist)).toBe(true);
    expect(res.body.checklist.length).toBe(98);
    // The client's three registers replaced the old lists on 2026-08-14, and
    // his "General" list added 40 damage types and 27 repair methods on
    // 2026-08-16. Exact, for the same reason as the angles: these counts drive
    // what an inspector can record and what the cost engine can price.
    expect(res.body.damageTypes.length).toBe(167);
    expect(Array.isArray(res.body.parts)).toBe(true);
    expect(res.body.parts.length).toBe(410);
    expect(Array.isArray(res.body.repairMethods)).toBe(true);
    expect(res.body.repairMethods.length).toBe(232);
    expect(res.body.groups.length).toBe(8);
    expect(res.body.subgroups.length).toBe(67);
    // "General" opens first in every picker, and it holds no parts: a group
    // with no options in a register is not rendered at all, which is what
    // leaves the parts picker unchanged.
    const general = res.body.groups.find(
      (g: { id: string }) => g.id === 'g_general',
    );
    expect(general).toBeDefined();
    expect(general.order).toBe(1);
    expect(
      res.body.parts.filter((p: { groupId: string }) => p.groupId === 'g_general'),
    ).toHaveLength(0);
    // Every entry of the three registers must land in a real group, or it is
    // unreachable in the app's pickers — which is silent, not an error.
    const groupIds = new Set<string>(
      res.body.groups.map((g: { id: string }) => g.id),
    );
    const subgroupIds = new Set<string>(
      res.body.subgroups.map((s: { id: string }) => s.id),
    );
    for (const collection of ['parts', 'damageTypes', 'repairMethods']) {
      for (const entry of res.body[collection]) {
        expect(groupIds.has(entry.groupId)).toBe(true);
        if (entry.subgroupId !== null) {
          expect(subgroupIds.has(entry.subgroupId)).toBe(true);
        }
      }
    }
    // Every label is trilingual (four-locale completeness is asserted below).
    for (const code of res.body.kstCodes) {
      expect(code.label.de).toBeTruthy();
      expect(code.label.en).toBeTruthy();
      expect(code.label.ru).toBeTruthy();
    }
  });

  // `uk` is optional on `LocalizedLabel`, and the mobile client falls back
  // uk→ru when it is missing (catalog_models.dart). That fallback is
  // deliberate insurance, but it means an untranslated entry renders RUSSIAN
  // to a Ukrainian user with nothing failing anywhere. These assertions are
  // what turn "we forgot to translate it" into a red build.
  //
  // Hints are covered by the stricter assertion under `exterior angles`, which
  // also pins which four angles carry one.
  describe('four-locale completeness', () => {
    const collections = [
      'angles',
      'parts',
      'damageTypes',
      'kstCodes',
      'checklist',
      'thicknessPanels',
    ] as const;

    it('every label in every collection carries de, en, ru and uk', async () => {
      const catalog = (await getCatalog()) as unknown as Record<
        string,
        { id?: string; code?: string; number?: number; label: Label }[]
      >;
      const missing: string[] = [];
      for (const collection of collections) {
        const rows = catalog[collection];
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          const id = row.id ?? row.code ?? String(row.number);
          for (const locale of ['de', 'en', 'ru', 'uk'] as const) {
            if (!row.label?.[locale]) missing.push(`${collection}.${id}.${locale}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it('Ukrainian labels are Ukrainian, not a copied Russian column', async () => {
      const catalog = (await getCatalog()) as unknown as Record<
        string,
        { label: Label }[]
      >;
      const all = collections.flatMap((c) => catalog[c]).map((r) => r.label);
      // ы/э/ъ/ё exist in Russian but not Ukrainian: any occurrence is a
      // straight copy. і/ї/є/ґ are the converse tell, so a healthy corpus has
      // them in a large share of its entries.
      const russianOnly = all.filter((l) => /[ыэъёЫЭЪЁ]/.test(l.uk ?? ''));
      expect(russianOnly.map((l) => l.uk)).toEqual([]);
      const ukrainian = all.filter((l) => /[іїєґІЇЄҐ]/.test(l.uk ?? ''));
      expect(ukrainian.length / all.length).toBeGreaterThan(0.5);
    });
  });

  it('GET /catalog?version=<current> returns upToDate without the full payload', async () => {
    const full = await request(app.getHttpServer()).get('/catalog').expect(200);
    const current = full.body.version;
    const res = await request(app.getHttpServer()).get(`/catalog?version=${current}`).expect(200);
    expect(res.body.upToDate).toBe(true);
    expect(res.body.version).toBe(current);
    expect(res.body.kstCodes).toBeUndefined();
  });

  it('GET /catalog?version=stale returns the full payload', async () => {
    const res = await request(app.getHttpServer()).get('/catalog?version=0').expect(200);
    expect(res.body.kstCodes).toBeDefined();
  });

  describe('exterior angles', () => {
    it('the 17 required exterior angles follow the dictated walk-around order', async () => {
      const catalog = await getCatalog();
      const required = catalog.angles
        .filter((a) => a.group === 'exterior' && a.required)
        .sort((a, b) => a.order - b.order);
      expect(required.map((a) => a.id)).toEqual(REQUIRED_EXTERIOR_ORDER);
      expect(required.map((a) => a.order)).toEqual(
        Array.from({ length: 17 }, (_, i) => i + 1),
      );
    });

    it('every exterior angle is required, and there are no others', async () => {
      const catalog = await getCatalog();
      const exterior = catalog.angles.filter((a) => a.group === 'exterior');
      expect(exterior).toHaveLength(17);
      expect(exterior.every((a) => a.required)).toBe(true);
    });

    /**
     * The website indexes angle labels and part labels into ONE flat map
     * (`carsalepro-frontend/lib/catalog.ts` labelIndex), so an angle id equal to
     * a part id silently replaces that part's label in the damages and
     * paint-thickness tables. Nothing else checks this, and the August
     * additions came close: the catalog already has parts named `hood`,
     * `trunk_lid` and `trunk_mat`.
     */
    it('no angle id collides with a part id', async () => {
      const catalog = await getCatalog();
      const partIds = new Set(catalog.parts.map((p) => p.id));
      const collisions = catalog.angles.filter((a) => partIds.has(a.id)).map((a) => a.id);
      expect(collisions).toEqual([]);
    });

    it('every exterior photo kind fits the upload DTO slot pattern', async () => {
      const catalog = await getCatalog();
      const pattern = /^[a-z][a-z0-9_-]{0,47}$/;
      for (const angle of catalog.angles.filter((a) => a.group === 'exterior')) {
        expect(pattern.test(`exterior-${angle.id}`)).toBe(true);
      }
    });

    it('exposes a four-locale hint on every required exterior angle', async () => {
      const catalog = await getCatalog();
      const hinted = catalog.angles.filter((a) => a.hint);
      expect(hinted.map((a) => a.id).sort()).toEqual([...HINTED_ANGLES].sort());
      for (const angle of hinted) {
        expect(angle.hint?.de).toBeTruthy();
        expect(angle.hint?.en).toBeTruthy();
        expect(angle.hint?.ru).toBeTruthy();
        expect(angle.hint?.uk).toBeTruthy();
      }
    });

    it('gives diagonals and straight views different wheel guidance', async () => {
      const catalog = await getCatalog();
      const hintOf = (id: string) => catalog.angles.find((a) => a.id === id)?.hint;

      // Diagonals: turn the near front wheel out. Straight views: wheels square.
      // Asserted per locale, because a half-translated hint is what QA sees.
      for (const id of DIAGONAL_ANGLES) {
        expect(hintOf(id)?.de).toContain('Vorderrad');
        expect(hintOf(id)?.en?.toLowerCase()).toContain('outward');
        expect(hintOf(id)?.ru).toContain('наружу');
        expect(hintOf(id)?.uk).toContain('назовні');
      }
      for (const id of STRAIGHT_ANGLES) {
        expect(hintOf(id)?.de).toContain('gerade');
        expect(hintOf(id)?.en?.toLowerCase()).toContain('straight');
        expect(hintOf(id)?.ru).toContain('прямо');
        expect(hintOf(id)?.uk).toContain('прямо');
      }

      // The three sets must not collide — the whole point of scenario 10 is
      // that an inspector can tell from the instruction which shot they are on.
      const diagonalTexts = new Set(DIAGONAL_ANGLES.map((id) => hintOf(id)?.en));
      const straightTexts = new Set(STRAIGHT_ANGLES.map((id) => hintOf(id)?.en));
      const openingTexts = new Set(OPENING_ANGLES.map((id) => hintOf(id)?.en));
      for (const text of diagonalTexts) {
        expect(straightTexts.has(text)).toBe(false);
        expect(openingTexts.has(text)).toBe(false);
      }
      for (const text of straightTexts) {
        expect(openingTexts.has(text)).toBe(false);
      }
    });

    it('the boot and bonnet angles say what to open, never where to steer', async () => {
      const catalog = await getCatalog();
      const hintOf = (id: string) => catalog.angles.find((a) => a.id === id)?.hint;
      for (const id of OPENING_ANGLES) {
        expect(hintOf(id)?.en?.toLowerCase()).not.toContain('wheel');
        expect(hintOf(id)?.de).not.toContain('Vorderrad');
      }
    });

    /**
     * English is the PIVOT for the 26 machine-translated locales, so an
     * ambiguous English word is a correctness bug rather than a style one.
     * Every word below shipped once during this cycle and came back wrong in a
     * double-digit number of languages: "boot" as footwear (cs "kopačka",
     * pl "but", ja "ブーツ"), "shot" as a gunshot (pl "strzał", da "bredskud"),
     * and — when they stand alone — "bay" as a coastal bay in all 26 and "hood"
     * as a garment hood (el "κουκούλα", pl "kaptur"). The compounds
     * "engine bay" and "engine hood" translate correctly everywhere.
     */
    it('no English exterior string uses a word the translation pivot mangles', async () => {
      const catalog = await getCatalog();
      for (const angle of catalog.angles.filter((a) => a.group === 'exterior')) {
        const en = `${angle.label.en ?? ''} ${angle.hint?.en ?? ''}`.toLowerCase();
        const words = en.split(/[^a-z]+/);
        expect(words).not.toContain('boot');
        expect(words).not.toContain('shot');
        for (const word of ['bay', 'hood']) {
          for (const match of en.matchAll(new RegExp(`(\\w+) ${word}`, 'g'))) {
            expect(match[1]).toBe('engine');
          }
          // A bare occurrence with nothing before it would slip past the loop.
          expect(en.startsWith(`${word} `)).toBe(false);
        }
      }
    });
  });

  describe('interior angles', () => {
    it('has 12 interior angles, all optional, with four-locale labels on the new ones', async () => {
      const catalog = await getCatalog();
      const interior = catalog.angles
        .filter((a) => a.group === 'interior')
        .sort((a, b) => a.order - b.order);
      expect(interior.length).toBe(12);
      expect(interior.every((a) => a.required === false)).toBe(true);
      expect(interior.map((a) => a.id)).toEqual([
        'interior_front',
        'interior_rear',
        'interior_dashboard',
        'interior_boot',
        'interior_seats',
        'interior_steering_wheel',
        'interior_pedals',
        'interior_overview',
        'interior_door_trim_fl',
        'interior_door_trim_fr',
        'interior_door_trim_rl',
        'interior_door_trim_rr',
      ]);
      for (const angle of interior.slice(5)) {
        expect(angle.label.de).toBeTruthy();
        expect(angle.label.en).toBeTruthy();
        expect(angle.label.ru).toBeTruthy();
        expect(angle.label.uk).toBeTruthy();
      }
      // Mobile derives the photo kind as `interior-<id>` — the whole key must
      // satisfy the upload DTO's slot regex.
      for (const angle of interior) {
        expect(`interior-${angle.id}`).toMatch(/^[a-z][a-z0-9_-]{0,47}$/);
      }
    });
  });

  describe('parts', () => {
    it('includes both B-pillars for structural damages', async () => {
      const catalog = await getCatalog();
      const left = catalog.parts.find((p) => p.id === 'pillar_b_left');
      const right = catalog.parts.find((p) => p.id === 'pillar_b_right');
      expect(left?.zone).toBe('left');
      expect(right?.zone).toBe('right');
      for (const part of [left, right]) {
        expect(part?.label.de).toBeTruthy();
        expect(part?.label.en).toBeTruthy();
        expect(part?.label.ru).toBeTruthy();
        expect(part?.label.uk).toBeTruthy();
      }
    });

    it('part ids are unique', async () => {
      const catalog = await getCatalog();
      expect(new Set(catalog.parts.map((p) => p.id)).size).toBe(catalog.parts.length);
    });
  });

  describe('thickness panels', () => {
    it('exposes 13 stations with unique ids and contiguous order 1..13', async () => {
      const catalog = await getCatalog();
      expect(Array.isArray(catalog.thicknessPanels)).toBe(true);
      expect(catalog.thicknessPanels.length).toBe(13);
      expect(new Set(catalog.thicknessPanels.map((p) => p.id)).size).toBe(13);
      expect([...catalog.thicknessPanels.map((p) => p.order)].sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
    });

    it('every panelId maps to a real part and carries four-locale labels', async () => {
      const catalog = await getCatalog();
      const partIds = new Set(catalog.parts.map((p) => p.id));
      for (const panel of catalog.thicknessPanels) {
        expect(partIds.has(panel.partId)).toBe(true);
        expect(panel.label.de).toBeTruthy();
        expect(panel.label.en).toBeTruthy();
        expect(panel.label.ru).toBeTruthy();
        expect(panel.label.uk).toBeTruthy();
        // `extra_` is reserved for user-added ad-hoc measurements.
        expect(panel.id.startsWith('extra_')).toBe(false);
      }
    });

    it('walks the vehicle roof → left → front → right → tailgate', async () => {
      const catalog = await getCatalog();
      const inOrder = [...catalog.thicknessPanels].sort((a, b) => a.order - b.order);
      expect(inOrder.map((p) => p.id)).toEqual([
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
      ]);
      expect(inOrder[3].partId).toBe('pillar_b_left');
      expect(inOrder[9].partId).toBe('pillar_b_right');
    });
  });
});
