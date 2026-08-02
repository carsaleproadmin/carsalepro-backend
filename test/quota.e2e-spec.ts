import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { cleanDb, createTestApp, uniqueDeviceId } from './helpers/test-app';

describe('Quota (e2e)', () => {
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

  it('400 when X-Device-Id missing', async () => {
    await request(app.getHttpServer()).get('/quota').expect(400);
  });

  it('initial quota reports 0/3 as historical counters, unenforced, not pro', async () => {
    // The five legacy fields must stay byte-identical: the shipped Flutter app
    // parses them through a freezed DTO with non-nullable ints. They are now
    // just counters — `freeLimitEnforced: false` is what says the cap is dead.
    const did = uniqueDeviceId();
    const res = await request(app.getHttpServer())
      .get('/quota')
      .set('x-device-id', did)
      .expect(200);
    expect(res.body).toMatchObject({
      deviceId: did,
      freeReportsUsed: 0,
      freeReportsLimit: 3,
      isPro: false,
      remaining: 3,
      freeLimitEnforced: false,
    });
  });

  it('upgrade marks device PRO in client-trust mode (default in tests)', async () => {
    const did = uniqueDeviceId();
    const res = await request(app.getHttpServer())
      .post('/quota/upgrade')
      .set('x-device-id', did)
      .send({ platform: 'ios', receipt: 'iap-receipt-token-xyz' })
      .expect(200);
    expect(res.body.isPro).toBe(true);
  });

  it('upgrade rejects unknown platform', async () => {
    const did = uniqueDeviceId();
    await request(app.getHttpServer())
      .post('/quota/upgrade')
      .set('x-device-id', did)
      .send({ platform: 'web', receipt: 'x' })
      .expect(400);
  });

  it('upgrade rejects when IAP server-mode is on but Apple creds are missing', async () => {
    // Force server mode without creds for this single test, then restore.
    const prevMode = process.env.IAP_VALIDATION_MODE;
    process.env.IAP_VALIDATION_MODE = 'server';
    const isolated = await createTestApp();
    try {
      const did = uniqueDeviceId();
      const res = await request(isolated.getHttpServer())
        .post('/quota/upgrade')
        .set('x-device-id', did)
        .send({ platform: 'ios', receipt: 'definitely-fake' })
        .expect(400);
      expect(res.body.message).toMatch(/APPLE_SHARED_SECRET|APPLE_/);
    } finally {
      await isolated.close();
      if (prevMode === undefined) delete process.env.IAP_VALIDATION_MODE;
      else process.env.IAP_VALIDATION_MODE = prevMode;
    }
  });
});
