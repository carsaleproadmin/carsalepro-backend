import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { cleanDb, createTestApp, uniqueDeviceId } from './helpers/test-app';
import { PrismaService } from '../src/prisma/prisma.service';

const r2Configured = Boolean(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
);

/** Fresh globally-unique idempotency key (`CSP-<uuid v4>`) per create. */
function uniqueCode(): string {
  return `CSP-${randomUUID()}`;
}

describe('Reports (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanDb(app);
  });

  it('a FREE device can create an unbounded number of reports (no 402)', async () => {
    const did = uniqueDeviceId();

    if (r2Configured) {
      for (let i = 0; i < 5; i++) {
        const res = await request(app.getHttpServer())
          .post('/reports')
          .set('x-device-id', did)
          .send({ code: uniqueCode(), vin: '1HGBH41JXMN109186' });
        expect(res.status).toBe(201);
        expect(res.body.tier).toBe('free');
      }
      // The counter still advances (free analytics + it keeps `remaining`
      // consistent should ENFORCE_FREE_REPORT_LIMIT ever be switched on again),
      // it simply no longer gates anything.
      const quota = await prisma.deviceQuota.findUnique({ where: { deviceId: did } });
      expect(quota!.freeReportsUsed).toBe(5);
    } else {
      // Without R2 the create path cannot finish, so park the device far past
      // the retired cap and assert on the status code instead. 503 is the
      // correct R2-less answer — consumeQuota() succeeds, create() then rolls
      // the quota back and throws SERVICE_UNAVAILABLE. What matters is that the
      // old paywall no longer fires.
      await prisma.deviceQuota.upsert({
        where: { deviceId: did },
        update: { freeReportsUsed: 9, freeReportsLimit: 3, isPro: false },
        create: { deviceId: did, freeReportsUsed: 9, freeReportsLimit: 3 },
      });
      const res = await request(app.getHttpServer())
        .post('/reports')
        .set('x-device-id', did)
        .send({ code: uniqueCode() });
      expect(res.status).toBe(503);
      expect(res.status).not.toBe(402);
    }
  });

  it('the Nth report never 402s', async () => {
    const did = uniqueDeviceId();
    let previousUsed = 0;

    for (let i = 0; i < 30; i++) {
      const res = await request(app.getHttpServer())
        .post('/reports')
        .set('x-device-id', did)
        .send({ code: uniqueCode() });
      expect(res.status).not.toBe(402);
      expect(res.status).toBe(r2Configured ? 201 : 503);

      const quota = await prisma.deviceQuota.findUnique({ where: { deviceId: did } });
      const used = quota?.freeReportsUsed ?? 0;
      expect(used).toBeGreaterThanOrEqual(previousUsed);
      // With R2 the counter climbs one per report; without it every create is
      // rolled back, so it legitimately stays flat — never decreasing either way.
      if (r2Configured) expect(used).toBe(i + 1);
      previousUsed = used;
    }
  });

  it('PRO device still gets tier "pro" (R2 key layout unchanged)', async () => {
    const did = uniqueDeviceId();
    await request(app.getHttpServer())
      .post('/quota/upgrade')
      .set('x-device-id', did)
      .send({ platform: 'android', receipt: 'play-token' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/reports')
      .set('x-device-id', did)
      .send({ code: uniqueCode() });

    if (r2Configured) {
      expect(res.status).toBe(201);
      expect(res.body.tier).toBe('pro');
      expect(res.body.s3Key).toMatch(new RegExp(`^pro/${did}/`));
    } else {
      expect(res.status).toBe(503);
      const quota = await prisma.deviceQuota.findUnique({ where: { deviceId: did } });
      expect(quota!.isPro).toBe(true);
    }
  });

  it('ENFORCE_FREE_REPORT_LIMIT=true still produces the documented 402 shape', async () => {
    // The whole point of keeping the gate behind a flag: the shipped Flutter app
    // still ships its 402 handling, so the body must stay frozen even though the
    // flag is off everywhere. Build one isolated app with the flag on (the same
    // pattern test/quota.e2e-spec.ts uses for IAP_VALIDATION_MODE) and pin it.
    const previous = process.env.ENFORCE_FREE_REPORT_LIMIT;
    process.env.ENFORCE_FREE_REPORT_LIMIT = 'true';
    const isolated = await createTestApp();
    try {
      const did = uniqueDeviceId();
      await prisma.deviceQuota.upsert({
        where: { deviceId: did },
        update: { freeReportsUsed: 3, freeReportsLimit: 3, isPro: false },
        create: { deviceId: did, freeReportsUsed: 3, freeReportsLimit: 3 },
      });

      const res = await request(isolated.getHttpServer())
        .post('/reports')
        .set('x-device-id', did)
        .send({ code: uniqueCode() });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('PaymentRequired');
      expect(res.body.message).toMatch(/FREE-tier limit/);
      // NB: AllExceptionsFilter projects every 4xx onto
      // {statusCode, error, message, path, timestamp}, so the freeReportsUsed /
      // freeReportsLimit keys the service puts on the thrown payload never reach
      // the wire — the limit only survives inside `message`. That has always been
      // true; the mobile client parses the message-bearing shape asserted here.
      expect(res.body.statusCode).toBe(402);
      expect(res.body.message).toBe(
        'FREE-tier limit of 3 reports reached. Upgrade to PRO to continue.',
      );
      expect(res.body).not.toHaveProperty('freeReportsUsed');

      // Nothing was created and the counter was not touched by the refusal.
      const quota = await prisma.deviceQuota.findUnique({ where: { deviceId: did } });
      expect(quota!.freeReportsUsed).toBe(3);
      expect(await prisma.report.count({ where: { deviceId: did } })).toBe(0);

      // The flag is read once at boot: the ambient app (built with it off) is
      // unaffected while this test runs.
      const ambient = await request(app.getHttpServer())
        .post('/reports')
        .set('x-device-id', did)
        .send({ code: uniqueCode() });
      expect(ambient.status).not.toBe(402);
    } finally {
      await isolated.close();
      if (previous === undefined) delete process.env.ENFORCE_FREE_REPORT_LIMIT;
      else process.env.ENFORCE_FREE_REPORT_LIMIT = previous;
    }
  });

  it('lists reports for the requesting device only', async () => {
    const did = uniqueDeviceId();
    const otherDid = uniqueDeviceId('other');

    await prisma.report.create({
      data: { deviceId: did, code: 'CSP-1', s3Key: 'free/x/1.pdf', tier: 'free' },
    });
    await prisma.report.create({
      data: { deviceId: otherDid, code: 'CSP-1', s3Key: 'free/y/1.pdf', tier: 'free' },
    });

    const res = await request(app.getHttpServer())
      .get('/reports')
      .set('x-device-id', did)
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].code).toBe('CSP-1');
  });

  it('persists and returns make/model/inspectedAt display metadata', async () => {
    const did = uniqueDeviceId();
    const inspectedAt = '2026-06-01T09:30:00.000Z';
    await prisma.report.create({
      data: {
        deviceId: did,
        code: 'CSP-7',
        s3Key: 'free/x/7.pdf',
        tier: 'free',
        make: 'BMW',
        model: '320d',
        inspectedAt: new Date(inspectedAt),
      },
    });
    const res = await request(app.getHttpServer())
      .get('/reports')
      .set('x-device-id', did)
      .expect(200);
    expect(res.body.items[0].make).toBe('BMW');
    expect(res.body.items[0].model).toBe('320d');
    expect(res.body.items[0].inspectedAt).toBe(inspectedAt);
  });

  it('accepts make/model/inspectedAt on POST /reports when R2 is configured', async () => {
    if (!r2Configured) return; // quota gate + R2 covered elsewhere; skip create path without R2
    const did = uniqueDeviceId();
    const res = await request(app.getHttpServer())
      .post('/reports')
      .set('x-device-id', did)
      .send({ code: 'CSP-1', make: 'Audi', model: 'A4', inspectedAt: '2026-06-02T08:00:00.000Z' })
      .expect(201);
    expect(res.body.reportId).toBeTruthy();
  });

  it("forbids deleting another device's report", async () => {
    const did = uniqueDeviceId();
    const otherDid = uniqueDeviceId('other');
    const rep = await prisma.report.create({
      data: { deviceId: otherDid, code: 'CSP-1', s3Key: 'free/other/1.pdf', tier: 'free' },
    });
    await request(app.getHttpServer())
      .delete(`/reports/${rep.id}`)
      .set('x-device-id', did)
      .expect(403);
  });
});
