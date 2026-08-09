import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';

describe('GET /health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with database up', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
    expect(['up']).toContain(res.body.info.r2.status);
  });

  /**
   * `/health` is `healthCheckPath` in render.yaml. Nothing third-party may be
   * added to it: a Mapbox or Stripe outage must not pull the service out of
   * rotation. The self-check lives on its own route precisely so that this one
   * can stay boring.
   */
  it('does not probe third parties from the liveness route', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(Object.keys(res.body.info)).toEqual(expect.arrayContaining(['database', 'r2']));
    expect(Object.keys(res.body.info)).not.toEqual(expect.arrayContaining(['mapbox', 'stripe']));
  });
});

describe('GET /health/startup (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('always answers 200, even when findings exist', async () => {
    const res = await request(app.getHttpServer()).get('/health/startup').expect(200);
    expect(['ok', 'degraded', 'fail']).toContain(res.body.status);
    expect(typeof res.body.checkedAt).toBe('string');
    expect(res.body.counts).toEqual(
      expect.objectContaining({
        fatal: expect.any(Number),
        error: expect.any(Number),
        warn: expect.any(Number),
        info: expect.any(Number),
      }),
    );
  });

  it('nothing is fatal outside production - the app booted at all, which proves it', async () => {
    const res = await request(app.getHttpServer()).get('/health/startup').expect(200);
    expect(res.body.counts.fatal).toBe(0);
  });

  it('shows the detail outside production, keyed by check id', async () => {
    const res = await request(app.getHttpServer()).get('/health/startup').expect(200);
    const ids: string[] = res.body.findings.map((f: { id: string }) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['cors', 'r2.reports', 'r2.kyc']));
    expect(res.body.detailsWithheld).toBeUndefined();
  });

  /**
   * The one invariant that matters more than the route itself: a deploy log or
   * a diagnostic response must never carry a credential. Every env row is
   * `MISSING` or `set (len N)`, with the defect codes appended.
   */
  it('describes every critical variable without ever emitting its value', async () => {
    const res = await request(app.getHttpServer()).get('/health/startup').expect(200);
    const rows: Array<{ name: string; description: string }> = res.body.env;
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.some((row) => row.name === 'JWT_SECRET')).toBe(true);

    for (const row of rows) {
      expect(row.description).toMatch(/^(MISSING|set \(len \d+\))/);
      if (process.env[row.name]) {
        expect(row.description).not.toContain(process.env[row.name]);
      }
    }

    const body = JSON.stringify(res.body);
    if (process.env.JWT_SECRET) expect(body).not.toContain(process.env.JWT_SECRET);
    if (process.env.R2_SECRET_ACCESS_KEY) {
      expect(body).not.toContain(process.env.R2_SECRET_ACCESS_KEY);
    }
  });

  it('skips network probes under NODE_ENV=test', async () => {
    const res = await request(app.getHttpServer()).get('/health/startup').expect(200);
    const messages: string[] = res.body.findings.map((f: { message: string }) => f.message);
    expect(messages.some((m) => m.includes('NODE_ENV=test'))).toBe(true);
  });

  it('needs no auth (it is a diagnostic, not an /api/v1 route)', async () => {
    await request(app.getHttpServer())
      .get('/health/startup')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(200);
  });
});
