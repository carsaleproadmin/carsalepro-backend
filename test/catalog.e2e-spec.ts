import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';

describe('Catalog (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

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
});
