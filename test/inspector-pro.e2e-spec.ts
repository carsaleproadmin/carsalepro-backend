import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Role } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/test-app';
import { PinnedTariff, pinTariff } from './helpers/tariff';

/*
 * DEN-376. Only an inspector with mobile PRO gets new work.
 *
 * PRO comes from a linked device with `DeviceQuota.isPro`, or from a manual
 * grant by an admin. Without it: no dispatch, no accept, no out-of-range list
 * and no counter-offer. An order that the inspector already holds is not
 * touched.
 */

const LAT = 52.52;
const LNG = 13.405;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe('Inspector PRO gate (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tariff: PinnedTariff;

  const userIds = new Set<string>();
  const orderIds = new Set<string>();
  const deviceIds = new Set<string>();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    tariff = await pinTariff(app);
  });

  afterEach(async () => {
    const ids = [...orderIds];
    if (ids.length) {
      await prisma.orderEvent.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.orderCounterOffer.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.orderOffer.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.order.deleteMany({ where: { id: { in: ids } } });
    }
    const devices = [...deviceIds];
    if (devices.length) {
      await prisma.deviceLink.deleteMany({ where: { deviceId: { in: devices } } });
      await prisma.deviceQuota.deleteMany({ where: { deviceId: { in: devices } } });
    }
    const users = [...userIds];
    if (users.length) {
      await prisma.adminAuditLog.deleteMany({ where: { adminId: { in: users } } });
      await prisma.orderOffer.deleteMany({ where: { inspectorId: { in: users } } });
      await prisma.notification.deleteMany({ where: { userId: { in: users } } });
      await prisma.inspectorProfile.deleteMany({ where: { userId: { in: users } } });
      await prisma.verificationToken.deleteMany({ where: { userId: { in: users } } });
      await prisma.payment.deleteMany({ where: { userId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    orderIds.clear();
    deviceIds.clear();
    userIds.clear();
  });

  afterAll(async () => {
    await tariff.restore();
    await app.close();
  });

  async function register(prefix: string): Promise<{ token: string; userId: string }> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(prefix), password: 'Sup3rSecret9', gdprConsent: true })
      .expect(201);
    userIds.add(res.body.user.id);
    return { token: res.body.token, userId: res.body.user.id };
  }

  async function makeInspector(opts: { pro: boolean; lat?: number; lng?: number }) {
    const u = await register('insp');
    await prisma.user.update({ where: { id: u.userId }, data: { kycVerified: true } });
    await prisma.inspectorProfile.create({
      data: {
        userId: u.userId,
        baseAddress: 'Teststraße 1, Berlin',
        searchRadiusKm: 300,
        available: true,
        stripeOnboarded: true,
        proGrantedAt: opts.pro ? new Date() : null,
      },
    });
    await prisma.$executeRaw`
      UPDATE inspector_profile
      SET location = ST_SetSRID(ST_MakePoint(${opts.lng ?? LNG}, ${opts.lat ?? LAT}), 4326)::geography
      WHERE user_id = ${u.userId}
    `;
    return u;
  }

  async function linkProDevice(userId: string, isPro: boolean) {
    const deviceId = `pro-test-${Math.random().toString(36).slice(2, 12)}`;
    deviceIds.add(deviceId);
    await prisma.deviceQuota.create({ data: { deviceId, isPro } });
    await prisma.deviceLink.create({ data: { userId, deviceId, linkedVia: 'code' } });
  }

  async function createOrder(customerToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({
        make: 'BMW',
        model: '320d',
        listingUrl: '+4930123456',
        address: 'Musterstraße 1, Berlin',
        lat: LAT,
        lng: LNG,
      })
      .expect(201);
    orderIds.add(res.body.orderId);
    return res.body.orderId;
  }

  async function profileOf(token: string) {
    const res = await request(app.getHttpServer())
      .get('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body;
  }

  it('1. dispatch skips the nearer inspector without PRO', async () => {
    const plain = await makeInspector({ pro: false });
    const pro = await makeInspector({ pro: true, lat: LAT + 0.05 });
    const customer = await register('cust');
    const orderId = await createOrder(customer.token);

    const offers = await prisma.orderOffer.findMany({ where: { orderId } });
    expect(offers.some((o) => o.inspectorId === plain.userId)).toBe(false);
    expect(offers.some((o) => o.inspectorId === pro.userId)).toBe(true);
  });

  it('2. an offer made before PRO was removed cannot be accepted', async () => {
    const insp = await makeInspector({ pro: true });
    const customer = await register('cust');
    const orderId = await createOrder(customer.token);
    const offer = await prisma.orderOffer.findFirstOrThrow({
      where: { orderId, inspectorId: insp.userId },
    });
    await prisma.inspectorProfile.update({
      where: { userId: insp.userId },
      data: { proGrantedAt: null },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer.id}/accept`)
      .set('Authorization', `Bearer ${insp.token}`)
      .expect(403);
    expect(res.body.error.code).toBe('inspector_pro_required');
  });

  it('3. the out-of-range list and a counter-offer need PRO', async () => {
    const insp = await makeInspector({ pro: false });
    await request(app.getHttpServer())
      .get('/api/v1/inspector/orders/out-of-range')
      .set('Authorization', `Bearer ${insp.token}`)
      .expect(403)
      .expect((r) => expect(r.body.error.code).toBe('inspector_pro_required'));

    await makeInspector({ pro: true, lat: LAT + 0.05 });
    const customer = await register('cust');
    const orderId = await createOrder(customer.token);
    // The trade opens only after a failed dispatch round.
    await prisma.orderOffer.deleteMany({ where: { orderId } });
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'UNASSIGNED',
        inspectorId: null,
        dispatchRound: 1,
        searchExpiresAt: new Date(Date.now() + 6 * 3600_000),
      },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/counter-offers`)
      .set('Authorization', `Bearer ${insp.token}`)
      .send({ payoutCents: 20_000, reason: 'The car is far from me.' })
      .expect(403)
      .expect((r) => expect(r.body.error.code).toBe('inspector_pro_required'));
  });

  it('4. a linked PRO device gives PRO, a linked FREE device does not', async () => {
    const insp = await makeInspector({ pro: false });
    expect((await profileOf(insp.token)).hasPro).toBe(false);

    await linkProDevice(insp.userId, false);
    expect((await profileOf(insp.token)).hasPro).toBe(false);

    await linkProDevice(insp.userId, true);
    const profile = await profileOf(insp.token);
    expect(profile.hasPro).toBe(true);
    expect(profile.eligibleForOffers).toBe(true);
  });

  it('5. an admin gives and removes PRO by hand, with an audit row', async () => {
    const admin = await register('admin');
    await prisma.user.update({ where: { id: admin.userId }, data: { role: Role.ADMIN } });
    const insp = await makeInspector({ pro: false });

    const granted = await request(app.getHttpServer())
      .put(`/api/v1/admin/users/${insp.userId}/inspector-pro`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(granted.body).toMatchObject({ hasPro: true, grantedByAdmin: true, fromDevice: false });
    expect((await profileOf(insp.token)).hasPro).toBe(true);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/users/${insp.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(detail.body.inspectorPro.hasPro).toBe(true);

    await request(app.getHttpServer())
      .delete(`/api/v1/admin/users/${insp.userId}/inspector-pro`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200)
      .expect((r) => expect(r.body.hasPro).toBe(false));

    const audit = await prisma.adminAuditLog.findMany({
      where: { adminId: admin.userId, entityId: insp.userId },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      'user.inspector_pro_grant',
      'user.inspector_pro_revoke',
    ]);
  });

  it('6. the admin route refuses a user with no inspector profile', async () => {
    const admin = await register('admin');
    await prisma.user.update({ where: { id: admin.userId }, data: { role: Role.ADMIN } });
    const plain = await register('plain');
    await request(app.getHttpServer())
      .put(`/api/v1/admin/users/${plain.userId}/inspector-pro`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(404);
  });
});
