import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { cleanDb, createTestApp, uniqueDeviceId } from './helpers/test-app';
import { PrismaService } from '../src/prisma/prisma.service';

const r2Configured = Boolean(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
);

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

  it('402 after 3 FREE reports, then PRO unblocks (quota logic, R2-independent)', async () => {
    const did = uniqueDeviceId();

    if (r2Configured) {
      for (let i = 0; i < 3; i++) {
        const res = await request(app.getHttpServer())
          .post('/reports')
          .set('x-device-id', did)
          .send({ code: `CSP-${i + 1}`, vin: '1HGBH41JXMN109186' })
          .expect(201);
        expect(res.body.tier).toBe('free');
      }
      // 4th must fail with 402
      const fourth = await request(app.getHttpServer())
        .post('/reports')
        .set('x-device-id', did)
        .send({ code: 'CSP-4' });
      expect(fourth.status).toBe(402);
      expect(fourth.body.message).toMatch(/FREE-tier limit/);

      // Upgrade and retry
      await request(app.getHttpServer())
        .post('/quota/upgrade')
        .set('x-device-id', did)
        .send({ platform: 'android', receipt: 'play-token' })
        .expect(200);
      const fifth = await request(app.getHttpServer())
        .post('/reports')
        .set('x-device-id', did)
        .send({ code: 'CSP-5' })
        .expect(201);
      expect(fifth.body.tier).toBe('pro');
    } else {
      // Without R2, exercise the quota gate directly via DB
      await prisma.deviceQuota.upsert({
        where: { deviceId: did },
        update: { freeReportsUsed: 3 },
        create: { deviceId: did, freeReportsUsed: 3 },
      });
      const fourth = await request(app.getHttpServer())
        .post('/reports')
        .set('x-device-id', did)
        .send({ code: 'CSP-4' });
      expect(fourth.status).toBe(402);
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

  it('forbids deleting another device\'s report', async () => {
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

