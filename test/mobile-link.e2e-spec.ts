import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueDeviceId } from './helpers/test-app';
import { PrismaService } from '../src/prisma/prisma.service';

const r2Configured = Boolean(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
);

function uniqueEmail(): string {
  return `mlink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function registerUser(
  app: INestApplication,
): Promise<{ token: string; userId: string; email: string }> {
  const email = uniqueEmail();
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password: 'Sup3rSecret!', gdprConsent: true })
    .expect(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

describe('Mobile link + report archive (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. POST /reports returns the exact legacy shape with no new fields sent', async () => {
    if (!r2Configured) return;
    const did = uniqueDeviceId();
    const res = await request(app.getHttpServer())
      .post('/reports')
      .set('x-device-id', did)
      .send({ code: 'CSP-1' })
      .expect(201);
    expect(Object.keys(res.body).sort()).toEqual(
      ['expiresAt', 'presignedUploadUrl', 'reportId', 's3Key', 'tier'].sort(),
    );
    expect(res.body.tier).toBe('free');
    expect(typeof res.body.reportId).toBe('string');
    expect(typeof res.body.presignedUploadUrl).toBe('string');
    expect(res.body.s3Key).toMatch(new RegExp(`^free/${did}/`));
  });

  it('2. POST /reports with new website fields persists them', async () => {
    if (!r2Configured) return;
    const did = uniqueDeviceId();
    const reportData = { checklist: { brakes: 'ok' }, notes: 'clean' };
    const photosManifest = [{ kind: 'front', key: 'p1' }, { kind: 'back', key: 'p2' }];
    const res = await request(app.getHttpServer())
      .post('/reports')
      .set('x-device-id', did)
      .send({
        code: 'CSP-2',
        make: 'BMW',
        model: '320d',
        year: 2018,
        mileageKm: 120000,
        qualityScore: 87,
        color: 'Black',
        bodyType: 'sedan',
        driveType: 'rwd',
        reportData,
        photosManifest,
      })
      .expect(201);

    const saved = await prisma.report.findUnique({ where: { id: res.body.reportId } });
    expect(saved).toBeTruthy();
    expect(saved!.make).toBe('BMW');
    expect(saved!.model).toBe('320d');
    expect(saved!.year).toBe(2018);
    expect(saved!.mileageKm).toBe(120000);
    expect(saved!.qualityScore).toBe(87);
    expect(saved!.color).toBe('Black');
    expect(saved!.bodyType).toBe('sedan');
    expect(saved!.driveType).toBe('rwd');
    expect(saved!.reportData).toEqual(reportData);
    expect(saved!.photosManifest).toEqual(photosManifest);
  });

  it('3. 4th POST /reports from a FREE device returns 402 (quota contract intact)', async () => {
    const did = uniqueDeviceId();
    // Park the device at the FREE limit without depending on R2.
    await prisma.deviceQuota.upsert({
      where: { deviceId: did },
      update: { freeReportsUsed: 3, freeReportsLimit: 3, isPro: false },
      create: { deviceId: did, freeReportsUsed: 3, freeReportsLimit: 3 },
    });
    const res = await request(app.getHttpServer())
      .post('/reports')
      .set('x-device-id', did)
      .send({ code: 'CSP-4' });
    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/FREE-tier limit/);
  });

  it('4. POST /link-codes returns a 6-digit code + expiresAt', async () => {
    const did = uniqueDeviceId();
    const res = await request(app.getHttpServer())
      .post('/link-codes')
      .set('x-device-id', did)
      .expect(201);
    expect(res.body.code).toMatch(/^\d{6}$/);
    expect(typeof res.body.expiresAt).toBe('string');
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('5. linking a valid code attaches the device and backfills report.userId', async () => {
    const { token, userId } = await registerUser(app);
    const did = uniqueDeviceId();

    // Pre-existing report on the device (no userId yet).
    const report = await prisma.report.create({
      data: { deviceId: did, code: 'CSP-9', s3Key: `free/${did}/9.pdf`, tier: 'free' },
    });
    expect(report.userId).toBeNull();

    const codeRes = await request(app.getHttpServer())
      .post('/link-codes')
      .set('x-device-id', did)
      .expect(201);

    const linkRes = await request(app.getHttpServer())
      .post('/api/v1/users/me/device-links')
      .set('Authorization', `Bearer ${token}`)
      .send({ linkCode: codeRes.body.code })
      .expect(201);
    expect(linkRes.body.deviceId).toBe(did);
    expect(linkRes.body.linkedVia).toBe('code');
    expect(linkRes.body.userId).toBe(userId);

    const backfilled = await prisma.report.findUnique({ where: { id: report.id } });
    expect(backfilled!.userId).toBe(userId);
  });

  it('6. linking an invalid/expired code returns 400 invalid_code', async () => {
    const { token } = await registerUser(app);
    const res = await request(app.getHttpServer())
      .post('/api/v1/users/me/device-links')
      .set('Authorization', `Bearer ${token}`)
      .send({ linkCode: '000000' })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_code');
  });

  it('7. GET /api/v1/me/reports returns linked device reports; 401 without token', async () => {
    const { token } = await registerUser(app);
    const did = uniqueDeviceId();
    await prisma.report.create({
      data: { deviceId: did, code: 'CSP-10', s3Key: `free/${did}/10.pdf`, tier: 'free' },
    });
    const codeRes = await request(app.getHttpServer())
      .post('/link-codes')
      .set('x-device-id', did)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/users/me/device-links')
      .set('Authorization', `Bearer ${token}`)
      .send({ linkCode: codeRes.body.code })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/v1/me/reports')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items.some((r: { code: string }) => r.code === 'CSP-10')).toBe(true);

    await request(app.getHttpServer()).get('/api/v1/me/reports').expect(401);
  });

  it('8. POST /reports/:id/photos returns a presigned URL + report-photos/ key', async () => {
    const did = uniqueDeviceId();
    const report = await prisma.report.create({
      data: { deviceId: did, code: 'CSP-11', s3Key: `free/${did}/11.pdf`, tier: 'free' },
    });
    const res = await request(app.getHttpServer())
      .post(`/reports/${report.id}/photos`)
      .set('x-device-id', did)
      .send({ kind: 'front' });

    if (r2Configured) {
      expect(res.status).toBe(200);
      expect(res.body.s3Key).toMatch(new RegExp(`^report-photos/${report.id}/front-`));
      expect(typeof res.body.presignedUploadUrl).toBe('string');
      expect(typeof res.body.expiresAt).toBe('string');
    } else {
      expect(res.status).toBe(503);
    }
  });

  it('9. GET /api/v1/users/me/device-links lists the link', async () => {
    const { token } = await registerUser(app);
    const did = uniqueDeviceId();
    const codeRes = await request(app.getHttpServer())
      .post('/link-codes')
      .set('x-device-id', did)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/users/me/device-links')
      .set('Authorization', `Bearer ${token}`)
      .send({ linkCode: codeRes.body.code })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/v1/users/me/device-links')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((l: { deviceId: string }) => l.deviceId === did)).toBe(true);
  });

  it('10. admin device-link endpoint requires ADMIN (normal user -> 403)', async () => {
    const { token, userId } = await registerUser(app);
    const did = uniqueDeviceId();
    const res = await request(app.getHttpServer())
      .post(`/api/v1/admin/users/${userId}/device-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceId: did })
      .expect(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('11. linking a device already attached to another user returns 409', async () => {
    const userA = await registerUser(app);
    const userB = await registerUser(app);
    const did = uniqueDeviceId();

    const code1 = await request(app.getHttpServer())
      .post('/link-codes')
      .set('x-device-id', did)
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/users/me/device-links')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ linkCode: code1.body.code })
      .expect(201);

    const code2 = await request(app.getHttpServer())
      .post('/link-codes')
      .set('x-device-id', did)
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/api/v1/users/me/device-links')
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ linkCode: code2.body.code })
      .expect(409);
    expect(res.body.error.code).toBe('device_already_linked');
  });
});
