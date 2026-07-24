import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';

/** The inspector's dictated walk-around (diagonal → side → front/rear). */
const REQUIRED_EXTERIOR_ORDER = [
  'diag_front_left',
  'left',
  'front',
  'diag_front_right',
  'right',
  'diag_rear_right',
  'rear',
  'diag_rear_left',
];

/** Angles whose hint explains the front-wheel position. */
const HINTED_ANGLES = ['diag_front_left', 'left', 'diag_front_right', 'right'];

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
    expect(res.body.angles.length).toBeGreaterThanOrEqual(8);
    expect(Array.isArray(res.body.kstCodes)).toBe(true);
    expect(res.body.kstCodes.length).toBe(68);
    expect(Array.isArray(res.body.checklist)).toBe(true);
    expect(res.body.checklist.length).toBe(98);
    expect(res.body.damageTypes.length).toBe(10);
    expect(Array.isArray(res.body.parts)).toBe(true);
    // Every label is trilingual.
    for (const code of res.body.kstCodes) {
      expect(code.label.de).toBeTruthy();
      expect(code.label.en).toBeTruthy();
      expect(code.label.ru).toBeTruthy();
    }
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
    it('the 8 required exterior angles follow the dictated walk-around order', async () => {
      const catalog = await getCatalog();
      const required = catalog.angles
        .filter((a) => a.group === 'exterior' && a.required)
        .sort((a, b) => a.order - b.order);
      expect(required.map((a) => a.id)).toEqual(REQUIRED_EXTERIOR_ORDER);
      expect(required.map((a) => a.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('exposes a four-locale hint on exactly the four wheel-position angles', async () => {
      const catalog = await getCatalog();
      const hinted = catalog.angles.filter((a) => a.hint);
      expect(hinted.map((a) => a.id).sort()).toEqual([...HINTED_ANGLES].sort());
      for (const angle of hinted) {
        expect(angle.hint?.de).toBeTruthy();
        expect(angle.hint?.en).toBeTruthy();
        expect(angle.hint?.ru).toBeTruthy();
        expect(angle.hint?.uk).toBeTruthy();
      }
      // The diagonals mention the turned wheel, the sides the straight wheels.
      expect(catalog.angles.find((a) => a.id === 'diag_front_left')?.hint?.de).toContain(
        'Vorderrad',
      );
      expect(catalog.angles.find((a) => a.id === 'left')?.hint?.de).toContain('gerade');
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
