import { INestApplication } from '@nestjs/common';
import { KycStatus } from '@prisma/client';
import request from 'supertest';
import { KycService } from '../src/kyc/kyc.service';
import {
  PUSH_PROVIDER,
  PushProvider,
} from '../src/notifications/notification-providers';
import { NotificationsService } from '../src/notifications/notifications.service';
import { OrdersService } from '../src/orders/orders.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/test-app';

const PASSWORD = 'Sup3rSecret9';

// Berlin Mitte — the order/customer location used to seed an in-range inspector.
const ORDER_LAT = 52.52;
const ORDER_LNG = 13.405;
const SCHEDULED_AT = '2026-07-01T09:00:00.000Z';

function uniqueEmail(prefix = 'notif'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

interface Registered {
  token: string;
  userId: string;
  email: string;
}

async function registerUser(app: INestApplication, prefix = 'notif'): Promise<Registered> {
  const email = uniqueEmail(prefix);
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, gdprConsent: true })
    .expect(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let orders: OrdersService;
  let kyc: KycService;

  const createdUserIds = new Set<string>();
  const createdOrderIds = new Set<string>();
  const createdWaitlistEmails = new Set<string>();
  const inspectorTokens = new Map<string, string>();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    notifications = app.get(NotificationsService);
    orders = app.get(OrdersService);
    kyc = app.get(KycService);
  });

  afterEach(async () => {
    const userIds = [...createdUserIds];
    const orderIds = [...createdOrderIds];
    if (orderIds.length) {
      await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderOffer.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.payout.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.dispute.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (createdWaitlistEmails.size) {
      await prisma.waitlistEntry.deleteMany({
        where: { email: { in: [...createdWaitlistEmails] } },
      });
    }
    if (userIds.length) {
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      const apps = await prisma.kycApplication.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      });
      const appIds = apps.map((a) => a.id);
      if (appIds.length) {
        await prisma.kycDocument.deleteMany({ where: { applicationId: { in: appIds } } });
        await prisma.kycApplication.deleteMany({ where: { id: { in: appIds } } });
      }
      await prisma.payout.deleteMany({ where: { inspectorId: { in: userIds } } });
      await prisma.orderOffer.deleteMany({ where: { inspectorId: { in: userIds } } });
      await prisma.inspectorProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.verificationToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    createdUserIds.clear();
    createdOrderIds.clear();
    createdWaitlistEmails.clear();
    inspectorTokens.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---- seeding helpers ----

  async function makeUser(prefix = 'notif'): Promise<Registered> {
    const u = await registerUser(app, prefix);
    createdUserIds.add(u.userId);
    return u;
  }

  async function makeCustomer(): Promise<Registered> {
    const u = await makeUser('cust');
    createdWaitlistEmails.add(u.email);
    return u;
  }

  async function makeAdmin(): Promise<Registered> {
    const u = await makeUser('admin');
    await prisma.user.update({ where: { id: u.userId }, data: { role: 'ADMIN' } });
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: u.email, password: PASSWORD })
      .expect(200);
    return { token: res.body.token as string, userId: u.userId, email: u.email };
  }

  async function makeInspector(lat: number, lng: number): Promise<Registered> {
    const u = await makeUser('insp');
    await prisma.user.update({
      where: { id: u.userId },
      data: { kycVerified: true, name: 'Inspector', phone: '+49301234567' },
    });
    await prisma.inspectorProfile.create({
      data: {
        userId: u.userId,
        companyName: 'KFZ Test GmbH',
        baseAddress: 'Teststraße 1, Berlin',
        searchRadiusKm: 50,
        available: true,
        stripeOnboarded: true,
        stripeAccountId: `acct_test_${u.userId.slice(0, 8)}`,
      },
    });
    await prisma.$executeRaw`
      UPDATE inspector_profile
      SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      WHERE user_id = ${u.userId}
    `;
    inspectorTokens.set(u.userId, u.token);
    return u;
  }

  async function createPaidOrder(customer: Registered): Promise<string> {
    const res = await request(app.getHttpServer())
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
    createdOrderIds.add(res.body.orderId);
    return res.body.orderId as string;
  }

  async function acceptPendingOffer(orderId: string): Promise<string> {
    const offer = await prisma.orderOffer.findFirst({
      where: { orderId, status: 'PENDING' },
    });
    if (!offer) throw new Error(`No pending offer for order ${orderId}`);
    const token = inspectorTokens.get(offer.inspectorId);
    if (!token) throw new Error(`No token for inspector ${offer.inspectorId}`);
    await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return offer.inspectorId;
  }

  function rows(userId: string, type?: string) {
    return prisma.notification.findMany({
      where: { userId, ...(type ? { type } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ============================================================

  it('1. notify() creates the type\'s default channel rows, always incl. inapp', async () => {
    const user = await makeUser();
    // order.created defaults = inapp,email; user has default prefs (email on).
    await notifications.notify(user.userId, 'order.created', {
      orderNumber: 'ORD-1234',
      make: 'BMW',
      model: '320d',
      totalCents: 5000,
    });

    const created = await rows(user.userId, 'order.created');
    const channels = created.map((r) => r.channel).sort();
    expect(channels).toEqual(['email', 'inapp']);
    const inapp = created.find((r) => r.channel === 'inapp')!;
    expect(inapp.status).toBe('sent');
    // DevOutbox resolves success → email row marked sent inline in test.
    expect(created.find((r) => r.channel === 'email')!.status).toBe('sent');
  });

  it('2. always emits an inapp row even when the type has no external channels', async () => {
    const user = await makeUser();
    // order.in_progress defaults = inapp only.
    await notifications.notify(user.userId, 'order.in_progress', { orderNumber: 'ORD-1' });
    const r = await rows(user.userId, 'order.in_progress');
    expect(r.length).toBe(1);
    expect(r[0].channel).toBe('inapp');
  });

  it('3. disabling email in prefs suppresses the email row but keeps inapp', async () => {
    const user = await makeUser();
    await notifications.updatePreferences(user.userId, { email: false });

    await notifications.notify(user.userId, 'order.created', {
      orderNumber: 'ORD-9',
      make: 'Audi',
      model: 'A4',
      totalCents: 5000,
    });

    const created = await rows(user.userId, 'order.created');
    const channels = created.map((r) => r.channel);
    expect(channels).toEqual(['inapp']);
    expect(channels).not.toContain('email');
  });

  it('4. enabling push adds a push row for a push-default type', async () => {
    const user = await makeUser();
    await notifications.updatePreferences(user.userId, { push: true });
    // offer.received defaults = inapp,email,push.
    await notifications.notify(user.userId, 'offer.received', {
      orderNumber: 'ORD-7',
      make: 'VW',
      model: 'Golf',
      inspectorShareCents: 4000,
    });
    const r = await rows(user.userId, 'offer.received');
    const channels = r.map((x) => x.channel).sort();
    expect(channels).toEqual(['email', 'inapp', 'push']);
  });

  it('5. GET /notifications returns the user\'s inapp items + total + unread', async () => {
    const user = await makeUser();
    await notifications.notify(user.userId, 'order.created', {
      orderNumber: 'ORD-1',
      make: 'BMW',
      model: 'X',
      totalCents: 1000,
    });
    await notifications.notify(user.userId, 'order.in_progress', { orderNumber: 'ORD-1' });

    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.unread).toBe(2);
    expect(res.body.items.length).toBe(2);
    // newest first
    expect(res.body.items[0].type).toBe('order.in_progress');
    for (const it of res.body.items) {
      expect(it.channel).toBe('inapp');
      expect(typeof it.title).toBe('string');
      expect(typeof it.body).toBe('string');
    }
  });

  it('6. GET /notifications is paginated', async () => {
    const user = await makeUser();
    for (let i = 0; i < 3; i++) {
      await notifications.notify(user.userId, 'order.in_progress', { orderNumber: `ORD-${i}` });
    }
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications?page=1&pageSize=2')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items.length).toBe(2);
  });

  it('7. GET /unread-count reflects unread inapp notifications', async () => {
    const user = await makeUser();
    await notifications.notify(user.userId, 'order.in_progress', { orderNumber: 'ORD-1' });
    await notifications.notify(user.userId, 'order.in_progress', { orderNumber: 'ORD-2' });
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(res.body.unread).toBe(2);
  });

  it('8. POST /:id/read sets readAt and decrements unread', async () => {
    const user = await makeUser();
    await notifications.notify(user.userId, 'order.in_progress', { orderNumber: 'ORD-1' });
    await notifications.notify(user.userId, 'order.in_progress', { orderNumber: 'ORD-2' });
    const inapp = await prisma.notification.findFirst({
      where: { userId: user.userId, channel: 'inapp' },
    });

    await request(app.getHttpServer())
      .post(`/api/v1/notifications/${inapp!.id}/read`)
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);

    const updated = await prisma.notification.findUnique({ where: { id: inapp!.id } });
    expect(updated!.readAt).toBeTruthy();
    expect(await notifications.unreadCount(user.userId)).toBe(1);
  });

  it('9. POST /read-all marks every inapp notification read', async () => {
    const user = await makeUser();
    await notifications.notify(user.userId, 'order.in_progress', { orderNumber: 'ORD-1' });
    await notifications.notify(user.userId, 'order.in_progress', { orderNumber: 'ORD-2' });

    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(res.body.updated).toBeGreaterThanOrEqual(2);
    expect(await notifications.unreadCount(user.userId)).toBe(0);
  });

  it('10. GET/PATCH /preferences round-trips', async () => {
    const user = await makeUser();
    const before = await request(app.getHttpServer())
      .get('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(before.body).toEqual({ inapp: true, email: true, sms: false, push: false });

    const patched = await request(app.getHttpServer())
      .patch('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ email: false, sms: true })
      .expect(200);
    expect(patched.body).toEqual({ inapp: true, email: false, sms: true, push: false });

    const after = await request(app.getHttpServer())
      .get('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect(after.body.email).toBe(false);
    expect(after.body.sms).toBe(true);
  });

  it('11. IDOR: cannot read another user\'s notification (404)', async () => {
    const owner = await makeUser('owner');
    const stranger = await makeUser('stranger');
    await notifications.notify(owner.userId, 'order.in_progress', { orderNumber: 'ORD-1' });
    const inapp = await prisma.notification.findFirst({
      where: { userId: owner.userId, channel: 'inapp' },
    });

    await request(app.getHttpServer())
      .post(`/api/v1/notifications/${inapp!.id}/read`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);

    // The owner's notification is still unread.
    const still = await prisma.notification.findUnique({ where: { id: inapp!.id } });
    expect(still!.readAt).toBeNull();
  });

  it('12. read-all only affects the calling user', async () => {
    const a = await makeUser('a');
    const b = await makeUser('b');
    await notifications.notify(a.userId, 'order.in_progress', { orderNumber: 'A' });
    await notifications.notify(b.userId, 'order.in_progress', { orderNumber: 'B' });

    await request(app.getHttpServer())
      .post('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${a.token}`)
      .expect(200);

    expect(await notifications.unreadCount(a.userId)).toBe(0);
    expect(await notifications.unreadCount(b.userId)).toBe(1);
  });

  it('13. an order reaching ASSIGNED creates order.assigned inapp for the customer', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const orderId = await createPaidOrder(customer);
    const inspectorId = await acceptPendingOffer(orderId);

    // The transition succeeded → order is ASSIGNED (domain action not broken).
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('ASSIGNED');

    const customerAssigned = await prisma.notification.findFirst({
      where: { userId: customer.userId, type: 'order.assigned', channel: 'inapp' },
    });
    expect(customerAssigned).toBeTruthy();

    // The inspector got an offer.received notification when dispatched to them.
    const offerNotif = await prisma.notification.findFirst({
      where: { userId: inspectorId, type: 'offer.received', channel: 'inapp' },
    });
    expect(offerNotif).toBeTruthy();
  });

  it('14. KYC approve creates kyc.approved for the inspector', async () => {
    const user = await makeUser('kyc');
    const admin = await makeAdmin();
    createdUserIds.add(admin.userId);

    const application = await prisma.kycApplication.create({
      data: { userId: user.userId, status: KycStatus.IN_REVIEW },
    });

    await kyc.approve(application.id, admin.userId);

    const notif = await prisma.notification.findFirst({
      where: { userId: user.userId, type: 'kyc.approved', channel: 'inapp' },
    });
    expect(notif).toBeTruthy();
    // Domain action succeeded.
    const dbUser = await prisma.user.findUnique({ where: { id: user.userId } });
    expect(dbUser!.kycVerified).toBe(true);
  });

  it('15. KYC reject creates kyc.rejected carrying the reason', async () => {
    const user = await makeUser('kyc');
    const admin = await makeAdmin();
    createdUserIds.add(admin.userId);

    const application = await prisma.kycApplication.create({
      data: { userId: user.userId, status: KycStatus.IN_REVIEW },
    });
    const reason = 'Blurry document';
    await kyc.reject(application.id, admin.userId, reason);

    const notif = await prisma.notification.findFirst({
      where: { userId: user.userId, type: 'kyc.rejected', channel: 'inapp' },
    });
    expect(notif).toBeTruthy();
    expect(JSON.stringify(notif!.payload)).toContain(reason);
  });

  it('16. a payout release creates payout.sent for the inspector + completes the order', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const orderId = await createPaidOrder(customer);
    const inspectorId = await acceptPendingOffer(orderId);

    // Submit a report (advances to SUBMITTED) then customer approves → payout.
    await orders.submitReportForOrder(orderId);
    await orders.approve(orderId, customer.userId);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('COMPLETED');

    const payoutNotif = await prisma.notification.findFirst({
      where: { userId: inspectorId, type: 'payout.sent', channel: 'inapp' },
    });
    expect(payoutNotif).toBeTruthy();

    // Inspector also got order.approved (report approved) + order.completed.
    const approved = await prisma.notification.findFirst({
      where: { userId: inspectorId, type: 'order.approved', channel: 'inapp' },
    });
    expect(approved).toBeTruthy();
  });

  it('17. notify() never throws for an unknown user (non-fatal)', async () => {
    await expect(
      notifications.notify('does-not-exist', 'order.created', { orderNumber: 'X' }),
    ).resolves.toBeUndefined();
  });

  it('18. a registered FCM token becomes the push delivery address and the row reaches sent', async () => {
    const inspector = await makeUser('push');
    const token = `fcm-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    const registered = await request(app.getHttpServer())
      .post('/api/v1/inspector/push-token')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ token })
      .expect(200);
    expect(registered.body).toEqual({ ok: true });

    const profile = await prisma.inspectorProfile.findUnique({
      where: { userId: inspector.userId },
    });
    expect(profile!.fcmToken).toBe(token);

    await notifications.updatePreferences(inspector.userId, { push: true });

    // The point of the test: dispatch used to hand `push` a null address
    // unconditionally, so the provider could never have delivered anything.
    const push = app.get<PushProvider>(PUSH_PROVIDER);
    const spy = jest.spyOn(push, 'send');
    // Snapshot the calls BEFORE restoring — mockRestore() also clears them.
    let calls: unknown[][] = [];
    try {
      await notifications.notify(inspector.userId, 'offer.received', {
        orderNumber: 'ORD-PUSH',
        make: 'VW',
        model: 'Golf',
        inspectorShareCents: 4000,
      });
      calls = spy.mock.calls.map((c) => [...c]);
    } finally {
      spy.mockRestore();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({ address: token });

    const pushRows = await prisma.notification.findMany({
      where: { userId: inspector.userId, type: 'offer.received', channel: 'push' },
    });
    expect(pushRows.length).toBe(1);
    expect(pushRows[0].status).toBe('sent');
  });

  it('19. push-token registration requires auth and caps the token at 4096 chars', async () => {
    const inspector = await makeUser('push');

    await request(app.getHttpServer())
      .post('/api/v1/inspector/push-token')
      .send({ token: 'no-auth' })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/inspector/push-token')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ token: 'x'.repeat(4097) })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/inspector/push-token')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ token: '' })
      .expect(400);

    // A re-register replaces the token rather than accumulating profiles.
    for (const t of ['token-a', 'token-b']) {
      await request(app.getHttpServer())
        .post('/api/v1/inspector/push-token')
        .set('Authorization', `Bearer ${inspector.token}`)
        .send({ token: t })
        .expect(200);
    }
    const profile = await prisma.inspectorProfile.findUnique({
      where: { userId: inspector.userId },
    });
    expect(profile!.fcmToken).toBe('token-b');
  });
});
