import { INestApplication } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import request from 'supertest';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/test-app';
import { PinnedTariff, colocatedQuote, pinTariff } from './helpers/tariff';

// Berlin Mitte — order/customer + inspector location used across the suite.
const ORDER_LAT = 52.52;
const ORDER_LNG = 13.405;
const SCHEDULED_AT = '2026-07-01T09:00:00.000Z';

function uniqueEmail(prefix = 'po'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

interface Registered {
  token: string;
  userId: string;
  email: string;
}

async function registerUser(app: INestApplication, prefix = 'cust'): Promise<Registered> {
  const email = uniqueEmail(prefix);
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password: 'Sup3rSecret!', gdprConsent: true })
    .expect(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

describe('Payouts / Stripe Connect / escrow release (e2e, mock mode)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let payments: PaymentsService;

  const createdOrderIds = new Set<string>();
  const createdUserIds = new Set<string>();
  const createdWaitlistEmails = new Set<string>();
  // userId → bearer token, so we can accept an offer as whoever actually holds it.
  const inspectorTokens = new Map<string, string>();

  // Inspector sits at the order location, so the fare is base + one minute of
  // travel, floored at the minimum fare. Derived, not hardcoded.
  const FARE = colocatedQuote();
  let tariff: PinnedTariff;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    payments = app.get(PaymentsService);
    // Sibling suites mutate the tariff; pin it so these amounts mean something.
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
    inspectorTokens.clear();
  });

  afterAll(async () => {
    await tariff.restore();
    await app.close();
  });

  // ---- seeding helpers ----

  async function makeCustomer(): Promise<Registered> {
    const u = await registerUser(app, 'cust');
    createdUserIds.add(u.userId);
    createdWaitlistEmails.add(u.email);
    return u;
  }

  /**
   * Register an inspector. `onboarded` controls whether the InspectorProfile is
   * created with stripeOnboarded + a stripeAccountId (eligible to receive funds)
   * or as a bare profile without Stripe (NOT eligible). Location is always set.
   */
  async function makeInspector(
    lat: number,
    lng: number,
    opts: { name?: string; onboarded?: boolean } = {},
  ): Promise<Registered> {
    const onboarded = opts.onboarded ?? true;
    const u = await registerUser(app, 'insp');
    createdUserIds.add(u.userId);
    await prisma.user.update({
      where: { id: u.userId },
      data: { kycVerified: true, name: opts.name ?? 'Inspector', phone: '+49301234567' },
    });
    await prisma.inspectorProfile.create({
      data: {
        userId: u.userId,
        companyName: 'KFZ Test GmbH',
        baseAddress: 'Teststraße 1, Berlin',
        searchRadiusKm: 50,
        available: true,
        stripeOnboarded: onboarded,
        stripeAccountId: onboarded ? `acct_seed_${u.userId}` : null,
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

  /** Create a paid (mock) order; offer fires to the nearest inspector. */
  async function createPaidOrder(customer: Registered): Promise<{ orderId: string }> {
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
    trackOrder(res.body.orderId);
    return { orderId: res.body.orderId };
  }

  /** Accept the pending offer as its holder. */
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

  /** Drive an order all the way to SUBMITTED (assigned → submitted). */
  async function driveToSubmitted(customer: Registered): Promise<{ orderId: string; inspectorId: string }> {
    const { orderId } = await createPaidOrder(customer);
    const inspectorId = await acceptPendingOffer(orderId);
    await orders.submitReportForOrder(orderId);
    return { orderId, inspectorId };
  }

  // ============================================================
  // 1. POST /inspector/stripe-onboarding (mock)
  // ============================================================
  it('1. stripe-onboarding (mock) marks onboarded + sets a fake account id + returns accountLinkUrl', async () => {
    const u = await registerUser(app, 'insp');
    createdUserIds.add(u.userId);

    const res = await request(app.getHttpServer())
      .post('/api/v1/inspector/stripe-onboarding')
      .set('Authorization', `Bearer ${u.token}`)
      .expect(200);

    expect(typeof res.body.accountLinkUrl).toBe('string');
    expect(res.body.mock).toBe(true);

    const profile = await prisma.inspectorProfile.findUnique({ where: { userId: u.userId } });
    expect(profile).toBeTruthy();
    expect(profile!.stripeOnboarded).toBe(true);
    expect(profile!.stripeAccountId).toBe(`acct_mock_${u.userId}`);
  });

  // ============================================================
  // 2. GET /inspector/onboarding-status reflects onboarding
  // ============================================================
  it('2. onboarding-status reflects stripeOnboarded/hasAccount/eligibleForOffers', async () => {
    const u = await registerUser(app, 'insp');
    createdUserIds.add(u.userId);
    await prisma.user.update({ where: { id: u.userId }, data: { kycVerified: true } });

    await request(app.getHttpServer())
      .post('/api/v1/inspector/stripe-onboarding')
      .set('Authorization', `Bearer ${u.token}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/v1/inspector/onboarding-status')
      .set('Authorization', `Bearer ${u.token}`)
      .expect(200);

    expect(res.body.stripeOnboarded).toBe(true);
    expect(res.body.hasAccount).toBe(true);
    expect(res.body.eligibleForOffers).toBe(true); // kycVerified && stripeOnboarded
  });

  // ============================================================
  // 3. onboarding without auth → 401
  // ============================================================
  it('3. stripe-onboarding without a token → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/inspector/stripe-onboarding')
      .expect(401);
  });

  // ============================================================
  // 4. releasePayout on APPROVED → Payout paid + COMPLETED + 80% amount
  // ============================================================
  it('4. releasePayout on an APPROVED order → Payout paid, order COMPLETED, amount == inspectorShareCents', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await driveToSubmitted(customer);
    await orders.transition(orderId, OrderStatus.APPROVED, 'system');

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.inspectorShareCents).toBe(FARE.inspectorShareCents);

    await orders.releasePayout(orderId);

    const payout = await prisma.payout.findUnique({ where: { orderId } });
    expect(payout).toBeTruthy();
    expect(payout!.status).toBe('paid');
    expect(payout!.amountCents).toBe(order!.inspectorShareCents);
    expect(payout!.stripeTransferId).toBe(`tr_mock_${orderId}`);

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after!.status).toBe('COMPLETED');
  });

  // ============================================================
  // 5. releasePayout is idempotent
  // ============================================================
  it('5. releasePayout is idempotent — second call creates no duplicate payout', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await driveToSubmitted(customer);
    await orders.transition(orderId, OrderStatus.APPROVED, 'system');

    await orders.releasePayout(orderId);
    await orders.releasePayout(orderId); // second call is a no-op

    const count = await prisma.payout.count({ where: { orderId } });
    expect(count).toBe(1);
    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after!.status).toBe('COMPLETED');
  });

  // ============================================================
  // 6. approve() flows straight to COMPLETED with a Payout (mock)
  // ============================================================
  it('6. approve() on a SUBMITTED order flows through to COMPLETED + Payout (onboarded inspector)', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await driveToSubmitted(customer);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(res.body.status).toBe('COMPLETED');

    const payout = await prisma.payout.findUnique({ where: { orderId } });
    expect(payout!.status).toBe('paid');
    expect(payout!.amountCents).toBe(FARE.inspectorShareCents);
  });

  // ============================================================
  // 7. autoApproveOverdue() → APPROVED + Payout + COMPLETED
  // ============================================================
  it('7. autoApproveOverdue() on an overdue SUBMITTED order → COMPLETED + Payout', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await driveToSubmitted(customer);
    // Backdate autoApproveAt so the order is overdue.
    await prisma.order.update({
      where: { id: orderId },
      data: { autoApproveAt: new Date(Date.now() - 60_000) },
    });

    const res = await orders.autoApproveOverdue();
    expect(res.approved).toBeGreaterThanOrEqual(1);

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after!.status).toBe('COMPLETED');
    const payout = await prisma.payout.findUnique({ where: { orderId } });
    expect(payout!.status).toBe('paid');
    expect(payout!.amountCents).toBe(FARE.inspectorShareCents);
  });

  // ============================================================
  // 8. releasePayout when inspector NOT onboarded → pending + stays APPROVED
  // ============================================================
  it('8. releasePayout when inspector not onboarded → Payout pending, order stays APPROVED', async () => {
    const customer = await makeCustomer();
    // Dispatch requires an onboarded inspector, so seed onboarded then de-onboard
    // after assignment to simulate "lost" Stripe eligibility before release.
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await driveToSubmitted(customer);
    await orders.transition(orderId, OrderStatus.APPROVED, 'system');
    await prisma.inspectorProfile.update({
      where: { userId: inspector.userId },
      data: { stripeOnboarded: false, stripeAccountId: null },
    });

    await orders.releasePayout(orderId);

    const payout = await prisma.payout.findUnique({ where: { orderId } });
    expect(payout).toBeTruthy();
    expect(payout!.status).toBe('pending');
    expect(payout!.stripeTransferId).toBeNull();

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after!.status).toBe('APPROVED'); // not COMPLETED
  });

  // ============================================================
  // 9. GET /inspector/earnings → correct totals + list
  // ============================================================
  it('9. earnings returns pending/paid totals and the payout list', async () => {
    const customer1 = await makeCustomer();
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG);

    // Order A: paid payout.
    const a = await driveToSubmitted(customer1);
    await orders.transition(a.orderId, OrderStatus.APPROVED, 'system');
    await orders.releasePayout(a.orderId);

    // Order B: same inspector, but force a pending payout by seeding it directly
    // (de-onboard the inspector, approve, release → pending).
    const customer2 = await makeCustomer();
    const b = await createPaidOrder(customer2);
    // Accept as the same inspector (only one in range).
    await acceptPendingOffer(b.orderId);
    await orders.submitReportForOrder(b.orderId);
    await orders.transition(b.orderId, OrderStatus.APPROVED, 'system');
    await prisma.inspectorProfile.update({
      where: { userId: inspector.userId },
      data: { stripeOnboarded: false, stripeAccountId: null },
    });
    await orders.releasePayout(b.orderId);

    const res = await request(app.getHttpServer())
      .get('/api/v1/inspector/earnings')
      .set('Authorization', `Bearer ${inspector.token}`)
      .expect(200);

    expect(res.body.paidCents).toBe(FARE.inspectorShareCents);
    expect(res.body.pendingCents).toBe(FARE.inspectorShareCents);
    expect(Array.isArray(res.body.payouts)).toBe(true);
    expect(res.body.payouts.length).toBe(2);
    const statuses = res.body.payouts.map((p: { status: string }) => p.status).sort();
    expect(statuses).toEqual(['paid', 'pending']);
    for (const p of res.body.payouts) {
      expect(typeof p.orderId).toBe('string');
      expect(typeof p.amountCents).toBe('number');
      expect(typeof p.createdAt).toBe('string');
    }
  });

  // ============================================================
  // 10. account.updated webhook flips stripeOnboarded
  // ============================================================
  it('10. account.updated webhook (synthetic event) flips stripeOnboarded', async () => {
    const u = await registerUser(app, 'insp');
    createdUserIds.add(u.userId);
    const accountId = `acct_wh_${u.userId}`;
    await prisma.inspectorProfile.create({
      data: {
        userId: u.userId,
        baseAddress: '',
        stripeOnboarded: false,
        stripeAccountId: accountId,
      },
    });

    // Mock mode can't fake a signed webhook, so drive handleWebhook directly with
    // a synthetic event carrying a charges_enabled + details_submitted account.
    const event = {
      id: `evt_acct_${Date.now()}`,
      type: 'account.updated',
      account: accountId,
      data: {
        object: {
          id: accountId,
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        },
      },
    } as unknown as Parameters<PaymentsService['handleWebhook']>[0];

    await payments.handleWebhook(event);

    const profile = await prisma.inspectorProfile.findUnique({ where: { userId: u.userId } });
    expect(profile!.stripeOnboarded).toBe(true);

    // cleanup the synthetic webhook-event guard row
    await prisma.stripeWebhookEvent.deleteMany({ where: { id: event.id } });
  });

  // ============================================================
  // 11. charge.dispute.created webhook flags the order with a chargeback event
  // ============================================================
  it('11. charge.dispute.created webhook flags the order (chargeback OrderEvent)', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);

    // Attach a synthetic PaymentIntent id to the order's payment so the handler
    // can map the dispute's PI back to the order.
    const piId = `pi_dispute_${Date.now()}`;
    await prisma.payment.update({
      where: { orderId },
      data: { stripePaymentIntentId: piId },
    });

    const event = {
      id: `evt_disp_${Date.now()}`,
      type: 'charge.dispute.created',
      data: { object: { object: 'dispute', payment_intent: piId } },
    } as unknown as Parameters<PaymentsService['handleWebhook']>[0];

    await payments.handleWebhook(event);

    const flagged = await prisma.orderEvent.findFirst({
      where: { orderId, type: 'chargeback' },
    });
    expect(flagged).toBeTruthy();

    await prisma.stripeWebhookEvent.deleteMany({ where: { id: event.id } });
  });

  // ============================================================
  // BE-S9 — a failed payout must be retryable, visible and alerted
  // ============================================================
  describe('BE-S9: stuck payout retry', () => {
    /** Approve an order with a de-onboarded inspector, so the payout parks. */
    async function stuckPayout(): Promise<{ orderId: string; inspectorId: string }> {
      const customer = await makeCustomer();
      const inspector = await makeInspector(ORDER_LAT, ORDER_LNG);
      const { orderId } = await driveToSubmitted(customer);
      await orders.transition(orderId, OrderStatus.APPROVED, 'system');
      await prisma.inspectorProfile.update({
        where: { userId: inspector.userId },
        data: { stripeOnboarded: false, stripeAccountId: null },
      });
      await orders.releasePayout(orderId);
      return { orderId, inspectorId: inspector.userId };
    }

    it('12. parking a payout records an attempt, a reason and a retry time', async () => {
      const { orderId } = await stuckPayout();
      const payout = await prisma.payout.findUnique({ where: { orderId } });

      expect(payout!.status).toBe('pending');
      expect(payout!.attempts).toBe(1);
      expect(payout!.lastError).toContain('not onboarded');
      expect(payout!.lastAttemptAt).toBeTruthy();
      // First backoff step is five minutes.
      const delayMs = payout!.nextRetryAt!.getTime() - Date.now();
      expect(delayMs).toBeGreaterThan(4 * 60_000);
      expect(delayMs).toBeLessThan(6 * 60_000);
    });

    it('13. the inspector is told once, and admins are alerted', async () => {
      const { inspectorId } = await stuckPayout();

      const delayed = await prisma.notification.findFirst({
        where: { userId: inspectorId, type: 'payout.delayed' },
      });
      expect(delayed).toBeTruthy();

      const adminAlerts = await prisma.notification.count({ where: { type: 'payout.failed' } });
      expect(adminAlerts).toBeGreaterThan(0);
    });

    it('14. a second failure increments attempts without creating a second row', async () => {
      const { orderId } = await stuckPayout();
      await orders.releasePayout(orderId);

      const rows = await prisma.payout.findMany({ where: { orderId } });
      expect(rows.length).toBe(1); // orderId is unique — the retry must UPDATE
      expect(rows[0].attempts).toBe(2);

      // No second inspector notification: one "your money is late" is enough.
      // Counted on the inapp channel only — each notify() also writes an email row.
      const delayed = await prisma.notification.count({
        where: { type: 'payout.delayed', channel: 'inapp' },
      });
      expect(delayed).toBe(1);
    });

    it('15. the cron settles a payout once the inspector is onboarded again', async () => {
      const { orderId, inspectorId } = await stuckPayout();

      await prisma.inspectorProfile.update({
        where: { userId: inspectorId },
        data: { stripeOnboarded: true, stripeAccountId: `acct_fixed_${inspectorId}` },
      });
      // Make the backoff due.
      await prisma.payout.update({
        where: { orderId },
        data: { nextRetryAt: new Date(Date.now() - 1000) },
      });

      const { retried, settled } = await orders.retryStuckPayouts();
      expect(retried).toBeGreaterThanOrEqual(1);
      expect(settled).toBeGreaterThanOrEqual(1);

      const payout = await prisma.payout.findUnique({ where: { orderId } });
      expect(payout!.status).toBe('paid');
      expect(payout!.nextRetryAt).toBeNull();
      expect(await prisma.payout.count({ where: { orderId } })).toBe(1);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe('COMPLETED');
    });

    it('16. the cron ignores payouts whose backoff has not elapsed', async () => {
      const { orderId, inspectorId } = await stuckPayout();
      await prisma.inspectorProfile.update({
        where: { userId: inspectorId },
        data: { stripeOnboarded: true, stripeAccountId: `acct_fixed_${inspectorId}` },
      });
      // nextRetryAt is ~5 minutes out and untouched.
      await orders.retryStuckPayouts();

      const payout = await prisma.payout.findUnique({ where: { orderId } });
      expect(payout!.status).toBe('pending');
    });

    it('17. a payout at the attempt cap goes terminal and stops retrying', async () => {
      const { orderId } = await stuckPayout();
      await prisma.payout.update({
        where: { orderId },
        data: { attempts: 5, nextRetryAt: new Date(Date.now() - 1000) },
      });

      await orders.releasePayout(orderId);
      const payout = await prisma.payout.findUnique({ where: { orderId } });
      expect(payout!.status).toBe('failed');
      expect(payout!.attempts).toBe(6);
      expect(payout!.nextRetryAt).toBeNull(); // terminal — needs a human

      const { retried } = await orders.retryStuckPayouts();
      expect(retried).toBe(0);
    });

    it('18. an admin can force a retry past the cap', async () => {
      const { orderId, inspectorId } = await stuckPayout();
      await prisma.payout.update({
        where: { orderId },
        data: { attempts: 6, status: 'failed', nextRetryAt: null },
      });
      await prisma.inspectorProfile.update({
        where: { userId: inspectorId },
        data: { stripeOnboarded: true, stripeAccountId: `acct_fixed_${inspectorId}` },
      });

      const payout = await orders.adminRetryPayout(orderId);
      expect(payout!.status).toBe('paid');
    });

    it('19. an admin can settle a payout out of band', async () => {
      const { orderId } = await stuckPayout();
      const payout = await orders.adminMarkPayoutPaid(orderId, 'SEPA ref 88213');

      expect(payout.status).toBe('paid');
      expect(payout.lastError).toContain('SEPA ref 88213');
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order!.status).toBe('COMPLETED');
    });

    it('20. the payout queue lists retry state for operators', async () => {
      const { orderId } = await stuckPayout();
      const queue = await orders.listPayouts('pending');

      const row = queue.items.find((i) => i.orderId === orderId);
      expect(row).toBeTruthy();
      expect(row!.attempts).toBe(1);
      expect(row!.lastError).toBeTruthy();
      expect(row!.nextRetryAt).toBeTruthy();
      expect(row!.orderNumber).toMatch(/^ORD-/);
    });
  });
});
