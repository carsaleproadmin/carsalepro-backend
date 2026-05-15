import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { cleanDb, createTestApp } from './helpers/test-app';

describe('GET /vin/:vin (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDb(app);
  });

  it('400 on malformed VIN', async () => {
    const res = await request(app.getHttpServer()).get('/vin/SHORT').expect(400);
    expect(res.body.message).toMatch(/VIN must be/);
  });

  it('decodes valid VIN and caches it', async () => {
    const vin = '1HGBH41JXMN109186';
    const first = await request(app.getHttpServer()).get(`/vin/${vin}`).expect(200);
    expect(first.body.vin).toBe(vin);
    expect(first.body.make).toBeTruthy();
    expect(first.body.cached).toBe(false);

    const second = await request(app.getHttpServer()).get(`/vin/${vin}`).expect(200);
    expect(second.body.cached).toBe(true);
    expect(second.body.make).toBe(first.body.make);
  });
});
