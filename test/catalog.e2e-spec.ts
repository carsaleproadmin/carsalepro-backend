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
 * The hints fall into FAMILIES that say different things — that difference is
 * the instruction. On a FRONT diagonal the near front wheel is turned INWARD so
 * the rim and the brake disc read - turning it out hides the wheel face behind
 * the arch and shows the tyre sidewall, which is not what the angle documents
 * (2026-08-19). On every other flank view the wheels are square; on a boot or
 * bonnet angle nothing is visible until something is opened or lifted; five
 * cabin angles are shot from the rear seat, because the console cannot be framed
 * from the driver's door. QA scenario 10 checks exactly that, which is why the
 * four straight angles that once shipped with no hint at all are no longer
 * allowed to be empty — and why the nine added in August are not allowed to
 * inherit a wheel-position hint that makes no sense for them.
 *
 * The diagonal/straight BOUNDARY moved on 2026-08-17. Both REAR diagonals now
 * square the wheels: on a rear three-quarter view the near front wheel is at the
 * far end of the car, so turning it out shows nothing and spoils the stance. The
 * client reported it against the rear-right angle and the rear-left had the same
 * defect. The two now hold the straight family's text BYTE-IDENTICALLY, on
 * purpose — that is what stops the change creating a translation unit in each of
 * the 31 sidecars.
 *
 * The DIRECTION moved on 2026-08-19 for the front pair, and this file kept the
 * old word. The constant and its three assertions still read `outward` while
 * the catalogue read `inward`, so the suite failed against a string that was
 * deliberately correct. Named for the direction it asserts, so the next change
 * of direction cannot leave the name describing the opposite of the test.
 */
const INWARD_WHEEL_ANGLES = ['diag_front_left', 'diag_front_right'];
const WHEELS_SQUARE_ANGLES = [
  'left',
  'right',
  'front',
  'rear',
  'diag_rear_left',
  'diag_rear_right',
];
/** One authored text under five keys — the client's footnote of 2026-08-17. */
const REAR_SEAT_ANGLES = [
  'interior_rear_armrest',
  'interior_dashboard',
  'interior_steering_wheel',
  'interior_head_unit',
  'interior_gear_selector',
];
/** The only other hinted interior angle: «нет книги значит только ключи». */
const DOCUMENTS_ANGLES = ['interior_documents_keys'];
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
const HINTED_ANGLES = [
  ...INWARD_WHEEL_ANGLES,
  ...WHEELS_SQUARE_ANGLES,
  ...OPENING_ANGLES,
  ...REAR_SEAT_ANGLES,
  ...DOCUMENTS_ANGLES,
];

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
      // The register labels are read by the pivot-word guard: a part or a damage
      // type is printed in the report a buyer reads, so an ambiguous English
      // string there is the same correctness bug as one on an angle.
      damageTypes: Array<{ id: string; label: Label }>;
      repairMethods: Array<{ id: string; label: Label }>;
      thicknessPanels: ThicknessPanel[];
    };
  };

  it('GET /catalog returns the full versioned catalog', async () => {
    const res = await request(app.getHttpServer()).get('/catalog').expect(200);
    expect(res.body.version).toBeDefined();
    expect(Array.isArray(res.body.angles)).toBe(true);
    // Exact, not a floor: a count that can only go up catches nothing, and this
    // one has moved three times (26 -> 35 on 2026-08-10, 35 -> 40 on 2026-08-17
    // when the cabin went from 12 slots to the client's ordered 17).
    expect(res.body.angles.length).toBe(40);
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

    it('exposes a four-locale hint on every angle that declares a family', async () => {
      const catalog = await getCatalog();
      const hinted = catalog.angles.filter((a) => a.hint);
      // Every hint belongs to a declared family and nothing else carries one.
      // An angle that acquires a hint outside a family would show guidance that
      // does not apply to it, which is worse than showing none: wheels, paint
      // stations, the odometer, the VIN plate and eleven of the seventeen cabin
      // angles are framed by their example thumbnail alone.
      expect(hinted.map((a) => a.id).sort()).toEqual([...HINTED_ANGLES].sort());
      expect(hinted).toHaveLength(23);
      for (const angle of hinted) {
        expect(angle.hint?.de).toBeTruthy();
        expect(angle.hint?.en).toBeTruthy();
        expect(angle.hint?.ru).toBeTruthy();
        expect(angle.hint?.uk).toBeTruthy();
      }
    });

    it('only the FRONT diagonals ask for the wheel to be turned out', async () => {
      const catalog = await getCatalog();
      const hintOf = (id: string) => catalog.angles.find((a) => a.id === id)?.hint;

      // Front diagonals: turn the near front wheel out. Every other flank view,
      // the two rear diagonals included since 2026-08-17: wheels square.
      // Asserted per locale, because a half-translated hint is what QA sees.
      for (const id of INWARD_WHEEL_ANGLES) {
        expect(hintOf(id)?.de).toContain('Vorderrad');
        expect(hintOf(id)?.en?.toLowerCase()).toContain('inward');
        expect(hintOf(id)?.ru).toContain('внутрь');
        expect(hintOf(id)?.uk).toContain('всередину');
      }
      for (const id of WHEELS_SQUARE_ANGLES) {
        expect(hintOf(id)?.de).toContain('gerade');
        expect(hintOf(id)?.en?.toLowerCase()).toContain('straight');
        expect(hintOf(id)?.ru).toContain('прямо');
        expect(hintOf(id)?.uk).toContain('прямо');
      }

      // The rear pair must hold the straight text BYTE-IDENTICALLY, in all four
      // hand-authored locales. Same string means `extract.mjs` emits no new
      // translation unit and every sidecar reuses a value it already holds; a
      // reworded near-duplicate would silently cost 31 hand translations.
      for (const id of ['diag_rear_left', 'diag_rear_right']) {
        expect(hintOf(id)).toEqual(hintOf('left'));
      }
    });

    it('the families do not collide, so a hint names the shot it is on', async () => {
      const catalog = await getCatalog();
      const hintOf = (id: string) => catalog.angles.find((a) => a.id === id)?.hint;
      const textsOf = (ids: string[]) => new Set(ids.map((id) => hintOf(id)?.en));

      // The whole point of scenario 10: an inspector can tell from the
      // instruction which kind of shot they are on. `WHEELS_SQUARE_ANGLES` and
      // the rear diagonals SHARE a text on purpose, which is why the comparison
      // is between families and never between angles.
      const families = [
        textsOf(INWARD_WHEEL_ANGLES),
        textsOf(WHEELS_SQUARE_ANGLES),
        textsOf(OPENING_ANGLES),
        textsOf(REAR_SEAT_ANGLES),
        textsOf(DOCUMENTS_ANGLES),
      ];
      for (let i = 0; i < families.length; i += 1) {
        for (let j = i + 1; j < families.length; j += 1) {
          for (const text of families[i]) {
            expect(families[j].has(text)).toBe(false);
          }
        }
      }
    });

    it('the boot and bonnet angles say what to open, never where to steer', async () => {
      const catalog = await getCatalog();
      const hintOf = (id: string) => catalog.angles.find((a) => a.id === id)?.hint;
      for (const id of [...OPENING_ANGLES, ...REAR_SEAT_ANGLES, ...DOCUMENTS_ANGLES]) {
        expect(hintOf(id)?.en?.toLowerCase()).not.toContain('wheel');
        expect(hintOf(id)?.de).not.toContain('Vorderrad');
      }
    });

    it('the five rear-seat angles carry ONE text under five keys', async () => {
      const catalog = await getCatalog();
      const hintOf = (id: string) => catalog.angles.find((a) => a.id === id)?.hint;
      for (const locale of ['de', 'en', 'ru', 'uk'] as const) {
        const texts = new Set(REAR_SEAT_ANGLES.map((id) => hintOf(id)?.[locale]));
        expect(texts.size).toBe(1);
        expect([...texts][0]).toBeTruthy();
      }
      // Where to STAND, not what to do to the car — and never "shoot": `shot`
      // came back as a gunshot in nine locales.
      const en = hintOf('interior_head_unit')?.en?.toLowerCase() ?? '';
      expect(en).toContain('rear seat');
      expect(en).not.toContain('shot');
    });

    /**
     * English is the PIVOT for the 26 machine-translated locales, so an
     * ambiguous English word is a correctness bug rather than a style one.
     * Every word below shipped once and came back wrong in a double-digit number
     * of languages: "boot" as footwear (cs "kopačka", pl "but", ja "ブーツ"),
     * "shot" as a gunshot (pl "strzał", da "bredskud"), and — when they stand
     * alone — "bay" as a coastal bay in all 26 and "hood" as a garment hood
     * (el "κουκούλα", pl "kaptur").
     *
     * The 2026-08-17 additions, each found in shipped output:
     *  - "shoot" — the same gunshot as "shot", and refusing one inflection and
     *    not the other is not a guard. `hood_underside.hint` read "Shoot it from
     *    below." and meant FIRE A WEAPON in at least eleven locales.
     *  - "gaiter" — a legging. The rubber cover on a CV joint came back as a spat
     *    (fa), a walker (sv), a garland (it), a squid (pt) and a GUIDED MISSILE
     *    (zh). The register says "bellows" now.
     *  - "undercarriage" — aircraft landing gear (zh 起落架, ja 降着装置,
     *    ko 착륙장치, pt "trem de pouso"). It says "underbody".
     *  - "pinch" — to pin something (pl "przypiąć", ko "핀으로 눌러").
     *  - "play" unless qualified — a GAME in Georgian. Seven suspension and
     *    interior entries say "free play".
     *  - "plate" unless qualified — the LICENCE plate (da "VIN-nummerplade",
     *    zh VIN车牌, it "Targa", es "Matrícula"). The VIN one is a "data plate".
     *  - "gauge" unless qualified — the railway track gauge (zh 轨距, ko 궤간).
     */
    const BANNED_OUTRIGHT = [
      'boot',
      'shot',
      'shoot',
      'shooting',
      'gaiter',
      'undercarriage',
      'pinch',
    ];
    /** Safe only behind a qualifier, and the qualifier differs per word. */
    const QUALIFIERS: Record<string, string[]> = {
      bay: ['engine'],
      hood: ['engine'],
      play: ['free'],
      // `number plate` and `scuff plate` are correct: there it IS that plate.
      plate: ['data', 'underbody', 'number', 'scuff'],
      gauge: ['thickness', 'paint'],
    };

    it('no English catalog string uses a word the translation pivot mangles', async () => {
      const catalog = await getCatalog();
      // Widened on 2026-08-17 from the exterior angles to EVERY angle AND every
      // register label. It had been exterior-only, and `interior_boot` was
      // reading "Boot / trunk" — the very word this test refuses — while the
      // registers carried a guided missile and a squid. A part or a damage type is
      // printed in the report a buyer reads, so it is in scope.
      const subjects: Array<[string, string]> = [
        ...catalog.angles.map(
          (a) =>
            [`angle ${a.id}`, `${a.label.en ?? ''} ${a.hint?.en ?? ''}`] as [string, string],
        ),
        ...catalog.parts.map((p) => [`part ${p.id}`, p.label.en ?? ''] as [string, string]),
        ...catalog.damageTypes.map(
          (d) => [`damageType ${d.id}`, d.label.en ?? ''] as [string, string],
        ),
        ...catalog.repairMethods.map(
          (m) => [`repairMethod ${m.id}`, m.label.en ?? ''] as [string, string],
        ),
      ];

      for (const [subject, value] of subjects) {
        const en = value.toLowerCase();
        const words = en.split(/[^a-z]+/);
        for (const word of BANNED_OUTRIGHT) {
          expect({ subject, word, banned: words.includes(word) }).toEqual({
            subject,
            word,
            banned: false,
          });
        }
        for (const [word, allowed] of Object.entries(QUALIFIERS)) {
          if (!words.includes(word)) continue;
          // A hyphen qualifies as well as a space: the register writes
          // "Number-plate light", which a space-only match calls a BARE "plate".
          const matches = [...en.matchAll(new RegExp(`([a-z]+)[ -]${word}`, 'g'))];
          expect({ subject, word, qualified: matches.length > 0 }).toEqual({
            subject,
            word,
            qualified: true,
          });
          for (const match of matches) {
            expect({ subject, word, qualifier: match[1] }).toEqual({
              subject,
              word,
              qualifier: expect.stringMatching(new RegExp(`^(${allowed.join('|')})$`)),
            });
          }
        }
      }
    });
  });

  describe('interior angles', () => {
    it('has 17 interior angles in the order the client dictated, all optional', async () => {
      const catalog = await getCatalog();
      const interior = catalog.angles
        .filter((a) => a.group === 'interior')
        .sort((a, b) => a.order - b.order);
      expect(interior.length).toBe(17);
      expect(interior.every((a) => a.required === false)).toBe(true);
      // A SEQUENCE and never a set: the order is the client deliverable of
      // 2026-08-17 (`images/internal_ordered_numbered/1..17.jpg`) — down the
      // left flank door by door, through the console from the rear seat, the
      // cluster and the papers, then the right flank, then the luggage area.
      expect(interior.map((a) => a.id)).toEqual([
        'interior_front',
        'interior_door_trim_fl',
        'interior_rear',
        'interior_door_trim_rl',
        'interior_rear_armrest',
        'interior_dashboard',
        'interior_steering_wheel',
        'interior_head_unit',
        'interior_gear_selector',
        'interior_pedals',
        'interior_instrument_cluster',
        'interior_documents_keys',
        'interior_front_right',
        'interior_door_trim_fr',
        'interior_rear_right',
        'interior_door_trim_rr',
        'interior_boot',
      ]);
      // The two retired on 2026-08-17. Their ids are persisted as photo kinds,
      // so a draft can still hold one; nothing may re-mint them here.
      const ids = catalog.angles.map((a) => a.id);
      expect(ids).not.toContain('interior_seats');
      expect(ids).not.toContain('interior_overview');
      for (const angle of interior) {
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
    /*
     * SEVENTEEN since 2026-08-19, not thirteen. The four door sills were added
     * where the client asked for them rather than appended, so the orders of
     * every station after the first sill moved as well. This file kept the old
     * count and the old walk, and failed against a catalogue that was correct.
     *
     * The quality weight did not move with the expansion, so an already
     * complete report drops from 100 to 96. That is a consequence and not a
     * defect - see CLAUDE.md.
     */
    it('exposes 17 stations with unique ids and contiguous order 1..17', async () => {
      const catalog = await getCatalog();
      expect(Array.isArray(catalog.thicknessPanels)).toBe(true);
      expect(catalog.thicknessPanels.length).toBe(17);
      expect(new Set(catalog.thicknessPanels.map((p) => p.id)).size).toBe(17);
      expect([...catalog.thicknessPanels.map((p) => p.order)].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 17 }, (_, i) => i + 1),
      );
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
      // The left flank is deliberately NOT a mirror of the right: the sills sit
      // where the client dictated them, which is outside the b-pillar opening
      // on the left and inside it on the right.
      expect(inOrder.map((p) => p.id)).toEqual([
        'roof_rear_left',
        'fender_rear_left',
        'door_rear_left',
        'sill_rear_left',
        'opening_left',
        'sill_front_left',
        'door_front_left',
        'fender_front_left',
        'hood',
        'fender_front_right',
        'door_front_right',
        'sill_front_right',
        'opening_right',
        'door_rear_right',
        'sill_rear_right',
        'fender_rear_right',
        'trunk_lid',
      ]);

      // Found by id and not by index, so inserting a station cannot make these
      // two assertions silently describe a different one.
      const partOf = (id: string) => inOrder.find((p) => p.id === id)?.partId;
      expect(partOf('opening_left')).toBe('pillar_b_left');
      expect(partOf('opening_right')).toBe('pillar_b_right');

      // Two stations per side share ONE painted part: a sill belongs to the
      // rocker panel, and `sill_left`/`sill_right` are the decorative trim.
      expect(partOf('sill_rear_left')).toBe('rocker_panel_left');
      expect(partOf('sill_front_left')).toBe('rocker_panel_left');
      expect(partOf('sill_rear_right')).toBe('rocker_panel_right');
      expect(partOf('sill_front_right')).toBe('rocker_panel_right');
    });
  });
});
