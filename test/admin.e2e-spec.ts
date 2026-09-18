import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { OrdersService } from '../src/orders/orders.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings.service';
import { PLATFORM_SETTING_DEFAULTS } from '../src/settings/platform-settings.constants';
import { PinnedTariff, colocatedQuote, pinTariff } from './helpers/tariff';
import {
  CONTRACT_TEMPLATES,
  type ContractKey,
} from '../src/legal/legal-contracts.content';
import { createTestApp, uniqueDeviceId } from './helpers/test-app';

const ORDER_LAT = 52.52;
const ORDER_LNG = 13.405;
const SCHEDULED_AT = '2026-07-01T09:00:00.000Z';
const PASSWORD = 'Sup3rSecret9';
/** Admin cancel and dispute resolution require a reason (DEN-294). */
const REASON = 'Decision recorded by the e2e suite';

function uniqueEmail(prefix = 'adm'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

interface Registered {
  token: string;
  userId: string;
  email: string;
}

describe('Admin panel (E9) (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let settings: SettingsService;

  const createdOrderIds = new Set<string>();
  const createdUserIds = new Set<string>();
  const createdWaitlistEmails = new Set<string>();
  const createdLegalKeys = new Set<string>();
  const inspectorTokens = new Map<string, string>();

  // Inspector co-located with the order: fare is base + one minute, floored at
  // the minimum fare. Derived so a retuned default cannot silently break this.
  const FARE = colocatedQuote();
  let tariff: PinnedTariff;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    settings = app.get(SettingsService);
    tariff = await pinTariff(app);
  });

  afterEach(async () => {
    const orderIds = [...createdOrderIds];
    if (orderIds.length) {
      await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderOffer.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.payout.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.dispute.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.report.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (createdWaitlistEmails.size) {
      await prisma.waitlistEntry.deleteMany({
        where: { email: { in: [...createdWaitlistEmails] } },
      });
    }
    const userIds = [...createdUserIds];
    if (userIds.length) {
      await prisma.adminAuditLog.deleteMany({ where: { adminId: { in: userIds } } });
      await prisma.payout.deleteMany({ where: { inspectorId: { in: userIds } } });
      await prisma.orderOffer.deleteMany({ where: { inspectorId: { in: userIds } } });
      await prisma.inspectorProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.kycApplication.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.verificationToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.deviceLink.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.listing.deleteMany({ where: { sellerId: { in: userIds } } });
      await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (createdLegalKeys.size) {
      // Remove the rows this suite created, then restore the canonical seed
      // template so sibling suites and the dev DB keep an active version for the key.
      for (const key of createdLegalKeys) {
        await prisma.legalTemplate.deleteMany({ where: { key } });
        const tpl = CONTRACT_TEMPLATES[key as ContractKey];
        if (tpl) {
          await prisma.legalTemplate.create({
            data: {
              key,
              version: 1,
              locale: tpl.locale,
              title: tpl.title,
              bodyMd: tpl.bodyMd,
              active: true,
            },
          });
        }
      }
    }
    createdOrderIds.clear();
    createdUserIds.clear();
    createdWaitlistEmails.clear();
    createdLegalKeys.clear();
    inspectorTokens.clear();
  });

  afterAll(async () => {
    // Test 25 deliberately PATCHes orderBaseFeeEur and leaves it changed; without
    // this restore every suite that runs afterwards prices against it.
    await tariff.restore();
    await app.close();
  });

  // ---- helpers ----

  async function registerUser(prefix = 'usr'): Promise<Registered> {
    const email = uniqueEmail(prefix);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, gdprConsent: true })
      .expect(201);
    return { token: res.body.token as string, userId: res.body.user.id as string, email };
  }

  async function makeUser(prefix = 'usr'): Promise<Registered> {
    const u = await registerUser(prefix);
    createdUserIds.add(u.userId);
    createdWaitlistEmails.add(u.email);
    return u;
  }

  async function makeAdmin(): Promise<Registered> {
    const u = await registerUser('admin');
    createdUserIds.add(u.userId);
    createdWaitlistEmails.add(u.email);
    await prisma.user.update({ where: { id: u.userId }, data: { role: Role.ADMIN } });
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: u.email, password: PASSWORD })
      .expect(200);
    return { token: res.body.token as string, userId: u.userId, email: u.email };
  }

  async function makeInspector(
    lat: number,
    lng: number,
    opts: { name?: string; eligible?: boolean } = {},
  ): Promise<Registered> {
    const eligible = opts.eligible ?? true;
    const u = await registerUser('insp');
    createdUserIds.add(u.userId);
    await prisma.user.update({
      where: { id: u.userId },
      data: { kycVerified: eligible, name: opts.name ?? 'Inspector', phone: '+49301234567' },
    });
    await prisma.inspectorProfile.create({
      data: {
        userId: u.userId,
        companyName: 'KFZ Test GmbH',
        taxId: 'DE-TAX-123',
        vatId: 'DE999999999',
        baseAddress: 'Teststraße 1, Berlin',
        searchRadiusKm: 50,
        available: true,
        stripeOnboarded: true,
        stripeAccountId: `acct_seed_${u.userId}`,
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

  function trackOrder(orderId: string): void {
    createdOrderIds.add(orderId);
  }

  async function pendingOfferFor(orderId: string) {
    return prisma.orderOffer.findFirst({ where: { orderId, status: 'PENDING' } });
  }

  async function createPaidOrder(customer: Registered): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({
        vin: '1HGBH41JXMN109186',
        make: 'BMW',
        model: '320d',
        listingUrl: '+4930123456',
        address: 'Musterstraße 1, Berlin',
        lat: ORDER_LAT,
        lng: ORDER_LNG,
        scheduledAt: SCHEDULED_AT,
      })
      .expect(201);
    trackOrder(res.body.orderId);
    return res.body.orderId;
  }

  async function acceptPendingOffer(orderId: string): Promise<string> {
    const offer = await pendingOfferFor(orderId);
    if (!offer) throw new Error(`No pending offer for order ${orderId}`);
    const token = inspectorTokens.get(offer.inspectorId)!;
    await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return offer.inspectorId;
  }

  async function driveToSubmitted(customer: Registered): Promise<string> {
    const orderId = await createPaidOrder(customer);
    await acceptPendingOffer(orderId);
    await orders.submitReportForOrder(orderId);
    return orderId;
  }

  async function driveToDisputed(customer: Registered): Promise<string> {
    const orderId = await driveToSubmitted(customer);
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ reason: 'Report incomplete' })
      .expect(200);
    return orderId;
  }

  function bearer(req: request.Test, token: string) {
    return req.set('Authorization', `Bearer ${token}`);
  }

  // ============================================================
  // Role gating (applies to every admin area)
  // ============================================================
  describe('role gating', () => {
    it('1. dashboard without a token → 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/admin/dashboard').expect(401);
    });

    it('2. dashboard as a normal USER → 403', async () => {
      const user = await makeUser();
      const res = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/dashboard'),
        user.token,
      ).expect(403);
      expect(res.body.error.code).toBe('forbidden');
    });

    it('3. users list as ADMIN → 200', async () => {
      const admin = await makeAdmin();
      const res = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/users'),
        admin.token,
      ).expect(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(typeof res.body.total).toBe('number');
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(20);
    });

    it('4. settings list as USER → 403; orders list no token → 401', async () => {
      const user = await makeUser();
      await bearer(request(app.getHttpServer()).get('/api/v1/admin/settings'), user.token).expect(403);
      await request(app.getHttpServer()).get('/api/v1/admin/orders').expect(401);
    });
  });

  // ============================================================
  // Users area
  // ============================================================
  describe('users', () => {
    it('5. search by q, detail, 404 for unknown', async () => {
      const admin = await makeAdmin();
      const target = await makeUser('searchme');

      const list = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/users?q=${encodeURIComponent(target.email)}`),
        admin.token,
      ).expect(200);
      expect(list.body.items.some((u: { id: string }) => u.id === target.userId)).toBe(true);

      const detail = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/users/${target.userId}`),
        admin.token,
      ).expect(200);
      expect(detail.body.email).toBe(target.email);
      expect(Array.isArray(detail.body.deviceLinks)).toBe(true);
      expect(detail.body.counts).toBeDefined();

      await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/users/does-not-exist'),
        admin.token,
      ).expect(404);
    });

    it('6. ban/unban a user + banned user cannot log in (403)', async () => {
      const admin = await makeAdmin();
      const target = await makeUser('bantarget');

      await bearer(
        request(app.getHttpServer()).post(`/api/v1/admin/users/${target.userId}/ban`).send({ reason: 'fraud' }),
        admin.token,
      ).expect(200);

      const banned = await prisma.user.findUnique({ where: { id: target.userId } });
      expect(banned!.bannedAt).toBeTruthy();

      // H3: the target's existing (pre-ban) token must be rejected at request
      // time immediately — the ban takes effect without waiting for token expiry.
      const reused = await bearer(
        request(app.getHttpServer()).get('/api/v1/users/me'),
        target.token,
      ).expect(401);
      expect(reused.body.error.code).toBe('unauthorized');

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: target.email, password: PASSWORD })
        .expect(403);
      expect(loginRes.body.error.code).toBe('account_banned');

      await bearer(
        request(app.getHttpServer()).post(`/api/v1/admin/users/${target.userId}/unban`),
        admin.token,
      ).expect(200);
      const unbanned = await prisma.user.findUnique({ where: { id: target.userId } });
      expect(unbanned!.bannedAt).toBeNull();

      // After unban login works again.
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: target.email, password: PASSWORD })
        .expect(200);
    });

    it('7. admin cannot ban themselves (400)', async () => {
      const admin = await makeAdmin();
      const res = await bearer(
        request(app.getHttpServer()).post(`/api/v1/admin/users/${admin.userId}/ban`).send({}),
        admin.token,
      ).expect(400);
      expect(res.body.error.code).toBe('cannot_target_self');
    });

    // ---- DEN-299: the super admin manages the admins ----

    /** The guard reads the role from the database, so the token stays valid. */
    async function makeSuperAdmin(): Promise<Registered> {
      const a = await makeAdmin();
      await prisma.user.update({ where: { id: a.userId }, data: { role: Role.SUPER_ADMIN } });
      return a;
    }

    function setRole(actor: Registered, targetId: string, role: string) {
      return bearer(
        request(app.getHttpServer()).post(`/api/v1/admin/users/${targetId}/role`).send({ role }),
        actor.token,
      );
    }

    async function roleOf(id: string) {
      return (await prisma.user.findUnique({ where: { id } }))!.role;
    }

    it('8. an ADMIN promotes a user to ADMIN, but cannot demote an admin or themselves', async () => {
      const admin = await makeAdmin();
      const target = await makeUser('promoteme');

      await setRole(admin, target.userId, 'ADMIN').expect(200);
      expect(await roleOf(target.userId)).toBe('ADMIN');

      const demote = await setRole(admin, target.userId, 'USER').expect(403);
      expect(demote.body.error.code).toBe('super_admin_required');
      expect(await roleOf(target.userId)).toBe('ADMIN');

      const self = await setRole(admin, admin.userId, 'USER').expect(400);
      expect(self.body.error.code).toBe('cannot_demote_self');
    });

    it('9. an ADMIN cannot give or remove SUPER_ADMIN, or change a super admin', async () => {
      const admin = await makeAdmin();
      const superAdmin = await makeSuperAdmin();
      const user = await makeUser('suptarget');

      const attempts: [string, string][] = [
        [user.userId, 'SUPER_ADMIN'],
        [admin.userId, 'SUPER_ADMIN'], // not even for themselves
        [superAdmin.userId, 'ADMIN'],
        [superAdmin.userId, 'USER'],
      ];
      for (const [targetId, role] of attempts) {
        const res = await setRole(admin, targetId, role).expect(403);
        expect(res.body.error.code).toBe('super_admin_required');
      }
      expect(await roleOf(user.userId)).toBe('USER');
      expect(await roleOf(admin.userId)).toBe('ADMIN');
      expect(await roleOf(superAdmin.userId)).toBe('SUPER_ADMIN');
    });

    it('9b. an ADMIN cannot ban or unban an admin; a SUPER_ADMIN can', async () => {
      const admin = await makeAdmin();
      const other = await makeAdmin();
      const superAdmin = await makeSuperAdmin();

      for (const targetId of [other.userId, superAdmin.userId]) {
        const res = await bearer(
          request(app.getHttpServer()).post(`/api/v1/admin/users/${targetId}/ban`).send({}),
          admin.token,
        ).expect(403);
        expect(res.body.error.code).toBe('super_admin_required');
      }
      expect((await prisma.user.findUnique({ where: { id: other.userId } }))!.bannedAt).toBeNull();

      await bearer(
        request(app.getHttpServer()).post(`/api/v1/admin/users/${other.userId}/ban`).send({}),
        superAdmin.token,
      ).expect(200);

      const unban = await bearer(
        request(app.getHttpServer()).post(`/api/v1/admin/users/${other.userId}/unban`),
        admin.token,
      ).expect(403);
      expect(unban.body.error.code).toBe('super_admin_required');

      await bearer(
        request(app.getHttpServer()).post(`/api/v1/admin/users/${other.userId}/unban`),
        superAdmin.token,
      ).expect(200);
      expect((await prisma.user.findUnique({ where: { id: other.userId } }))!.bannedAt).toBeNull();
    });

    it('9c. a SUPER_ADMIN opens the admin panel, demotes an admin and manages SUPER_ADMIN', async () => {
      const superAdmin = await makeSuperAdmin();
      const admin = await makeAdmin();

      await bearer(request(app.getHttpServer()).get('/api/v1/admin/dashboard'), superAdmin.token).expect(200);

      await setRole(superAdmin, admin.userId, 'USER').expect(200);
      expect(await roleOf(admin.userId)).toBe('USER');
      await setRole(superAdmin, admin.userId, 'SUPER_ADMIN').expect(200);
      expect(await roleOf(admin.userId)).toBe('SUPER_ADMIN');
      await setRole(superAdmin, admin.userId, 'ADMIN').expect(200);
      expect(await roleOf(admin.userId)).toBe('ADMIN');

      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: 'user.role', entityId: admin.userId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit!.adminId).toBe(superAdmin.userId);
      expect(audit!.after).toMatchObject({ role: 'ADMIN' });

      // Nobody demotes themselves, a super admin included.
      const self = await setRole(superAdmin, superAdmin.userId, 'ADMIN').expect(400);
      expect(self.body.error.code).toBe('cannot_demote_self');
    });

    it('9d. only a SUPER_ADMIN erases an account; the reason is audited and orders stay (DEN-300)', async () => {
      const admin = await makeAdmin();
      const superAdmin = await makeSuperAdmin();
      const target = await makeUser('erasetarget');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await createPaidOrder(target);
      const erase = (actor: Registered, id: string, body: object = { reason: REASON }) =>
        bearer(
          request(app.getHttpServer()).post(`/api/v1/admin/users/${id}/erase`).send(body),
          actor.token,
        );

      const denied = await erase(admin, target.userId).expect(403);
      expect(denied.body.error.code).toBe('super_admin_required');
      await erase(superAdmin, target.userId, { reason: 'short' }).expect(400);
      await erase(superAdmin, target.userId, {}).expect(400);
      const self = await erase(superAdmin, superAdmin.userId).expect(400);
      expect(self.body.error.code).toBe('cannot_target_self');
      expect((await prisma.user.findUnique({ where: { id: target.userId } }))!.deletedAt).toBeNull();

      const res = await erase(superAdmin, target.userId).expect(200);
      expect(res.body.deletedAt).toBeTruthy();

      // The same result as the user's own erasure.
      const erased = await prisma.user.findUnique({ where: { id: target.userId } });
      expect(erased!.email).toBe(`deleted+${target.userId}@carsalepro.invalid`);
      expect(erased!.passwordHash).toBeNull();
      expect(erased!.name).toBeNull();
      expect(erased!.deletedAt).toBeTruthy();

      // The old token and the old password stop working.
      await bearer(request(app.getHttpServer()).get('/api/v1/users/me'), target.token).expect(401);
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: target.email, password: PASSWORD })
        .expect(401);

      // Orders and payments stay for accounting.
      expect(await prisma.order.findUnique({ where: { id: orderId } })).not.toBeNull();
      expect(await prisma.payment.count({ where: { orderId } })).toBeGreaterThan(0);

      const audit = await prisma.adminAuditLog.findFirst({
        where: { action: 'user.erase', entityId: target.userId },
      });
      expect(audit!.adminId).toBe(superAdmin.userId);
      expect(audit!.after).toMatchObject({ reason: REASON });
      expect(JSON.stringify(audit)).not.toContain(target.email);

      const again = await erase(superAdmin, target.userId).expect(409);
      expect(again.body.error.code).toBe('already_erased');

      // The erased account is still visible to an admin, marked as erased.
      const detail = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/users/${target.userId}`),
        admin.token,
      ).expect(200);
      expect(detail.body.deletedAt).toBeTruthy();
    });

    it('10. device-links: list, create (audited), unlink', async () => {
      const admin = await makeAdmin();
      const target = await makeUser('devlinks');
      const deviceId = uniqueDeviceId('admin-dev');

      await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/users/${target.userId}/device-links`)
          .send({ deviceId }),
        admin.token,
      ).expect(201);

      const links = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/users/${target.userId}/device-links`),
        admin.token,
      ).expect(200);
      expect(links.body.items.some((l: { deviceId: string }) => l.deviceId === deviceId)).toBe(true);

      const auditRow = await prisma.adminAuditLog.findFirst({
        where: { action: 'user.device_link', entityId: target.userId },
      });
      expect(auditRow).toBeTruthy();

      await bearer(
        request(app.getHttpServer()).delete(`/api/v1/admin/users/${target.userId}/device-links/${deviceId}`),
        admin.token,
      ).expect(200);
      const after = await prisma.deviceLink.findUnique({ where: { deviceId } });
      expect(after).toBeNull();
    });
  });

  // ============================================================
  // Orders area
  // ============================================================
  describe('orders', () => {
    it('11. list + detail (admin bypasses ownership) + 404', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await createPaidOrder(customer);

      const list = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/orders?status=PAID'),
        admin.token,
      ).expect(200);
      expect(list.body.items.some((o: { id: string }) => o.id === orderId)).toBe(true);

      const detail = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/orders/${orderId}`),
        admin.token,
      ).expect(200);
      expect(detail.body.id).toBe(orderId);
      expect(detail.body.payment).toBeTruthy();
      // Nobody has accepted yet, so the money is HELD, not taken. `succeeded`
      // here would mean the platform charged a card for work no one agreed to.
      expect(detail.body.payment.status).toBe('authorized');
      expect(Array.isArray(detail.body.refunds)).toBe(true);
      expect(Array.isArray(detail.body.events)).toBe(true);
    });

    it('11b. list takes the showroom car filters (DEN-316)', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await createPaidOrder(customer);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const ids = async (filter: string): Promise<string[]> => {
        const res = await bearer(
          request(app.getHttpServer()).get(
            `/api/v1/admin/orders?customerId=${customer.userId}&${filter}`,
          ),
          admin.token,
        ).expect(200);
        return res.body.items.map((o: { id: string }) => o.id);
      };

      // The order's own columns. The city is matched in the address, also by alias.
      expect(await ids('make=bmw&model=320')).toEqual([orderId]);
      expect(await ids('make=Audi')).toEqual([]);
      expect(await ids(`country=${order.countryCode.toLowerCase()}`)).toEqual([orderId]);
      expect(await ids('country=AT')).toEqual([]);
      expect(await ids(`city=${encodeURIComponent('Берлин')}`)).toEqual([orderId]);
      expect(await ids('city=Hamburg')).toEqual([]);
      expect(await ids(`priceFrom=${order.totalCents}&priceTo=${order.totalCents}`)).toEqual([
        orderId,
      ]);
      expect(await ids(`priceFrom=${order.totalCents + 1}`)).toEqual([]);
      expect(await ids('status=PAID&make=BMW')).toEqual([orderId]);

      // Year and mileage come from the report. No report, no match.
      expect(await ids('yearFrom=2000')).toEqual([]);
      await prisma.report.create({
        data: {
          deviceId: uniqueDeviceId('rep'),
          code: `CSP-${Math.random().toString(36).slice(2, 8)}`,
          tier: 'pro',
          s3Key: 'pro/x/y.pdf',
          userId: customer.userId,
          orderId,
          year: 2020,
          mileageKm: 90000,
        },
      });
      expect(await ids('yearFrom=2020&yearTo=2020')).toEqual([orderId]);
      expect(await ids('yearFrom=2021')).toEqual([]);
      expect(await ids('mileageTo=90000')).toEqual([orderId]);
      expect(await ids('mileageTo=89999')).toEqual([]);

      await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/orders?yearFrom=1800'),
        admin.token,
      ).expect(400);
    });

    it('11c. inspectors list feeds the inspector filter (DEN-316)', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      const inspector = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Filter Inspector' });
      const other = await makeInspector(ORDER_LAT + 0.05, ORDER_LNG);
      const orderId = await createPaidOrder(customer);
      await prisma.order.update({ where: { id: orderId }, data: { inspectorId: inspector.userId } });

      const list = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/orders/inspectors'),
        admin.token,
      ).expect(200);
      const row = list.body.items.find((i: { id: string }) => i.id === inspector.userId);
      expect(row).toEqual(
        expect.objectContaining({ id: inspector.userId, email: expect.any(String) }),
      );
      expect(list.body.items.some((i: { id: string }) => i.id === other.userId)).toBe(true);
      expect(list.body.items.some((i: { id: string }) => i.id === customer.userId)).toBe(false);

      const ids = async (inspectorId: string): Promise<string[]> => {
        const res = await bearer(
          request(app.getHttpServer()).get(
            `/api/v1/admin/orders?customerId=${customer.userId}&inspectorId=${inspectorId}`,
          ),
          admin.token,
        ).expect(200);
        return res.body.items.map((o: { id: string }) => o.id);
      };
      expect(await ids(inspector.userId)).toEqual([orderId]);
      expect(await ids(other.userId)).toEqual([]);

      await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/orders/inspectors'),
        customer.token,
      ).expect(403);
    });

    it('12. adminAssign moves UNASSIGNED → ASSIGNED with inspector set', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      const near = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Near' });
      const second = await makeInspector(ORDER_LAT + 0.05, ORDER_LNG, { name: 'Second' });
      const orderId = await createPaidOrder(customer);

      // Decline through both inspectors → UNASSIGNED.
      let offer = await pendingOfferFor(orderId);
      while (offer) {
        const tok = inspectorTokens.get(offer.inspectorId)!;
        await request(app.getHttpServer())
          .post(`/api/v1/offers/${offer.id}/decline`)
          .set('Authorization', `Bearer ${tok}`)
          .expect(200);
        offer = await pendingOfferFor(orderId);
      }
      let order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe('UNASSIGNED');

      const res = await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/orders/${orderId}/assign`)
          .send({ inspectorId: second.userId }),
        admin.token,
      ).expect(200);
      expect(res.body.status).toBe('ASSIGNED');
      expect(res.body.inspectorId).toBe(second.userId);

      order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe('ASSIGNED');
      expect(order!.inspectorId).toBe(second.userId);
      void near;
    });

    it('13. adminAssign rejects a non-eligible inspector (400)', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const notEligible = await makeInspector(ORDER_LAT + 0.05, ORDER_LNG, { eligible: false });
      const orderId = await createPaidOrder(customer);

      const res = await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/orders/${orderId}/assign`)
          .send({ inspectorId: notEligible.userId }),
        admin.token,
      ).expect(400);
      expect(res.body.error.code).toBe('inspector_not_eligible');
    });

    it('14. adminCancel of an ACCEPTED order refunds the requested percent', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await createPaidOrder(customer);
      // Acceptance is what CAPTURES the money, and only captured money can be
      // refunded. Before it there is a hold, and a hold is released — see 14b.
      await acceptPendingOffer(orderId);
      const half = Math.round(FARE.totalCents * 0.5);

      const res = await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/orders/${orderId}/cancel`)
          .send({ refundPercent: 50, reason: REASON }),
        admin.token,
      ).expect(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.refundCents).toBe(half);
      expect(res.body.refundMode).toBe('refunded');

      const refund = await prisma.refund.findFirst({ where: { orderId } });
      expect(refund!.amountCents).toBe(half);
      expect(refund!.reason).toBe('admin');
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe('CANCELLED');
    });

    it('14b. adminCancel before acceptance releases the hold instead of refunding', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await createPaidOrder(customer);

      const res = await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/orders/${orderId}/cancel`)
          .send({ refundPercent: 50, reason: REASON }),
        admin.token,
      ).expect(200);
      expect(res.body.status).toBe('CANCELLED');
      // The admin asked for 50% back. There is nothing to give back: the money
      // never left the customer. Answering "2450 refunded" would put a refund in
      // the finance ledger that Stripe never made.
      expect(res.body.refundCents).toBe(0);
      expect(res.body.refundMode).toBe('authorization_released');
      expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
      const payment = await prisma.payment.findFirst({ where: { orderId, supersededAt: null } });
      expect(payment!.status).toBe('cancelled');
    });

    it('15. adminCancel out-of-range percent → 400 validation', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await createPaidOrder(customer);

      await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/orders/${orderId}/cancel`)
          .send({ refundPercent: 150, reason: REASON }),
        admin.token,
      ).expect(400);
    });

    it('15b. cancel and resolve-dispute refuse a missing, short or blank reason → 400 (DEN-294)', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await createPaidOrder(customer);

      // No reason; 9 characters after trimming; only spaces.
      for (const body of [
        { refundPercent: 0 },
        { refundPercent: 0, reason: '   too short ' },
        { refundPercent: 0, reason: ' '.repeat(20) },
      ]) {
        await bearer(
          request(app.getHttpServer()).post(`/api/v1/admin/orders/${orderId}/cancel`).send(body),
          admin.token,
        ).expect(400);
      }
      await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/orders/${orderId}/resolve-dispute`)
          .send({ resolution: 'customer', refundPercent: 0 }),
        admin.token,
      ).expect(400);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).not.toBe('CANCELLED');
    });

    it('15c. the reason reaches the audit row and the admin detail, and never the customer (DEN-294)', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await createPaidOrder(customer);
      const reason = 'The customer asked by phone to cancel the inspection';

      await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/orders/${orderId}/cancel`)
          .send({ refundPercent: 0, reason: `  ${reason}  ` }),
        admin.token,
      ).expect(200);

      const audit = await prisma.adminAuditLog.findFirst({
        where: { adminId: admin.userId, action: 'order.cancel', entityId: orderId },
      });
      expect((audit!.after as { reason: string }).reason).toBe(reason);

      const detail = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/orders/${orderId}`),
        admin.token,
      ).expect(200);
      expect(detail.body.decisions).toEqual([
        expect.objectContaining({
          action: 'cancel',
          reason,
          refundPercent: 0,
          resolution: null,
          actor: `admin:${admin.userId}`,
        }),
      ]);
      // The shared timeline does not carry the decision, for any role.
      expect(detail.body.events.map((e: { type: string }) => e.type)).not.toContain(
        'admin_decision',
      );

      const own = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);
      expect(JSON.stringify(own.body)).not.toContain(reason);
    });

    it('16. resolve-dispute (customer win) → Refund + REFUNDED + RESOLVED_CUSTOMER', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await driveToDisputed(customer); // total 5000

      const res = await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/orders/${orderId}/resolve-dispute`)
          .send({ resolution: 'customer', refundPercent: 100, reason: REASON }),
        admin.token,
      ).expect(200);
      expect(res.body.status).toBe('REFUNDED');
      expect(res.body.refundCents).toBe(FARE.totalCents);

      const refund = await prisma.refund.findFirst({ where: { orderId } });
      expect(refund!.amountCents).toBe(FARE.totalCents);
      expect(refund!.reason).toBe('dispute');
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe('REFUNDED');
      const dispute = await prisma.dispute.findUnique({ where: { orderId } });
      expect(dispute!.status).toBe('RESOLVED_CUSTOMER');
      expect(dispute!.resolvedBy).toBe(admin.userId);
      const decision = await prisma.orderEvent.findFirst({
        where: { orderId, type: 'admin_decision' },
      });
      expect(decision!.payload).toEqual({
        action: 'resolve_dispute',
        reason: REASON,
        refundPercent: 100,
        resolution: 'customer',
      });
    });

    it('17. resolve-dispute (inspector win) → Payout + COMPLETED + RESOLVED_INSPECTOR', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await driveToDisputed(customer);

      const res = await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/orders/${orderId}/resolve-dispute`)
          .send({ resolution: 'inspector', reason: REASON }),
        admin.token,
      ).expect(200);
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.payoutCents).toBe(FARE.inspectorShareCents);

      const payout = await prisma.payout.findUnique({ where: { orderId } });
      expect(payout!.status).toBe('paid');
      expect(payout!.amountCents).toBe(FARE.inspectorShareCents);
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe('COMPLETED');
      const dispute = await prisma.dispute.findUnique({ where: { orderId } });
      expect(dispute!.status).toBe('RESOLVED_INSPECTOR');
    });

    it('18. resolve-dispute on a non-disputed order → 409 not_disputed', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await createPaidOrder(customer); // PAID, not disputed

      const res = await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/orders/${orderId}/resolve-dispute`)
          .send({ resolution: 'customer', reason: REASON }),
        admin.token,
      ).expect(409);
      expect(res.body.error.code).toBe('not_disputed');
    });

    it('19. GET /orders/disputes lists DISPUTED orders + dispute rows', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await driveToDisputed(customer);

      const res = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/orders/disputes'),
        admin.token,
      ).expect(200);
      const row = res.body.items.find((d: { orderId: string }) => d.orderId === orderId);
      expect(row).toBeTruthy();
      expect(row.dispute.status).toBe('OPEN');
    });
  });

  // ============================================================
  // Listings area
  // ============================================================
  describe('listings', () => {
    async function seedListing(seller: Registered, status = 'ACTIVE'): Promise<string> {
      const report = await prisma.report.create({
        data: {
          deviceId: uniqueDeviceId('rep'),
          code: `CSP-${Math.random().toString(36).slice(2, 8)}`,
          tier: 'pro',
          s3Key: 'pro/x/y.pdf',
          userId: seller.userId,
          make: 'BMW',
          model: '320d',
          year: 2020,
        },
      });
      const listing = await prisma.listing.create({
        data: {
          sellerId: seller.userId,
          reportId: report.id,
          status: status as never,
          package: 'standard',
          priceCents: 1850000,
          city: 'Berlin',
          publishedAt: new Date(),
        },
      });
      return listing.id;
    }

    it('20. list with filters + hide/unhide (audited) + 404', async () => {
      const admin = await makeAdmin();
      const seller = await makeUser('seller');
      const listingId = await seedListing(seller, 'ACTIVE');

      const list = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/listings?sellerId=${seller.userId}`),
        admin.token,
      ).expect(200);
      expect(list.body.items.some((l: { id: string }) => l.id === listingId)).toBe(true);
      expect(list.body.items[0].priceCents).toBeDefined();

      await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/listings/${listingId}/hide`)
          .send({ reason: REASON }),
        admin.token,
      ).expect(200);
      let l = await prisma.listing.findUnique({ where: { id: listingId } });
      expect(l!.status).toBe('HIDDEN');

      await bearer(
        request(app.getHttpServer()).post(`/api/v1/admin/listings/${listingId}/unhide`),
        admin.token,
      ).expect(200);
      l = await prisma.listing.findUnique({ where: { id: listingId } });
      expect(l!.status).toBe('ACTIVE');

      const audit = await prisma.adminAuditLog.findFirst({
        where: { entity: 'listing', entityId: listingId, action: 'listing.hide' },
      });
      expect(audit).toBeTruthy();

      await bearer(
        request(app.getHttpServer())
          .post('/api/v1/admin/listings/nope/hide')
          .send({ reason: REASON }),
        admin.token,
      ).expect(404);
    });

    it('20f. list takes the showroom car filters (DEN-316)', async () => {
      const admin = await makeAdmin();
      const seller = await makeUser('seller');
      const base = {
        sellerId: seller.userId,
        status: 'ACTIVE' as const,
        source: 'manual',
        package: 'standard',
        publishedAt: new Date(),
      };
      const bmw = await prisma.listing.create({
        data: {
          ...base,
          priceCents: 1850000,
          city: 'Berlin',
          citySearch: 'berlin',
          countryCode: 'DE',
          make: 'BMW',
          makeSearch: 'bmw',
          model: '320d',
          modelSearch: '320d',
          year: 2020,
          mileageKm: 90000,
        },
      });
      const merc = await prisma.listing.create({
        data: {
          ...base,
          status: 'HIDDEN',
          priceCents: 3200000,
          city: 'Wien',
          citySearch: 'wien',
          countryCode: 'AT',
          make: 'Mercedes-Benz',
          makeSearch: 'mercedesbenz',
          model: 'C 220',
          modelSearch: 'c220',
          year: 2017,
          mileageKm: 150000,
        },
      });
      const ids = async (filter: string): Promise<string[]> => {
        const res = await bearer(
          request(app.getHttpServer()).get(
            `/api/v1/admin/listings?sellerId=${seller.userId}&${filter}`,
          ),
          admin.token,
        ).expect(200);
        return res.body.items.map((l: { id: string }) => l.id).sort();
      };

      expect(await ids('make=mercedes%20benz&model=c-220')).toEqual([merc.id]);
      expect(await ids('country=de')).toEqual([bmw.id]);
      expect(await ids('city=Vienna')).toEqual([merc.id]);
      expect(await ids(`city=${encodeURIComponent('Берлин')}`)).toEqual([bmw.id]);
      expect(await ids('priceFrom=2000000')).toEqual([merc.id]);
      expect(await ids('priceTo=1850000')).toEqual([bmw.id]);
      expect(await ids('yearFrom=2018&yearTo=2021')).toEqual([bmw.id]);
      expect(await ids('mileageTo=100000')).toEqual([bmw.id]);
      expect(await ids('mileageTo=0')).toEqual([]);
      // Status stays a filter beside the car filters.
      expect(await ids('status=HIDDEN&priceFrom=0')).toEqual([merc.id]);
      expect(await ids('status=ACTIVE&make=Mercedes')).toEqual([]);
      expect(await ids('')).toEqual([bmw.id, merc.id].sort());
    });

    it('20b. hide needs a reason; the seller is told, sees it, and cannot publish again (DEN-295)', async () => {
      const admin = await makeAdmin();
      const seller = await makeUser('seller');
      const listingId = await seedListing(seller, 'ACTIVE');
      const reason = 'The price in the advert does not match the description';
      const hide = (body: object) =>
        bearer(
          request(app.getHttpServer()).post(`/api/v1/admin/listings/${listingId}/hide`).send(body),
          admin.token,
        );

      // No reason; 9 characters after trimming; only spaces.
      await hide({}).expect(400);
      await hide({ reason: '   too short ' }).expect(400);
      await hide({ reason: ' '.repeat(20) }).expect(400);
      expect((await prisma.listing.findUnique({ where: { id: listingId } }))!.status).toBe(
        'ACTIVE',
      );

      await hide({ reason: `  ${reason}  ` }).expect(200);
      const hidden = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
      expect(hidden.status).toBe('HIDDEN');
      expect(hidden.adminHiddenReason).toBe(reason);
      expect(hidden.adminHiddenAt).not.toBeNull();

      const audit = await prisma.adminAuditLog.findFirst({
        where: { entity: 'listing', entityId: listingId, action: 'listing.hide' },
      });
      expect((audit!.after as { reason: string }).reason).toBe(reason);

      // The seller is told, with the reason (in-app row; dispatch is inline in tests).
      const notice = await prisma.notification.findFirst({
        where: { userId: seller.userId, type: 'listing.hidden', channel: 'inapp' },
      });
      expect((notice!.payload as { reason: string }).reason).toBe(reason);

      // The seller sees the reason in the cabinet.
      const mine = await request(app.getHttpServer())
        .get('/api/v1/me/listings')
        .set('Authorization', `Bearer ${seller.token}`)
        .expect(200);
      const row = mine.body.items.find((i: { id: string }) => i.id === listingId);
      expect(row.adminHiddenReason).toBe(reason);
      expect(row.adminHiddenAt).toEqual(expect.any(String));

      // An admin hide is not the seller's to undo.
      const publish = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listingId}/publish`)
        .set('Authorization', `Bearer ${seller.token}`)
        .send({ package: 'standard' })
        .expect(409);
      expect(publish.body.error.code).toBe('listing_hidden_by_admin');

      // An admin unhide clears the hide and tells the seller.
      await bearer(
        request(app.getHttpServer()).post(`/api/v1/admin/listings/${listingId}/unhide`),
        admin.token,
      ).expect(200);
      const restored = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
      expect(restored.status).toBe('ACTIVE');
      expect(restored.adminHiddenAt).toBeNull();
      expect(restored.adminHiddenReason).toBeNull();
      expect(
        await prisma.notification.count({
          where: { userId: seller.userId, type: 'listing.unhidden', channel: 'inapp' },
        }),
      ).toBe(1);
    });

    it('20e. hide works only on a live listing, unhide only on an admin hide', async () => {
      const admin = await makeAdmin();
      const seller = await makeUser('seller');
      const post = (id: string, action: 'hide' | 'unhide') =>
        bearer(
          request(app.getHttpServer())
            .post(`/api/v1/admin/listings/${id}/${action}`)
            .send({ reason: REASON }),
          admin.token,
        );

      for (const status of ['DRAFT', 'HIDDEN', 'SOLD', 'DELETED']) {
        const id = await seedListing(seller, status);
        const res = await post(id, 'hide').expect(409);
        expect(res.body.error.code).toBe('listing_not_active');
        const row = await prisma.listing.findUniqueOrThrow({ where: { id } });
        expect(row.status).toBe(status);
        expect(row.adminHiddenAt).toBeNull();
      }

      // HIDDEN here is a seller hide: the seed sets no adminHiddenAt.
      for (const status of ['ACTIVE', 'HIDDEN', 'DELETED']) {
        const id = await seedListing(seller, status);
        const res = await post(id, 'unhide').expect(409);
        expect(res.body.error.code).toBe('listing_not_hidden_by_admin');
        expect((await prisma.listing.findUniqueOrThrow({ where: { id } })).status).toBe(status);
      }

      // A refused action tells the seller nothing.
      expect(
        await prisma.notification.count({
          where: { userId: seller.userId, type: { in: ['listing.hidden', 'listing.unhidden'] } },
        }),
      ).toBe(0);

      // The admin list tells an admin hide from a seller hide.
      const adminHidden = await seedListing(seller, 'ACTIVE');
      await post(adminHidden, 'hide').expect(200);
      const list = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/listings?sellerId=${seller.userId}`),
        admin.token,
      ).expect(200);
      const items = list.body.items as { id: string; status: string; adminHiddenAt: string | null }[];
      expect(items.find((i) => i.id === adminHidden)!.adminHiddenAt).toEqual(expect.any(String));
      const sellerHidden = items.filter((i) => i.status === 'HIDDEN' && i.id !== adminHidden);
      expect(sellerHidden.length).toBeGreaterThan(0);
      expect(sellerHidden.every((i) => i.adminHiddenAt === null)).toBe(true);
    });

    it('20c. a seller who unpublished the listing may still publish it again (DEN-295)', async () => {
      const seller = await makeUser('seller');
      const listingId = await seedListing(seller, 'ACTIVE');
      // Both routes carry no @HttpCode, so Nest answers a POST with 201.
      await request(app.getHttpServer())
        .post(`/api/v1/listings/${listingId}/unpublish`)
        .set('Authorization', `Bearer ${seller.token}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/listings/${listingId}/publish`)
        .set('Authorization', `Bearer ${seller.token}`)
        .send({ package: 'standard' })
        .expect(201);
      expect((await prisma.listing.findUnique({ where: { id: listingId } }))!.status).toBe(
        'ACTIVE',
      );
    });

    it('20d. an admin deletes a live listing with a reason; the seller is told', async () => {
      const admin = await makeAdmin();
      const user = await makeUser('nonadmin');
      const seller = await makeUser('seller');
      const listingId = await seedListing(seller, 'ACTIVE');
      const reason = 'The photos show a different car';
      const del = (token: string, body: object) =>
        bearer(
          request(app.getHttpServer()).post(`/api/v1/admin/listings/${listingId}/delete`).send(body),
          token,
        );

      await del(user.token, { reason }).expect(403);
      await del(admin.token, {}).expect(400);
      await del(admin.token, { reason: '   too short ' }).expect(400);
      expect((await prisma.listing.findUniqueOrThrow({ where: { id: listingId } })).status).toBe(
        'ACTIVE',
      );

      const res = await del(admin.token, { reason: `  ${reason}  ` }).expect(200);
      expect(res.body.status).toBe('DELETED');

      // Soft delete: the row stays, the gallery and the report link go.
      const deleted = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
      expect(deleted.status).toBe('DELETED');
      expect(deleted.reportId).toBeNull();
      expect(await prisma.listingPhoto.count({ where: { listingId } })).toBe(0);

      const audit = await prisma.adminAuditLog.findFirst({
        where: { entity: 'listing', entityId: listingId, action: 'listing.delete' },
      });
      expect(audit!.adminId).toBe(admin.userId);
      expect(audit!.before).toMatchObject({ status: 'ACTIVE' });
      expect(audit!.after).toMatchObject({ status: 'DELETED', reason });

      const notice = await prisma.notification.findFirst({
        where: { userId: seller.userId, type: 'listing.deleted', channel: 'inapp' },
      });
      expect((notice!.payload as { reason: string }).reason).toBe(reason);

      // The listing leaves the seller's cabinet, like the seller's own delete.
      const mine = await request(app.getHttpServer())
        .get('/api/v1/me/listings')
        .set('Authorization', `Bearer ${seller.token}`)
        .expect(200);
      expect(mine.body.items.some((i: { id: string }) => i.id === listingId)).toBe(false);

      const again = await del(admin.token, { reason }).expect(409);
      expect(again.body.error.code).toBe('listing_already_deleted');
    });

  });

  // ============================================================
  // Reports area (DEN-312)
  // ============================================================
  describe('reports', () => {
    it('DEN-312. an admin reads any report; a user cannot use the admin route', async () => {
      const admin = await makeAdmin();
      const owner = await makeUser('owner');
      const stranger = await makeUser('stranger');
      const report = await prisma.report.create({
        data: {
          deviceId: uniqueDeviceId('rep'),
          code: `CSP-${Math.random().toString(36).slice(2, 8)}`,
          tier: 'pro',
          s3Key: 'pro/x/y.pdf',
          userId: owner.userId,
          make: 'BMW',
          model: '320d',
          year: 2020,
        },
      });
      const server = () => request(app.getHttpServer());

      try {
        const full = await bearer(
          server().get(`/api/v1/admin/reports/${report.id}/full`),
          admin.token,
        ).expect(200);
        expect(full.body.id).toBe(report.id);
        expect(full.body.code).toBe(report.code);
        expect(Array.isArray(full.body.photos)).toBe(true);
        // The PDF is not uploaded, so there is no URL.
        expect(full.body.pdf.downloadUrl).toBeNull();

        // The customer route keeps its access rule: the admin is not the owner.
        await bearer(
          server().get(`/api/v1/reports/${report.id}/full`),
          admin.token,
        ).expect(403);

        // The owner and a stranger cannot use the admin routes.
        for (const user of [owner, stranger]) {
          await bearer(
            server().get(`/api/v1/admin/reports/${report.id}/full`),
            user.token,
          ).expect(403);
          await bearer(
            server().get(`/api/v1/admin/reports/${report.id}/download`),
            user.token,
          ).expect(403);
        }

        await bearer(
          server().get('/api/v1/admin/reports/00000000-0000-4000-8000-000000000000/full'),
          admin.token,
        ).expect(404);

        // 409 report_not_uploaded; 503 when the environment has no R2.
        const download = await bearer(
          server().get(`/api/v1/admin/reports/${report.id}/download`),
          admin.token,
        );
        expect([409, 503]).toContain(download.status);
      } finally {
        await prisma.report.delete({ where: { id: report.id } });
      }
    });
  });

  // ============================================================
  // Settings area (acceptance: quote reflects new fee immediately)
  // ============================================================
  describe('settings', () => {
    afterEach(async () => {
      // Restore the base fee so other suites' quote assertions stay green.
      // This used to be a hardcoded 50, which meant the "restore" quietly
      // installed a value of its own choosing and every later suite priced
      // against it. Restore the actual default.
      await settings.set('orderBaseFeeEur', PLATFORM_SETTING_DEFAULTS.orderBaseFeeEur);
    });

    it('22. GET settings returns values + defaults', async () => {
      const admin = await makeAdmin();
      const res = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/settings'),
        admin.token,
      ).expect(200);
      expect(res.body.values.orderBaseFeeEur).toBeDefined();
      expect(res.body.defaults.orderBaseFeeEur).toBe(
        PLATFORM_SETTING_DEFAULTS.orderBaseFeeEur,
      );
    });

    it('23. PATCH unknown key → 404 unknown_setting', async () => {
      const admin = await makeAdmin();
      const res = await bearer(
        request(app.getHttpServer()).patch('/api/v1/admin/settings/notAKey').send({ value: 1 }),
        admin.token,
      ).expect(404);
      expect(res.body.error.code).toBe('unknown_setting');
    });

    it('24. PATCH percent key out of range → 400', async () => {
      const admin = await makeAdmin();
      await bearer(
        request(app.getHttpServer()).patch('/api/v1/admin/settings/platformFeePercent').send({ value: 150 }),
        admin.token,
      ).expect(400);
    });

    it('25. ACCEPTANCE: PATCH orderBaseFeeEur changes the quote base fee immediately', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);

      const before = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);
      expect(before.body.breakdown.baseFeeCents).toBe(FARE.baseFeeCents);

      await bearer(
        request(app.getHttpServer()).patch('/api/v1/admin/settings/orderBaseFeeEur').send({ value: 75 }),
        admin.token,
      ).expect(200);

      const after = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);
      expect(after.body.breakdown.baseFeeCents).toBe(7500);

      // Audit row captures before/after.
      const audit = await prisma.adminAuditLog.findFirst({
        where: { entity: 'platform_setting', entityId: 'orderBaseFeeEur', action: 'settings.update' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).toBeTruthy();
      expect((audit!.after as { value: number }).value).toBe(75);
    });

    it('24b. a value outside the key range → 400 with the range, and nothing is stored (DEN-297)', async () => {
      const admin = await makeAdmin();
      const list = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/settings'),
        admin.token,
      ).expect(200);
      expect(list.body.limits.orderBaseFeeEur).toEqual({ min: 5, max: 200 });

      const before = await settings.getNumber('orderBaseFeeEur');
      // The ticket's own example: an extra two digits on the base fee.
      const res = await bearer(
        request(app.getHttpServer())
          .patch('/api/v1/admin/settings/orderBaseFeeEur')
          .send({ value: 3900 }),
        admin.token,
      ).expect(400);
      expect(res.body.error.code).toBe('invalid_value');
      expect(res.body.error.message).toContain('from 5 to 200');
      settings.invalidate();
      expect(await settings.getNumber('orderBaseFeeEur')).toBe(before);

      // A zero timeout would expire every offer the moment it was sent.
      await bearer(
        request(app.getHttpServer())
          .patch('/api/v1/admin/settings/offerTimeoutMinutes')
          .send({ value: 0 }),
        admin.token,
      ).expect(400);
      // 0 stays allowed where it is a documented lever.
      await bearer(
        request(app.getHttpServer())
          .patch('/api/v1/admin/settings/orderCapKm')
          .send({ value: PLATFORM_SETTING_DEFAULTS.orderCapKm }),
        admin.token,
      ).expect(200);
    });

    it('25b. the removed signedUrlTtlMinutes key is not listed and cannot be set (DEN-293)', async () => {
      const admin = await makeAdmin();
      const list = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/settings'),
        admin.token,
      ).expect(200);
      expect(list.body.values).not.toHaveProperty('signedUrlTtlMinutes');
      expect(list.body.defaults).not.toHaveProperty('signedUrlTtlMinutes');

      const res = await bearer(
        request(app.getHttpServer())
          .patch('/api/v1/admin/settings/signedUrlTtlMinutes')
          .send({ value: 5 }),
        admin.token,
      ).expect(404);
      expect(res.body.error.code).toBe('unknown_setting');
    });
  });

  // ============================================================
  // Legal templates area
  // ============================================================
  describe('legal-templates', () => {
    it('26. create versions, activate, list, get by key; bad key → 400', async () => {
      const admin = await makeAdmin();
      const KEY = 'contract_eu';
      createdLegalKeys.add(KEY);
      // Start from a clean slate for this key (the table may carry seed rows).
      await prisma.legalTemplate.deleteMany({ where: { key: KEY } });

      const v1 = await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/legal-templates/${KEY}`)
          .send({ locale: 'de', title: 'V1', bodyMd: '# v1' }),
        admin.token,
      ).expect(201);
      expect(v1.body.version).toBe(1);
      expect(v1.body.active).toBe(true);

      const v2 = await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/legal-templates/${KEY}`)
          .send({ locale: 'de', title: 'V2', bodyMd: '# v2', activate: true }),
        admin.token,
      ).expect(201);
      expect(v2.body.version).toBe(2);

      // Only v2 is active now.
      const activeRows = await prisma.legalTemplate.findMany({
        where: { key: KEY, active: true },
      });
      expect(activeRows.length).toBe(1);
      expect(activeRows[0].version).toBe(2);

      // Re-activate v1.
      await bearer(
        request(app.getHttpServer())
          .post(`/api/v1/admin/legal-templates/${KEY}/activate`)
          .send({ version: 1 }),
        admin.token,
      ).expect(200);
      const byKey = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/legal-templates/${KEY}`),
        admin.token,
      ).expect(200);
      expect(byKey.body.active.version).toBe(1);
      expect(byKey.body.active.bodyMd).toBe('# v1');
      expect(byKey.body.versions.length).toBe(2);

      const all = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/legal-templates'),
        admin.token,
      ).expect(200);
      expect(all.body.templates[KEY].length).toBe(2);

      // Unknown key.
      await bearer(
        request(app.getHttpServer())
          .post('/api/v1/admin/legal-templates/contract_xx')
          .send({ locale: 'de', title: 'x', bodyMd: 'x' }),
        admin.token,
      ).expect(400);

      // Activate a missing version → 404.
      await bearer(
        request(app.getHttpServer())
          .post('/api/v1/admin/legal-templates/contract_de/activate')
          .send({ version: 99 }),
        admin.token,
      ).expect(404);
    });
  });

  // ============================================================
  // Finance area + DAC7
  // ============================================================
  describe('finance', () => {
    it('27. summary aggregates succeeded payments / refunds / paid payouts', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      // Completed order → one succeeded order payment and one paid payout.
      const orderId = await driveToSubmitted(customer);
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/approve`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      const res = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/finance/summary'),
        admin.token,
      ).expect(200);
      expect(res.body.currency).toBe('EUR');
      expect(res.body.payments.grossCents).toBeGreaterThanOrEqual(FARE.totalCents);
      expect(res.body.byPurpose.order.cents).toBeGreaterThanOrEqual(FARE.totalCents);
      expect(res.body.payouts.cents).toBeGreaterThanOrEqual(FARE.inspectorShareCents);
      expect(typeof res.body.platformNetCents).toBe('number');
    });

    it('27b. revenue is recognised at CAPTURE, not at authorization', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);

      const before = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/finance/summary'),
        admin.token,
      ).expect(200);

      // An order whose card is merely HELD. The platform has no claim on this
      // money — it is still the customer's — so counting it as revenue would
      // book income the business might have to hand straight back.
      const orderId = await createPaidOrder(customer);
      const held = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/finance/summary'),
        admin.token,
      ).expect(200);
      expect(held.body.byPurpose.order.cents).toBe(before.body.byPurpose.order.cents);
      expect(held.body.payments.grossCents).toBe(before.body.payments.grossCents);

      // Acceptance takes the money, and only then is it revenue.
      await acceptPendingOffer(orderId);
      const captured = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/finance/summary'),
        admin.token,
      ).expect(200);
      expect(captured.body.byPurpose.order.cents).toBe(
        before.body.byPurpose.order.cents + FARE.totalCents,
      );
    });

    it('27c. the revenue window reads the capture time, not the authorization time (DEN-293)', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      await makeInspector(ORDER_LAT, ORDER_LNG);
      const orderId = await createPaidOrder(customer);
      await acceptPendingOffer(orderId);

      const payment = await prisma.payment.findFirstOrThrow({
        where: { orderId, status: 'succeeded' },
      });
      expect(payment.capturedAt).not.toBeNull();

      // Authorized 40 days ago, captured now: outside the default 30-day
      // summary window by creation time, inside it by capture time.
      const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000);
      await prisma.payment.update({
        where: { id: payment.id },
        data: { createdAt: fortyDaysAgo },
      });

      const summary = () =>
        bearer(
          request(app.getHttpServer()).get('/api/v1/admin/finance/summary'),
          admin.token,
        ).expect(200);
      const dashboard = () =>
        bearer(request(app.getHttpServer()).get('/api/v1/admin/dashboard'), admin.token).expect(
          200,
        );

      const summaryCapturedNow = await summary();
      const dashboardCapturedNow = await dashboard();

      // Move the capture out of both windows too. The payment must leave the
      // 30-day summary AND today's dashboard figure, by exactly its amount.
      // Differences, not absolute values: other suites share this database.
      await prisma.payment.update({
        where: { id: payment.id },
        data: { capturedAt: fortyDaysAgo },
      });
      const summaryCapturedEarlier = await summary();
      const dashboardCapturedEarlier = await dashboard();

      expect(
        summaryCapturedNow.body.byPurpose.order.cents -
          summaryCapturedEarlier.body.byPurpose.order.cents,
      ).toBe(payment.amountCents);
      expect(
        dashboardCapturedNow.body.revenueTodayCents -
          dashboardCapturedEarlier.body.revenueTodayCents,
      ).toBe(payment.amountCents);
    });

    it('28. DAC7 CSV: text/csv, header row, one row per inspector with paid payouts', async () => {
      const admin = await makeAdmin();
      const customer = await makeUser('cust');
      const inspector = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Hans Müller' });
      const orderId = await driveToSubmitted(customer);
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/approve`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      const year = new Date().getUTCFullYear();
      const res = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/finance/dac7.csv?year=${year}`),
        admin.token,
      ).expect(200);

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain(`dac7-${year}.csv`);
      const lines = res.text.trim().split('\r\n');
      expect(lines[0]).toBe(
        'inspectorUserId,name,email,companyName,taxId,vatId,countryCode,payoutCount,totalPayoutCents,totalPayoutEur',
      );
      const row = lines.find((l) => l.includes(inspector.userId));
      expect(row).toBeTruthy();
      expect(row).toContain(`"${FARE.inspectorShareCents}"`);
      expect(row).toContain(`"${(FARE.inspectorShareCents / 100).toFixed(2)}"`);
      expect(row).toContain('"Hans Müller"');
    });
  });

  // ============================================================
  // Dashboard + Audit read
  // ============================================================
  describe('dashboard + audit', () => {
    it('29. dashboard returns the expected count shape', async () => {
      const admin = await makeAdmin();
      const res = await bearer(
        request(app.getHttpServer()).get('/api/v1/admin/dashboard'),
        admin.token,
      ).expect(200);
      for (const key of [
        'pendingKyc',
        'openDisputes',
        'unassignedOrders',
        'activeListings',
        'totalUsers',
        'bannedUsers',
        'pendingPayouts',
        'revenueTodayCents',
      ]) {
        expect(typeof res.body[key]).toBe('number');
      }
      expect(res.body.totalUsers).toBeGreaterThanOrEqual(1);
    });

    it('30. a mutating action writes an AdminAuditLog row, readable via GET /admin/audit', async () => {
      const admin = await makeAdmin();
      const target = await makeUser('audittarget');

      await bearer(
        request(app.getHttpServer()).post(`/api/v1/admin/users/${target.userId}/ban`).send({ reason: 'x' }),
        admin.token,
      ).expect(200);

      const res = await bearer(
        request(app.getHttpServer()).get(`/api/v1/admin/audit?entity=user&entityId=${target.userId}`),
        admin.token,
      ).expect(200);
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      const row = res.body.items.find((r: { action: string }) => r.action === 'user.ban');
      expect(row).toBeTruthy();
      expect(row.adminId).toBe(admin.userId);
    });
  });
});
