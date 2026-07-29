import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { LegalContractService } from '../src/legal/legal-contract.service';
import {
  CONTRACT_TEMPLATES,
  ContractKey,
} from '../src/legal/legal-contracts.content';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/test-app';

// Berlin Mitte — the order/customer/inspector location used across the suite.
const ORDER_LAT = 52.52;
const ORDER_LNG = 13.405;
const SCHEDULED_AT = '2026-07-01T09:00:00.000Z';

function uniqueEmail(prefix = 'lc'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

interface Registered {
  token: string;
  userId: string;
  email: string;
}

describe('LegalSync / Order Contract (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let legal: LegalContractService;

  const createdOrderIds = new Set<string>();
  const createdUserIds = new Set<string>();
  const createdWaitlistEmails = new Set<string>();
  const createdContractIds = new Set<string>();
  const inspectorTokens = new Map<string, string>();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    legal = app.get(LegalContractService);
    // Ensure an ACTIVE template exists for each contract key. Sibling suites (the
    // admin legal-templates spec) may wipe e.g. contract_eu rows, so self-heal here
    // to keep this suite order-independent.
    await ensureActiveTemplates();
  });

  /** Seed-if-missing: guarantee an active template for each of the three keys. */
  async function ensureActiveTemplates(): Promise<void> {
    const keys: ContractKey[] = ['contract_de', 'contract_eu', 'contract_en'];
    for (const key of keys) {
      const active = await prisma.legalTemplate.findFirst({ where: { key, active: true } });
      if (active) continue;
      const max = await prisma.legalTemplate.findFirst({
        where: { key },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const tpl = CONTRACT_TEMPLATES[key];
      await prisma.legalTemplate.create({
        data: {
          key,
          version: (max?.version ?? 0) + 1,
          locale: tpl.locale,
          title: tpl.title,
          bodyMd: tpl.bodyMd,
          active: true,
        },
      });
    }
  }

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
      // Detach the contract from the order before deleting either.
      await prisma.order.updateMany({
        where: { id: { in: orderIds } },
        data: { contractId: null },
      });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (createdContractIds.size) {
      await prisma.orderContract.deleteMany({ where: { id: { in: [...createdContractIds] } } });
    }
    if (createdWaitlistEmails.size) {
      await prisma.waitlistEntry.deleteMany({
        where: { email: { in: [...createdWaitlistEmails] } },
      });
    }
    const userIds = [...createdUserIds];
    if (userIds.length) {
      await prisma.payout.deleteMany({ where: { inspectorId: { in: userIds } } });
      await prisma.orderOffer.deleteMany({ where: { inspectorId: { in: userIds } } });
      await prisma.inspectorProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.verificationToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.deviceLink.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    createdOrderIds.clear();
    createdUserIds.clear();
    createdWaitlistEmails.clear();
    createdContractIds.clear();
    inspectorTokens.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---- seeding helpers ----

  async function registerUser(prefix = 'usr'): Promise<Registered> {
    const email = uniqueEmail(prefix);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'Sup3rSecret!', gdprConsent: true })
      .expect(201);
    return { token: res.body.token as string, userId: res.body.user.id as string, email };
  }

  async function makeCustomer(): Promise<Registered> {
    const u = await registerUser('cust');
    createdUserIds.add(u.userId);
    createdWaitlistEmails.add(u.email);
    return u;
  }

  async function makeAdmin(): Promise<Registered> {
    const u = await registerUser('admin');
    createdUserIds.add(u.userId);
    await prisma.user.update({ where: { id: u.userId }, data: { role: Role.ADMIN } });
    // Re-login so the JWT carries the ADMIN role (the register token was issued
    // before the role change).
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: u.email, password: 'Sup3rSecret!' })
      .expect(200);
    return { token: res.body.token as string, userId: u.userId, email: u.email };
  }

  async function makeInspector(
    lat: number,
    lng: number,
    opts: { name?: string; company?: string } = {},
  ): Promise<Registered> {
    const u = await registerUser('insp');
    createdUserIds.add(u.userId);
    await prisma.user.update({
      where: { id: u.userId },
      data: { kycVerified: true, name: opts.name ?? 'Inspector', phone: '+49301234567' },
    });
    await prisma.inspectorProfile.create({
      data: {
        userId: u.userId,
        companyName: opts.company ?? 'KFZ Test GmbH',
        baseAddress: 'Teststraße 1, Berlin',
        searchRadiusKm: 50,
        available: true,
        stripeOnboarded: true,
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

  async function createPaidOrder(customer: Registered): Promise<{ orderId: string }> {
    const res = await request(app.getHttpServer())
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
    createdOrderIds.add(res.body.orderId);
    return { orderId: res.body.orderId };
  }

  async function pendingOfferFor(orderId: string) {
    return prisma.orderOffer.findFirst({ where: { orderId, status: 'PENDING' } });
  }

  /** Accept the current PENDING offer as whoever holds it (drives order → ASSIGNED). */
  async function acceptPendingOffer(orderId: string): Promise<string> {
    const offer = await pendingOfferFor(orderId);
    if (!offer) throw new Error(`No pending offer for order ${orderId}`);
    const token = inspectorTokens.get(offer.inspectorId);
    if (!token) throw new Error(`No token for inspector ${offer.inspectorId}`);
    await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return offer.inspectorId;
  }

  /** Drive an order to ASSIGNED via the accept-offer path; return inspector id. */
  async function assignOrder(orderId: string): Promise<string> {
    return acceptPendingOffer(orderId);
  }

  async function trackContractForOrder(orderId: string): Promise<void> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (order?.contractId) createdContractIds.add(order.contractId);
  }

  // ============================================================
  // 1–3. resolveTemplateKey mapping (unit-level via the service)
  // ============================================================
  it('1. resolveTemplateKey maps DE → contract_de', () => {
    expect(legal.resolveTemplateKey('DE')).toBe('contract_de');
    expect(legal.resolveTemplateKey('de')).toBe('contract_de');
  });

  it('2. resolveTemplateKey maps other EU member states (FR/IT/ES) → contract_eu', () => {
    expect(legal.resolveTemplateKey('FR')).toBe('contract_eu');
    expect(legal.resolveTemplateKey('IT')).toBe('contract_eu');
    expect(legal.resolveTemplateKey('ES')).toBe('contract_eu');
  });

  it('3. resolveTemplateKey maps non-EU (US/GB) → contract_en', () => {
    expect(legal.resolveTemplateKey('US')).toBe('contract_en');
    expect(legal.resolveTemplateKey('GB')).toBe('contract_en');
    expect(legal.resolveTemplateKey('')).toBe('contract_en');
  });

  // ============================================================
  // 4. Contract auto-created on ASSIGNED, version frozen, substituted
  // ============================================================
  it('4. contract is auto-created when an order reaches ASSIGNED (DE → contract_de)', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Hans Müller', company: 'KFZ Müller GmbH' });
    const { orderId } = await createPaidOrder(customer);
    await assignOrder(orderId);
    await trackContractForOrder(orderId);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('ASSIGNED');
    expect(order!.contractId).toBeTruthy();

    const contract = await prisma.orderContract.findUnique({ where: { id: order!.contractId! } });
    expect(contract).toBeTruthy();
    expect(contract!.templateKey).toBe('contract_de');
    expect(contract!.pdfS3Key).toBeNull();

    // templateVersion is frozen to the ACTIVE template's version.
    const activeTpl = await prisma.legalTemplate.findFirst({
      where: { key: 'contract_de', active: true },
      orderBy: { version: 'desc' },
    });
    expect(contract!.templateVersion).toBe(activeTpl!.version);

    // Rendered HTML must contain substituted values and NO raw placeholders.
    const html = contract!.renderedHtml;
    expect(html).toContain(order!.number);
    const totalEur = `€${(order!.totalCents / 100).toFixed(2)}`;
    expect(html).toContain(totalEur); // formatted money from the order total
    expect(html).toContain('Hans Müller');
    expect(html).not.toMatch(/\{\{.*?\}\}/);
  });

  // ============================================================
  // 5. resolveTemplateKey reflected in stored contract for a FR order
  // ============================================================
  it('5. an order with countryCode FR produces a contract_eu contract on render', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    // Orders are created with countryCode DE by default; flip to FR before render.
    await prisma.order.update({ where: { id: orderId }, data: { countryCode: 'FR' } });
    await assignOrder(orderId);
    await trackContractForOrder(orderId);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    const contract = await prisma.orderContract.findUnique({ where: { id: order!.contractId! } });
    expect(contract!.templateKey).toBe('contract_eu');
  });

  // ============================================================
  // 6. Idempotency — rendering twice does not create a second contract
  // ============================================================
  it('6. renderContractForOrder is idempotent (no second contract)', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    await assignOrder(orderId);
    await trackContractForOrder(orderId);

    const order1 = await prisma.order.findUnique({ where: { id: orderId } });
    const firstContractId = order1!.contractId;
    expect(firstContractId).toBeTruthy();

    // Re-render explicitly — should return the SAME contract.
    const again = await legal.renderContractForOrder(orderId);
    expect(again.id).toBe(firstContractId);

    const count = await prisma.orderContract.count({ where: { id: firstContractId! } });
    expect(count).toBe(1);
    const order2 = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order2!.contractId).toBe(firstContractId);
  });

  // ============================================================
  // 7. GET /orders/:id/contract — customer can read it
  // ============================================================
  it('7. GET /orders/:id/contract returns the contract for the customer', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    await assignOrder(orderId);
    await trackContractForOrder(orderId);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}/contract`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(res.body.orderId).toBe(orderId);
    expect(res.body.templateKey).toBe('contract_de');
    expect(res.body.pdfReady).toBe(false);
    expect(typeof res.body.templateVersion).toBe('number');
    expect(res.body.locale).toBe('de');
    expect(res.body.html).toContain('<!doctype html>');
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(res.body.html).toContain(order!.number);
    expect(res.body.html).not.toMatch(/\{\{.*?\}\}/);
  });

  // ============================================================
  // 8. GET contract — assigned inspector can read it
  // ============================================================
  it('8. GET /orders/:id/contract returns the contract for the assigned inspector', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    const inspectorId = await assignOrder(orderId);
    await trackContractForOrder(orderId);
    const inspToken = inspectorTokens.get(inspectorId)!;

    const res = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}/contract`)
      .set('Authorization', `Bearer ${inspToken}`)
      .expect(200);
    expect(res.body.orderId).toBe(orderId);
  });

  // ============================================================
  // 9. GET contract — admin can read it
  // ============================================================
  it('9. GET /orders/:id/contract returns the contract for an admin', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    await assignOrder(orderId);
    await trackContractForOrder(orderId);
    const admin = await makeAdmin();

    const res = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}/contract`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(res.body.orderId).toBe(orderId);
  });

  // ============================================================
  // 10. GET contract — unrelated user → 403 forbidden
  // ============================================================
  it('10. GET /orders/:id/contract by an unrelated user → 403 forbidden', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    await assignOrder(orderId);
    await trackContractForOrder(orderId);
    const stranger = await makeCustomer();

    const res = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}/contract`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  // ============================================================
  // 11. GET contract — before assignment → 404 contract_not_ready
  // ============================================================
  it('11. GET /orders/:id/contract before assignment → 404 contract_not_ready', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}/contract`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(404);
    expect(res.body.error.code).toBe('contract_not_ready');
  });

  // ============================================================
  // 12. Inspector taxId/vatId persist via PATCH and return via GET
  // ============================================================
  it('12. PATCH /inspector/profile persists taxId/vatId and GET returns them', async () => {
    const inspector = await registerUser('insp');
    createdUserIds.add(inspector.userId);

    const patch = await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ companyName: 'Tax Co', taxId: 'DE123456789', vatId: 'DE999999999' })
      .expect(200);
    expect(patch.body.taxId).toBe('DE123456789');
    expect(patch.body.vatId).toBe('DE999999999');

    const get = await request(app.getHttpServer())
      .get('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .expect(200);
    expect(get.body.taxId).toBe('DE123456789');
    expect(get.body.vatId).toBe('DE999999999');

    // Persisted on the row (flows into the DAC7 CSV automatically).
    const profile = await prisma.inspectorProfile.findUnique({ where: { userId: inspector.userId } });
    expect(profile!.taxId).toBe('DE123456789');
    expect(profile!.vatId).toBe('DE999999999');
  });

  // ============================================================
  // 13. Inspector tax IDs flow into the rendered contract
  // ============================================================
  it('13. inspector taxId/vatId appear in the rendered contract on assignment', async () => {
    const customer = await makeCustomer();
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Tax Insp' });
    await prisma.inspectorProfile.update({
      where: { userId: inspector.userId },
      data: { taxId: 'DE555000111', vatId: 'DE777000222' },
    });
    const { orderId } = await createPaidOrder(customer);
    await assignOrder(orderId);
    await trackContractForOrder(orderId);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    const contract = await prisma.orderContract.findUnique({ where: { id: order!.contractId! } });
    expect(contract!.renderedHtml).toContain('DE555000111');
    expect(contract!.renderedHtml).toContain('DE777000222');
  });
});
