import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { OrdersService } from '../src/orders/orders.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, uniqueDeviceId } from './helpers/test-app';
import { PinnedTariff, pinTariff } from './helpers/tariff';

/**
 * BE-S7 — a report filed against an order must come from the inspector actually
 * assigned to it.
 *
 * Until now `submitReportForOrder` took only an orderId: any device that knew an
 * order id could advance that order to SUBMITTED, and the code said so in a
 * comment. The check is enforced in ReportsService, where the submitting device
 * is in scope.
 *
 * The last case in this file is the one that matters most: a report with NO
 * orderId must still work from an unlinked device, because that is every
 * submission the shipped Flutter app makes.
 */

const ORDER_LAT = 52.52;
const ORDER_LNG = 13.405;
const SCHEDULED_AT = '2026-07-01T09:00:00.000Z';
const PASSWORD = 'Sup3rSecret!';

function uniqueEmail(prefix = 'ora'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function uniqueCode(): string {
  return `CSP-${Math.floor(Math.random() * 900000 + 100000)}`;
}

interface Registered {
  token: string;
  userId: string;
  email: string;
}

describe('Order report submitter authorisation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let tariff: PinnedTariff;

  const createdOrderIds = new Set<string>();
  const createdUserIds = new Set<string>();
  const createdDeviceIds = new Set<string>();
  const inspectorTokens = new Map<string, string>();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    tariff = await pinTariff(app);
  });

  afterEach(async () => {
    const orderIds = [...createdOrderIds];
    if (orderIds.length) {
      await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderOffer.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.report.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (createdDeviceIds.size) {
      const deviceIds = [...createdDeviceIds];
      await prisma.report.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.deviceLink.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.deviceQuota.deleteMany({ where: { deviceId: { in: deviceIds } } });
    }
    const userIds = [...createdUserIds];
    if (userIds.length) {
      await prisma.orderOffer.deleteMany({ where: { inspectorId: { in: userIds } } });
      await prisma.inspectorProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.verificationToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.deviceLink.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.waitlistEntry.deleteMany({
        where: { email: { in: [...createdUserIds].map(() => '') } },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    createdOrderIds.clear();
    createdUserIds.clear();
    createdDeviceIds.clear();
    inspectorTokens.clear();
  });

  afterAll(async () => {
    await tariff.restore();
    await app.close();
  });

  // ---- seeding ----

  async function register(prefix: string): Promise<Registered> {
    const email = uniqueEmail(prefix);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, gdprConsent: true })
      .expect(201);
    const u = { token: res.body.token as string, userId: res.body.user.id as string, email };
    createdUserIds.add(u.userId);
    return u;
  }

  async function makeInspector(): Promise<Registered> {
    const u = await register('insp');
    await prisma.user.update({
      where: { id: u.userId },
      data: { kycVerified: true, name: 'Inspector' },
    });
    await prisma.inspectorProfile.create({
      data: {
        userId: u.userId,
        companyName: 'KFZ Test GmbH',
        baseAddress: 'Teststraße 1, Berlin',
        searchRadiusKm: 50,
        available: true,
        stripeOnboarded: true,
      },
    });
    await prisma.$executeRaw`
      UPDATE inspector_profile
      SET location = ST_SetSRID(ST_MakePoint(${ORDER_LNG}, ${ORDER_LAT}), 4326)::geography
      WHERE user_id = ${u.userId}
    `;
    inspectorTokens.set(u.userId, u.token);
    return u;
  }

  function device(prefix: string): string {
    const id = uniqueDeviceId(prefix);
    createdDeviceIds.add(id);
    return id;
  }

  /** Drive an order to IN_PROGRESS and return it with its assigned inspector. */
  async function orderInProgress(): Promise<{ orderId: string; inspectorId: string }> {
    const customer = await register('cust');
    await makeInspector();

    const created = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        vin: '1HGBH41JXMN109186',
        make: 'BMW',
        model: '320d',
        address: 'Musterstraße 1, Berlin',
        lat: ORDER_LAT,
        lng: ORDER_LNG,
        scheduledAt: SCHEDULED_AT,
      })
      .expect(201);
    const orderId = created.body.orderId as string;
    createdOrderIds.add(orderId);

    const offer = await prisma.orderOffer.findFirst({ where: { orderId, status: 'PENDING' } });
    const inspectorId = offer!.inspectorId;
    const token = inspectorTokens.get(inspectorId)!;

    await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer!.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    for (const status of ['EN_ROUTE', 'IN_PROGRESS']) {
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status })
        .expect(200);
    }
    return { orderId, inspectorId };
  }

  function fileReport(deviceId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/reports')
      .set('X-Device-Id', deviceId)
      .send({ code: uniqueCode(), make: 'BMW', model: '320d', ...body });
  }

  // ---- cases ----

  it('1. an unlinked device cannot file a report against an order', async () => {
    const { orderId } = await orderInProgress();
    const res = await fileReport(device('stranger'), { orderId }).expect(403);
    expect(res.body.error).toBe('device_not_linked');

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('IN_PROGRESS'); // not advanced
  });

  it('2. a rejected submission creates no report and consumes no quota', async () => {
    const { orderId } = await orderInProgress();
    const deviceId = device('stranger');

    await fileReport(deviceId, { orderId }).expect(403);

    expect(await prisma.report.count({ where: { deviceId } })).toBe(0);
    const quota = await prisma.deviceQuota.findUnique({ where: { deviceId } });
    // The check runs before consumeQuota, so the row is never even created.
    expect(quota?.freeReportsUsed ?? 0).toBe(0);
  });

  it('3. a device linked to a DIFFERENT account is refused', async () => {
    const { orderId } = await orderInProgress();
    const other = await register('other');
    const deviceId = device('other-dev');
    await prisma.deviceLink.create({
      data: { deviceId, userId: other.userId, linkedVia: 'e2e' },
    });

    const res = await fileReport(deviceId, { orderId }).expect(403);
    expect(res.body.error).toBe('not_order_inspector');
  });

  it('4. an order with no assigned inspector is refused', async () => {
    const customer = await register('cust');
    await makeInspector();
    const created = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        make: 'BMW',
        model: '320d',
        address: 'Musterstraße 1, Berlin',
        lat: ORDER_LAT,
        lng: ORDER_LNG,
        scheduledAt: SCHEDULED_AT,
      })
      .expect(201);
    const orderId = created.body.orderId as string;
    createdOrderIds.add(orderId);

    const deviceId = device('early');
    const res = await fileReport(deviceId, { orderId }).expect(403);
    expect(res.body.error).toBe('order_not_assigned');
  });

  it('5. an unknown orderId is a 404, not a 403', async () => {
    const res = await fileReport(device('ghost'), { orderId: 'no-such-order' }).expect(404);
    expect(res.body.error).toBe('order_not_found');
  });

  it('6. the assigned inspector\'s linked device succeeds and advances the order', async () => {
    const { orderId, inspectorId } = await orderInProgress();
    const deviceId = device('assigned');
    await prisma.deviceLink.create({
      data: { deviceId, userId: inspectorId, linkedVia: 'e2e' },
    });

    const r2Off = !(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY
    );
    // A complete report: the quality gate sits between the submitter check and
    // the R2 gate, so an unscored report would 409 before either.
    const res = await fileReport(deviceId, { orderId, qualityScore: 95 });

    if (r2Off) {
      // No storage → 503 from the R2 gate, which sits AFTER the submitter check.
      // Reaching it at all proves authorisation passed.
      expect(res.status).toBe(503);
      return;
    }

    expect(res.status).toBe(201);
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('SUBMITTED');
    expect(order!.submittedAt).toBeTruthy();
  });

  it('7. REGRESSION: a report with no orderId still works from an unlinked device', async () => {
    // This is every submission the shipped mobile app makes. If this ever fails,
    // the app is bricked.
    const deviceId = device('legacy');
    const r2Off = !(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY
    );

    const res = await fileReport(deviceId, {});
    expect(res.status).toBe(r2Off ? 503 : 201);
    expect(res.body.error).not.toBe('device_not_linked');
  });

  it('8. the service-level path is unchanged for admin and system callers', async () => {
    // submitReportForOrder still takes only an orderId — admin overrides and the
    // auto-approve cron have no device — so the check belongs at the HTTP edge.
    const { orderId } = await orderInProgress();
    await expect(orders.submitReportForOrder(orderId)).resolves.toBe(true);
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('SUBMITTED');
  });
});
