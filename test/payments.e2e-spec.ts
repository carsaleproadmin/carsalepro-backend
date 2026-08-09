import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueDeviceId } from './helpers/test-app';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';

const r2Configured = Boolean(
  process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
);

let codeCounter = 0;
function uniqueCode(): string {
  // CSP-#### sequence (validated by the ppv DTO). Keep within 6 digits.
  codeCounter = (codeCounter + 1) % 1_000_000;
  return `CSP-${Date.now().toString().slice(-3)}${codeCounter}`.slice(0, 10);
}

function uniqueEmail(): string {
  return `ppv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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

describe('Payments — Reports Store / pay-per-view (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Seed a report owned by a device (no userId) so it can be purchased. */
  async function seedReport(opts: { code: string; deviceId?: string; userId?: string }) {
    const deviceId = opts.deviceId ?? uniqueDeviceId();
    return prisma.report.create({
      data: {
        deviceId,
        code: opts.code,
        s3Key: `free/${deviceId}/${opts.code}.pdf`,
        tier: 'free',
        uploaded: true,
        userId: opts.userId ?? null,
        make: 'BMW',
        model: '320d',
        year: 2018,
        mileageKm: 120000,
        color: 'Black',
        bodyType: 'sedan',
        driveType: 'rwd',
        qualityScore: 87,
        reportData: { checklist: { brakes: 'ok' }, damages: [] },
        photosManifest: [{ s3Key: `report-photos/x/front.jpg`, kind: 'exterior', angle: 'front' }],
      },
    });
  }

  it('1. POST /api/v1/payments/ppv (mock mode) returns checkoutUrl and records the purchase', async () => {
    const { token, userId } = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code });

    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/ppv')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportCode: code })
      .expect(201);

    expect(typeof res.body.checkoutUrl).toBe('string');
    expect(res.body.mock).toBe(true);

    const purchase = await prisma.reportPurchase.findUnique({
      where: { userId_reportId: { userId, reportId: report.id } },
    });
    expect(purchase).toBeTruthy();

    const payment = await prisma.payment.findUnique({ where: { id: purchase!.paymentId } });
    expect(payment!.status).toBe('succeeded');
    expect(payment!.purpose).toBe('ppv');
  });

  it('2. second ppv for the same report returns alreadyOwned and creates no duplicate', async () => {
    const { token, userId } = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code });

    await request(app.getHttpServer())
      .post('/api/v1/payments/ppv')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportCode: code })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/ppv')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportCode: code })
      .expect(201);
    expect(res.body.alreadyOwned).toBe(true);
    expect(res.body.checkoutUrl).toBeUndefined();

    const count = await prisma.reportPurchase.count({
      where: { userId, reportId: report.id },
    });
    expect(count).toBe(1);
  });

  it('3. ppv for an unknown code returns 404 not_found', async () => {
    const { token } = await registerUser(app);
    const res = await request(app.getHttpServer())
      .post('/api/v1/payments/ppv')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportCode: 'CSP-999999' })
      .expect(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('4. ppv without a token returns 401', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/payments/ppv')
      .send({ reportCode: uniqueCode() })
      .expect(401);
  });

  it('5. GET /api/v1/reports/:id/full as the purchaser returns 200 with reportData + vehicle', async () => {
    const { token } = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code });

    await request(app.getHttpServer())
      .post('/api/v1/payments/ppv')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportCode: code })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/reports/${report.id}/full`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.id).toBe(report.id);
    expect(res.body.code).toBe(code);
    expect(res.body.vehicle.make).toBe('BMW');
    expect(res.body.vehicle.model).toBe('320d');
    expect(res.body.vehicle.year).toBe(2018);
    expect(res.body.reportData).toMatchObject({ checklist: { brakes: 'ok' } });
    expect(Array.isArray(res.body.photos)).toBe(true);
    expect(res.body.pdf).toBeDefined();
  });

  it('6. GET /full as a different user without purchase/ownership returns 403 payment_required', async () => {
    await registerUser(app); // unrelated
    const code = uniqueCode();
    const report = await seedReport({ code });
    const stranger = await registerUser(app);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/reports/${report.id}/full`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(403);
    expect(res.body.error.code).toBe('payment_required');
  });

  it('7. GET /full as the owner (report.userId === user) returns 200 without purchase', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/reports/${report.id}/full`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(res.body.id).toBe(report.id);

    // No purchase row was needed for ownership access.
    const count = await prisma.reportPurchase.count({ where: { reportId: report.id } });
    expect(count).toBe(0);
  });

  it('7b. GET /full as owner via DeviceLink returns 200', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const deviceId = uniqueDeviceId();
    const report = await seedReport({ code, deviceId });
    await prisma.deviceLink.create({
      data: { userId: owner.userId, deviceId, linkedVia: 'code' },
    });

    await request(app.getHttpServer())
      .get(`/api/v1/reports/${report.id}/full`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
  });

  it('8. GET /api/v1/reports/:id/download as purchaser returns 200 {signedUrl} (or 503 if R2 off)', async () => {
    const { token } = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code });

    await request(app.getHttpServer())
      .post('/api/v1/payments/ppv')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportCode: code })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/reports/${report.id}/download`)
      .set('Authorization', `Bearer ${token}`);

    if (r2Configured) {
      expect(res.status).toBe(200);
      expect(typeof res.body.signedUrl).toBe('string');
      expect(typeof res.body.expiresAt).toBe('string');
    } else {
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('storage_unavailable');
    }
  });

  it('8b. GET /download without purchase returns 403 payment_required', async () => {
    const code = uniqueCode();
    const report = await seedReport({ code });
    const stranger = await registerUser(app);
    const res = await request(app.getHttpServer())
      .get(`/api/v1/reports/${report.id}/download`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(403);
    expect(res.body.error.code).toBe('payment_required');
  });

  it('9. GET /api/v1/me/report-purchases lists the purchase', async () => {
    const { token } = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code });

    await request(app.getHttpServer())
      .post('/api/v1/payments/ppv')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportCode: code })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/v1/me/report-purchases')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(res.body.items)).toBe(true);
    const item = res.body.items.find((i: { reportId: string }) => i.reportId === report.id);
    expect(item).toBeTruthy();
    expect(item.code).toBe(code);
    expect(item.vehicle.make).toBe('BMW');
    expect(typeof item.purchasedAt).toBe('string');
  });

  it('9b. GET /api/v1/me/report-purchases without a token returns 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/me/report-purchases').expect(401);
  });

  it('9c. a refunded purchase loses access, and the same buyer can purchase again', async () => {
    const { token, userId } = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code });

    await request(app.getHttpServer())
      .post('/api/v1/payments/ppv')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportCode: code })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/api/v1/reports/${report.id}/full`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const purchase = await prisma.reportPurchase.findUniqueOrThrow({
      where: { userId_reportId: { userId, reportId: report.id } },
    });
    await payments.markPaymentRefunded(purchase.paymentId);

    // Money back, access gone — the two are one operation.
    await request(app.getHttpServer())
      .get(`/api/v1/reports/${report.id}/full`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    const listed = await request(app.getHttpServer())
      .get('/api/v1/me/report-purchases')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      listed.body.items.find((i: { reportId: string }) => i.reportId === report.id),
    ).toBeUndefined();

    // And the buyer is not locked out for ever: `@@unique([userId, reportId])`
    // means the revoked row IS the buyer's history with this report, so a new
    // purchase has to revive it rather than insert beside it.
    const again = await request(app.getHttpServer())
      .post('/api/v1/payments/ppv')
      .set('Authorization', `Bearer ${token}`)
      .send({ reportCode: code })
      .expect(201);
    expect(again.body.alreadyOwned).toBeUndefined();

    await request(app.getHttpServer())
      .get(`/api/v1/reports/${report.id}/full`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const revived = await prisma.reportPurchase.findUniqueOrThrow({
      where: { userId_reportId: { userId, reportId: report.id } },
    });
    expect(revived.revokedAt).toBeNull();
    expect(revived.paymentId).not.toBe(purchase.paymentId);
    expect(await prisma.reportPurchase.count({ where: { userId, reportId: report.id } })).toBe(1);
  });

  it('10. POST /webhooks/stripe with Stripe unconfigured returns 200 {skipped:true}', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=deadbeef')
      .send({ id: 'evt_test', type: 'checkout.session.completed' })
      .expect(200);
    expect(res.body.skipped).toBe(true);
  });
});
