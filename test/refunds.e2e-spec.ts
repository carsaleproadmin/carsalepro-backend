import { INestApplication } from '@nestjs/common';
import { OrderStatus, Role } from '@prisma/client';
import request from 'supertest';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentsService } from '../src/payments/payments.service';
import { StripeEvent, StripeService, StripeTransfer } from '../src/payments/stripe.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeStripeService } from './helpers/fake-stripe';
import { createTestApp, uniqueDeviceId } from './helpers/test-app';
import { PinnedTariff, colocatedQuote, pinTariff } from './helpers/tariff';

/**
 * F-14 — refunds, the webhook claim lock, and entitlement revocation.
 *
 * This is the first suite to run with Stripe REPORTING ITSELF AS CONFIGURED.
 * `StripeService.onModuleInit` forces mock mode under `NODE_ENV=test`, so every
 * `if (this.stripe.configured)` branch in the codebase — the refund call, the
 * transfer, manual-capture's hold release — had never executed in a test. The
 * whole point of the cases below is to drive those branches, so they swap in
 * {@link FakeStripeService} through `createTestApp`'s override hook.
 *
 * Consequence to keep in mind while reading: an order created here does NOT
 * settle itself the way it does in mock mode. It stays CREATED with a pending
 * payment until `payOrder` confirms, captures and delivers the webhook — which
 * is what actually happens in production, and is precisely the state in which
 * "cancel an order nobody has paid for" used to answer 500.
 */

const ORDER_LAT = 52.52;
const ORDER_LNG = 13.405;
const SCHEDULED_AT = '2026-07-01T09:00:00.000Z';
const PASSWORD = 'Sup3rSecret!';

function uniqueEmail(prefix = 'ref'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

let codeCounter = 0;
function uniqueReportCode(): string {
  codeCounter = (codeCounter + 1) % 1_000_000;
  return `CSP-${Date.now().toString().slice(-3)}${codeCounter}`.slice(0, 10);
}

/** Valid ISO 3779 VIN (no I/O/Q), unique per run so the provider cache is cold. */
function uniqueVin(seed = ''): string {
  const rand = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${seed}`
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[IOQ]/g, 'X');
  return `WAU${(rand + 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789').slice(0, 14)}`
    .slice(0, 17)
    .padEnd(17, '0');
}

interface Registered {
  token: string;
  userId: string;
  email: string;
}

describe('Refunds, webhook lock and entitlement revocation (e2e, Stripe configured)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let payments: PaymentsService;
  const stripe = new FakeStripeService();

  const createdOrderIds = new Set<string>();
  const createdUserIds = new Set<string>();
  const createdWaitlistEmails = new Set<string>();
  const createdReportIds = new Set<string>();
  const createdEventIds = new Set<string>();
  const createdVins = new Set<string>();
  const inspectorTokens = new Map<string, string>();

  const FARE = colocatedQuote();
  let tariff: PinnedTariff;

  beforeAll(async () => {
    app = await createTestApp([{ token: StripeService, useValue: stripe }]);
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    payments = app.get(PaymentsService);
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
    if (createdEventIds.size) {
      await prisma.stripeWebhookEvent.deleteMany({ where: { id: { in: [...createdEventIds] } } });
    }
    if (createdVins.size) {
      await prisma.vinHistoryReport.deleteMany({ where: { vin: { in: [...createdVins] } } });
    }
    if (createdWaitlistEmails.size) {
      await prisma.waitlistEntry.deleteMany({
        where: { email: { in: [...createdWaitlistEmails] } },
      });
    }
    const userIds = [...createdUserIds];
    if (userIds.length) {
      await prisma.adminAuditLog.deleteMany({ where: { adminId: { in: userIds } } });
      await prisma.refund.deleteMany({
        where: { payment: { userId: { in: userIds } } },
      });
      await prisma.reportPurchase.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.vinHistoryPurchase.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.payout.deleteMany({ where: { inspectorId: { in: userIds } } });
      await prisma.orderOffer.deleteMany({ where: { inspectorId: { in: userIds } } });
      await prisma.inspectorProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.verificationToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.deviceLink.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (createdReportIds.size) {
      await prisma.report.deleteMany({ where: { id: { in: [...createdReportIds] } } });
    }

    createdOrderIds.clear();
    createdUserIds.clear();
    createdWaitlistEmails.clear();
    createdReportIds.clear();
    createdEventIds.clear();
    createdVins.clear();
    inspectorTokens.clear();
    stripe.reset();
  });

  afterAll(async () => {
    await tariff.restore();
    await app.close();
  });

  // ============================================================
  // Helpers
  // ============================================================

  async function registerUser(prefix = 'cust'): Promise<Registered> {
    const email = uniqueEmail(prefix);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, gdprConsent: true })
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
    createdWaitlistEmails.add(u.email);
    await prisma.user.update({ where: { id: u.userId }, data: { role: Role.ADMIN } });
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: u.email, password: PASSWORD })
      .expect(200);
    return { token: res.body.token as string, userId: u.userId, email: u.email };
  }

  async function makeInspector(): Promise<Registered> {
    const u = await registerUser('insp');
    createdUserIds.add(u.userId);
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
        stripeAccountId: `acct_seed_${u.userId}`,
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

  /** Create an order. With Stripe configured it stays CREATED, payment pending. */
  async function createOrder(customer: Registered): Promise<string> {
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

  async function paymentIntentIdFor(orderId: string): Promise<string> {
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    if (!payment.stripePaymentIntentId) throw new Error(`Order ${orderId} has no PaymentIntent`);
    return payment.stripePaymentIntentId;
  }

  /**
   * The customer pays: card entered (confirm), funds taken (capture), Stripe
   * tells us so (webhook). Capture is explicit because the fake defaults every
   * intent to manual capture — Wave 3's shape — so "confirmed" is a HOLD, and a
   * hold is not refundable.
   */
  async function payOrder(orderId: string): Promise<string> {
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    const piId = payment.stripePaymentIntentId as string;
    stripe.confirm(piId);
    await stripe.capturePaymentIntent(piId, payment.id);
    const event = stripe.paymentIntentSucceeded(piId);
    createdEventIds.add(event.id);
    await payments.handleWebhook(event);
    return piId;
  }

  async function createPaidOrder(customer: Registered): Promise<string> {
    const orderId = await createOrder(customer);
    await payOrder(orderId);
    return orderId;
  }

  async function acceptPendingOffer(orderId: string): Promise<string> {
    const offer = await prisma.orderOffer.findFirstOrThrow({
      where: { orderId, status: 'PENDING' },
    });
    const token = inspectorTokens.get(offer.inspectorId);
    if (!token) throw new Error(`No token for inspector ${offer.inspectorId}`);
    await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return offer.inspectorId;
  }

  async function seedReport(userId?: string) {
    const deviceId = uniqueDeviceId();
    const code = uniqueReportCode();
    const report = await prisma.report.create({
      data: {
        deviceId,
        code,
        s3Key: `free/${deviceId}/${code}.pdf`,
        tier: 'free',
        uploaded: true,
        userId: userId ?? null,
        make: 'BMW',
        model: '320d',
        year: 2018,
        qualityScore: 87,
        reportData: { checklist: { brakes: 'ok' }, damages: [] },
      },
    });
    createdReportIds.add(report.id);
    return report;
  }

  /** Deliver a `checkout.session.completed` for a payment, the way Stripe would. */
  async function completeCheckout(
    paymentId: string,
    metadata: Record<string, string>,
  ): Promise<void> {
    const event = stripe.event('checkout.session.completed', {
      id: `cs_fake_${paymentId}`,
      object: 'checkout.session',
      payment_intent: null,
      metadata: { paymentId, ...metadata },
    });
    createdEventIds.add(event.id);
    await payments.handleWebhook(event);
  }

  function eventsOfType(orderId: string, type: string) {
    return prisma.orderEvent.findMany({ where: { orderId, type } });
  }

  // ============================================================
  // 1. The defect itself: cancelling an order nobody paid for
  // ============================================================
  describe('an unpaid order', () => {
    it('1. cancels with 200 and no Refund row — the provider is never called', async () => {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createOrder(customer);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.CREATED);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
      expect(payment.status).toBe('pending');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      expect(res.body.status).toBe('CANCELLED');
      // Nothing was taken, so nothing is owed. This used to be a 500.
      expect(res.body.refundCents).toBe(0);

      expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
      expect(stripe.countCalls('refund')).toBe(0);

      const skipped = await eventsOfType(orderId, 'refund_skipped');
      expect(skipped).toHaveLength(1);
      expect(skipped[0].payload).toMatchObject({
        reason: 'cancel_before_assign',
        paymentStatus: 'pending',
      });
    });

    it('2. cancels even when the order has no payment row at all', async () => {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createOrder(customer);
      await prisma.payment.deleteMany({ where: { orderId } });

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
      const skipped = await eventsOfType(orderId, 'refund_skipped');
      expect(skipped[0].payload).toMatchObject({ detail: 'order has no payment' });
    });
  });

  // ============================================================
  // 2. A captured payment really is refunded
  // ============================================================
  describe('a captured payment', () => {
    it('3. cancel refunds through Stripe and records a succeeded Refund', async () => {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createPaidOrder(customer);
      const piId = await paymentIntentIdFor(orderId);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);
      expect(res.body.refundCents).toBe(FARE.totalCents);

      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.status).toBe('succeeded');
      expect(refund.reason).toBe('cancel_before_assign');
      expect(refund.amountCents).toBe(FARE.totalCents);
      expect(refund.stripeRefundId).toMatch(/^re_fake_/);
      expect(refund.nextRetryAt).toBeNull();
      expect(refund.lastError).toBeNull();

      expect(stripe.refundsFor(piId)).toHaveLength(1);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
      expect(payment.status).toBe('refunded');
    });

    it('4. cancelling after assignment refunds the reduced percentage', async () => {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createPaidOrder(customer);
      await acceptPendingOffer(orderId);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      const expected = Math.round(FARE.totalCents * 0.8);
      expect(res.body.refundCents).toBe(expected);
      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.reason).toBe('cancel_after_assign');
      expect(refund.amountCents).toBe(expected);
      expect(refund.status).toBe('succeeded');
    });

    it('5. settling the same (order, reason) twice refunds once', async () => {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createPaidOrder(customer);
      const piId = await paymentIntentIdFor(orderId);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

      const first = await orders.settleRefund(order, 1000, 'admin');
      const second = await orders.settleRefund(order, 1000, 'admin');

      expect(first.status).toBe('refunded');
      expect(second.status).toBe('refunded');
      // @@unique([orderId, reason]) makes settleRefund an upsert; the second call
      // must not mint a second row NOR hand the customer their money twice.
      expect(await prisma.refund.count({ where: { orderId } })).toBe(1);
      expect(stripe.refundsFor(piId)).toHaveLength(1);
    });
  });

  // ============================================================
  // 3. A refused refund parks, retries, and never blocks the transition
  // ============================================================
  describe('a refund Stripe refuses', () => {
    /** A paid, cancelled order whose refund the provider rejected once. */
    async function parkedRefund(
      spec: { type: string; code?: string; statusCode?: number } = {
        type: 'StripeAPIError',
        statusCode: 500,
      },
    ): Promise<{ orderId: string; customer: Registered }> {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createPaidOrder(customer);
      stripe.failNext('refund', spec);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      return { orderId, customer };
    }

    it('6. parks the refund with a backoff and STILL cancels the order', async () => {
      const { orderId } = await parkedRefund();

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.CANCELLED);

      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.status).toBe('pending');
      expect(refund.attempts).toBe(1);
      expect(refund.stripeRefundId).toBeNull(); // nullable for exactly this
      expect(refund.lastError).toBeTruthy();
      const delayMs = refund.nextRetryAt!.getTime() - Date.now();
      expect(delayMs).toBeGreaterThan(4 * 60_000);
      expect(delayMs).toBeLessThan(6 * 60_000);

      // The payment is NOT marked refunded — the money did not move.
      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
      expect(payment.status).toBe('succeeded');

      const failedEvents = await eventsOfType(orderId, 'refund_failed');
      expect(failedEvents).toHaveLength(1);
    });

    it('7. alerts every admin the first time it parks', async () => {
      const admin = await makeAdmin();
      await parkedRefund();

      const alert = await prisma.notification.findFirst({
        where: { userId: admin.userId, type: 'refund.failed', channel: 'inapp' },
      });
      expect(alert).toBeTruthy();
      expect(alert!.payload).toMatchObject({ terminal: false, attempts: 1 });
    });

    it('8. the cron retries it and settles it', async () => {
      const { orderId } = await parkedRefund();
      await prisma.refund.updateMany({
        where: { orderId },
        data: { nextRetryAt: new Date(Date.now() - 1000) },
      });

      const { retried, settled } = await orders.retryStuckRefunds();
      expect(retried).toBeGreaterThanOrEqual(1);
      expect(settled).toBeGreaterThanOrEqual(1);

      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.status).toBe('succeeded');
      expect(refund.attempts).toBe(2);
      expect(refund.nextRetryAt).toBeNull();
      expect(refund.stripeRefundId).toMatch(/^re_fake_/);
      // One row, still. The retry updates; it never inserts a second refund.
      expect(await prisma.refund.count({ where: { orderId } })).toBe(1);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
      expect(payment.status).toBe('refunded');
    });

    it('9. the cron leaves a refund whose backoff has not elapsed alone', async () => {
      const { orderId } = await parkedRefund();
      await orders.retryStuckRefunds();
      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.status).toBe('pending');
      expect(refund.attempts).toBe(1);
    });

    it('10. a permanent Stripe error goes terminal at once instead of retrying for three days', async () => {
      const { orderId } = await parkedRefund({
        type: 'StripeCardError',
        code: 'card_declined',
      });

      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.status).toBe('failed');
      expect(refund.attempts).toBe(1);
      expect(refund.nextRetryAt).toBeNull();
      expect(refund.lastError).toContain('permanent:');

      // Terminal means the cron will not touch it — a human must.
      const { retried } = await orders.retryStuckRefunds();
      expect(retried).toBe(0);
    });

    it('11. an operator can force a terminal refund through, past the cap', async () => {
      const { orderId } = await parkedRefund({ type: 'StripeCardError', code: 'card_declined' });
      const parked = await prisma.refund.findFirstOrThrow({ where: { orderId } });

      const retried = await orders.adminRetryRefund(parked.id);
      expect(retried!.status).toBe('succeeded');
      expect(retried!.stripeRefundId).toMatch(/^re_fake_/);
    });

    it('12. a refund at the attempt cap stops retrying by itself', async () => {
      const { orderId } = await parkedRefund();
      await prisma.refund.updateMany({
        where: { orderId },
        data: { attempts: 5, nextRetryAt: new Date(Date.now() - 1000) },
      });
      stripe.failNext('refund', { type: 'StripeAPIError', statusCode: 500 });

      await orders.retryStuckRefunds();

      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.attempts).toBe(6);
      expect(refund.status).toBe('failed');
      expect(refund.nextRetryAt).toBeNull();

      const { retried } = await orders.retryStuckRefunds();
      expect(retried).toBe(0);
    });

    it('13. a refund that is no longer owed leaves the queue instead of looping for ever', async () => {
      const { orderId } = await parkedRefund();
      // A chargeback settled it behind our back: the payment is already refunded.
      await prisma.payment.updateMany({ where: { orderId }, data: { status: 'refunded' } });
      await prisma.refund.updateMany({
        where: { orderId },
        data: { nextRetryAt: new Date(Date.now() - 1000) },
      });

      await orders.retryStuckRefunds();

      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.nextRetryAt).toBeNull();
      expect(refund.lastError).toContain('skipped:');
      const second = await orders.retryStuckRefunds();
      expect(second.retried).toBe(0);
    });

    it('14. the admin finance queue shows it, and its retry endpoint settles it', async () => {
      const admin = await makeAdmin();
      const { orderId } = await parkedRefund();

      const queue = await request(app.getHttpServer())
        .get('/api/v1/admin/finance/refunds?status=pending')
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);

      const row = queue.body.items.find((i: { orderId: string }) => i.orderId === orderId);
      expect(row).toBeTruthy();
      expect(row.attempts).toBe(1);
      expect(row.lastError).toBeTruthy();
      expect(row.nextRetryAt).toBeTruthy();
      expect(row.orderNumber).toMatch(/^ORD-/);
      expect(row.amountCents).toBe(FARE.totalCents);

      const retried = await request(app.getHttpServer())
        .post(`/api/v1/admin/finance/refunds/${row.id}/retry`)
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(retried.body.status).toBe('succeeded');
    });

    it('15. the refund queue is admin-only', async () => {
      const customer = await makeCustomer();
      await request(app.getHttpServer())
        .get('/api/v1/admin/finance/refunds')
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(403);
      await request(app.getHttpServer()).get('/api/v1/admin/finance/refunds').expect(401);
    });
  });

  // ============================================================
  // 4. Disputes close whatever the money does
  // ============================================================
  describe('dispute resolution', () => {
    async function disputedOrder(): Promise<{ orderId: string; customer: Registered }> {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createPaidOrder(customer);
      await acceptPendingOffer(orderId);
      await orders.submitReportForOrder(orderId);
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/dispute`)
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ reason: 'The inspection never happened' })
        .expect(200);
      return { orderId, customer };
    }

    it('16. resolves in the customer favour and refunds', async () => {
      const admin = await makeAdmin();
      const { orderId } = await disputedOrder();

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/resolve-dispute`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ resolution: 'customer', refundPercent: 100 })
        .expect(200);

      expect(res.body.status).toBe('REFUNDED');
      expect(res.body.refundCents).toBe(FARE.totalCents);
      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.status).toBe('succeeded');
      expect(refund.reason).toBe('dispute');
      const dispute = await prisma.dispute.findUniqueOrThrow({ where: { orderId } });
      expect(dispute.status).toBe('RESOLVED_CUSTOMER');
    });

    it('17. CLOSES THE DISPUTE even when the refund fails', async () => {
      const admin = await makeAdmin();
      const { orderId } = await disputedOrder();
      stripe.failNext('refund', { type: 'StripeAPIError', statusCode: 500 });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/resolve-dispute`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ resolution: 'customer', refundPercent: 100 })
        .expect(200);

      // The order moves and the dispute closes. Before this, the refund threw
      // out of the method: the dispute stayed OPEN in the admin queue for ever
      // while the order sat in DISPUTED, and re-resolving it hit the same error.
      expect(res.body.status).toBe('REFUNDED');
      const dispute = await prisma.dispute.findUniqueOrThrow({ where: { orderId } });
      expect(dispute.status).toBe('RESOLVED_CUSTOMER');
      expect(dispute.resolvedAt).toBeTruthy();

      // The money is not forgotten either: it is parked and retryable.
      const refund = await prisma.refund.findFirstOrThrow({ where: { orderId } });
      expect(refund.status).toBe('pending');
      expect(refund.nextRetryAt).toBeTruthy();
      expect(res.body.refundCents).toBe(FARE.totalCents);
    });
  });

  // ============================================================
  // 5. An authorization hold is released, not "refunded"
  // ============================================================
  it('18. releasing a hold cancels the intent and writes NO Refund row', async () => {
    const customer = await makeCustomer();
    await makeInspector();
    const orderId = await createOrder(customer);
    const piId = await paymentIntentIdFor(orderId);

    // Wave 3 reaches this state through manual capture; here we put the payment
    // in it directly, so the branch the two waves must compose on is executable
    // today rather than on trust.
    stripe.confirm(piId);
    await prisma.payment.update({
      where: { orderId },
      data: { status: 'authorized', authorizedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refundCents).toBe(0);
    // A Refund row means money went back. An uncaptured hold never left the
    // customer, so recording one would double-count it in the finance ledger.
    expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
    expect(stripe.countCalls('refund')).toBe(0);
    expect(stripe.countCalls('cancel', piId)).toBe(1);
    expect(stripe.intent(piId)!.status).toBe('canceled');

    const released = await eventsOfType(orderId, 'authorization_released');
    expect(released).toHaveLength(1);
    expect(released[0].payload).toMatchObject({ released: true });

    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
    expect(payment.status).toBe('cancelled');
    expect(payment.canceledAt).toBeTruthy();
  });

  // ============================================================
  // 6. The webhook claim lock
  // ============================================================
  describe('webhook claim/complete lock', () => {
    function spyOnHandler() {
      return jest.spyOn(
        payments as unknown as { processWebhook: (event: StripeEvent) => Promise<void> },
        'processWebhook',
      );
    }

    it('19. two concurrent deliveries of one event run the handler exactly once', async () => {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createOrder(customer);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
      const piId = payment.stripePaymentIntentId as string;
      stripe.confirm(piId);
      await stripe.capturePaymentIntent(piId, payment.id);

      const event = stripe.paymentIntentSucceeded(piId);
      createdEventIds.add(event.id);
      const spy = spyOnHandler();
      try {
        // Both deliveries are in flight before either has finished: the old
        // "look for a row, then process, then write the row" found no row twice
        // and settled the same PaymentIntent twice.
        await Promise.all([payments.handleWebhook(event), payments.handleWebhook(event)]);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }

      const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(row.status).toBe('processed');
      expect(row.attempts).toBe(1);

      // And the effect happened once.
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.PAID);
    });

    it('20. a replay after completion is a no-op', async () => {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createOrder(customer);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId } });
      const piId = payment.stripePaymentIntentId as string;
      stripe.confirm(piId);
      await stripe.capturePaymentIntent(piId, payment.id);

      // The SAME event object twice — a replay is one Stripe event id delivered
      // again, not a second event about the same intent.
      const event = stripe.paymentIntentSucceeded(piId);
      createdEventIds.add(event.id);
      await payments.handleWebhook(event); // first delivery

      const spy = spyOnHandler();
      try {
        await payments.handleWebhook(event); // replay
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('21. a failed handler releases its claim so Stripe’s retry can re-run it', async () => {
      const event = stripe.event('account.updated', {
        id: 'acct_never_seen',
        object: 'account',
        charges_enabled: true,
        details_submitted: true,
      });
      createdEventIds.add(event.id);

      const spy = spyOnHandler().mockRejectedValueOnce(new Error('boom'));
      try {
        await expect(payments.handleWebhook(event)).rejects.toThrow('boom');
      } finally {
        spy.mockRestore();
      }

      // No claim left behind — otherwise our own lock would swallow the retry
      // that Stripe is guaranteed to send after our 500.
      expect(await prisma.stripeWebhookEvent.findUnique({ where: { id: event.id } })).toBeNull();

      await payments.handleWebhook(event);
      const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(row.status).toBe('processed');
    });

    it('22. a stale claim may be stolen, so a dead process cannot wedge an event', async () => {
      const id = `evt_stale_${Date.now()}`;
      createdEventIds.add(id);
      await prisma.stripeWebhookEvent.create({
        data: {
          id,
          type: 'account.updated',
          status: 'claimed',
          claimedAt: new Date(Date.now() - 10 * 60_000),
          attempts: 1,
        },
      });

      const event = stripe.event(
        'account.updated',
        { id: 'acct_never_seen', object: 'account' },
        id,
      );
      const spy = spyOnHandler();
      try {
        await payments.handleWebhook(event);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }

      const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('processed');
      expect(row.attempts).toBe(2);
    });

    it('23. a FRESH claim is not stolen — the other delivery still owns it', async () => {
      const id = `evt_fresh_${Date.now()}`;
      createdEventIds.add(id);
      await prisma.stripeWebhookEvent.create({
        data: {
          id,
          type: 'account.updated',
          status: 'claimed',
          claimedAt: new Date(),
          attempts: 1,
        },
      });

      const event = stripe.event('account.updated', { id: 'acct_x', object: 'account' }, id);
      const spy = spyOnHandler();
      try {
        await payments.handleWebhook(event);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ============================================================
  // 7. A refund takes the access with it
  // ============================================================
  describe('entitlement revocation', () => {
    it('24. a refunded pay-per-view purchase is denied, and can be bought again', async () => {
      const buyer = await makeCustomer();
      const report = await seedReport();

      // Buy it.
      const checkout = await request(app.getHttpServer())
        .post('/api/v1/payments/ppv')
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({ reportCode: report.code })
        .expect(201);
      expect(typeof checkout.body.checkoutUrl).toBe('string');

      const firstPayment = await prisma.payment.findFirstOrThrow({
        where: { userId: buyer.userId, purpose: 'ppv' },
        orderBy: { createdAt: 'desc' },
      });
      await completeCheckout(firstPayment.id, {
        reportId: report.id,
        userId: buyer.userId,
        purpose: 'ppv',
      });

      await request(app.getHttpServer())
        .get(`/api/v1/reports/${report.id}/full`)
        .set('Authorization', `Bearer ${buyer.token}`)
        .expect(200);

      // Refund it — as a chargeback webhook would.
      await payments.markPaymentRefunded(firstPayment.id);

      const revoked = await prisma.reportPurchase.findUniqueOrThrow({
        where: { userId_reportId: { userId: buyer.userId, reportId: report.id } },
      });
      expect(revoked.revokedAt).toBeTruthy();
      expect(revoked.revokedReason).toBe('payment_refunded');

      await request(app.getHttpServer())
        .get(`/api/v1/reports/${report.id}/full`)
        .set('Authorization', `Bearer ${buyer.token}`)
        .expect(403);

      const purchases = await request(app.getHttpServer())
        .get('/api/v1/me/report-purchases')
        .set('Authorization', `Bearer ${buyer.token}`)
        .expect(200);
      expect(
        purchases.body.items.find((i: { reportId: string }) => i.reportId === report.id),
      ).toBeUndefined();

      // Buy it AGAIN. @@unique([userId, reportId]) makes the row eternal, so
      // without reviving it a refund locked this buyer out of this report for
      // good: "already owned" on the way in, 403 on the way out.
      const second = await request(app.getHttpServer())
        .post('/api/v1/payments/ppv')
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({ reportCode: report.code })
        .expect(201);
      expect(second.body.alreadyOwned).toBeUndefined();
      expect(typeof second.body.checkoutUrl).toBe('string');

      const secondPayment = await prisma.payment.findFirstOrThrow({
        where: { userId: buyer.userId, purpose: 'ppv', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      expect(secondPayment.id).not.toBe(firstPayment.id);
      await completeCheckout(secondPayment.id, {
        reportId: report.id,
        userId: buyer.userId,
        purpose: 'ppv',
      });

      await request(app.getHttpServer())
        .get(`/api/v1/reports/${report.id}/full`)
        .set('Authorization', `Bearer ${buyer.token}`)
        .expect(200);

      const revived = await prisma.reportPurchase.findUniqueOrThrow({
        where: { userId_reportId: { userId: buyer.userId, reportId: report.id } },
      });
      expect(revived.revokedAt).toBeNull();
      expect(revived.paymentId).toBe(secondPayment.id);
      // Still exactly one row: the sale history, not a second entitlement.
      expect(
        await prisma.reportPurchase.count({ where: { userId: buyer.userId, reportId: report.id } }),
      ).toBe(1);
    });

    it('25. a report owner is unaffected by anyone else’s refund', async () => {
      const owner = await makeCustomer();
      const report = await seedReport(owner.userId);
      await request(app.getHttpServer())
        .get(`/api/v1/reports/${report.id}/full`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
    });

    it('26. a refunded VIN history is re-buyable — pinning behaviour we rely on', async () => {
      const buyer = await makeCustomer();
      const vin = uniqueVin('r');
      createdVins.add(vin);

      const first = await request(app.getHttpServer())
        .post(`/api/v1/vin-history/${vin}/unlock`)
        .set('Authorization', `Bearer ${buyer.token}`)
        .expect(201);
      const purchaseId = first.body.purchaseId as string;

      const firstPayment = await prisma.payment.findFirstOrThrow({
        where: { userId: buyer.userId, purpose: 'vin_history' },
        orderBy: { createdAt: 'desc' },
      });
      await completeCheckout(firstPayment.id, { purchaseId, vin, purpose: 'vin_history' });
      expect(
        (await prisma.vinHistoryPurchase.findUniqueOrThrow({ where: { id: purchaseId } })).status,
      ).toBe('ready');

      // Refund → the purchase is revoked by the same code path as a PPV report.
      await payments.markPaymentRefunded(firstPayment.id);
      expect(
        (await prisma.vinHistoryPurchase.findUniqueOrThrow({ where: { id: purchaseId } })).status,
      ).toBe('refunded');

      // And it can be bought again: `unlock` reopens everything but `ready`, and
      // `reusableOrNewPayment` refuses to reuse a refunded payment.
      const second = await request(app.getHttpServer())
        .post(`/api/v1/vin-history/${vin}/unlock`)
        .set('Authorization', `Bearer ${buyer.token}`)
        .expect(201);
      expect(second.body.purchaseId).toBe(purchaseId); // same row, unique (user, vin)
      expect(second.body.alreadyOwned).toBeFalsy();

      const secondPayment = await prisma.payment.findFirstOrThrow({
        where: { userId: buyer.userId, purpose: 'vin_history', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      expect(secondPayment.id).not.toBe(firstPayment.id);
      await completeCheckout(secondPayment.id, { purchaseId, vin, purpose: 'vin_history' });
      expect(
        (await prisma.vinHistoryPurchase.findUniqueOrThrow({ where: { id: purchaseId } })).status,
      ).toBe('ready');
    });
  });

  // ============================================================
  // 8. The two payout-queue bugs found in the same code
  // ============================================================
  describe('payout queue', () => {
    /** A parked payout on an order that can never pay out. */
    async function unpayablePayout(): Promise<{ orderId: string; inspectorId: string }> {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createPaidOrder(customer);
      const inspectorId = await acceptPendingOffer(orderId);
      await prisma.payout.create({
        data: {
          orderId,
          inspectorId,
          amountCents: FARE.inspectorShareCents,
          status: 'pending',
          attempts: 1,
          lastError: 'transfer failed',
          lastAttemptAt: new Date(),
          nextRetryAt: new Date(Date.now() - 1000),
        },
      });
      return { orderId, inspectorId };
    }

    it('27. the cron terminates a payout that can never settle instead of re-selecting it for ever', async () => {
      const { orderId } = await unpayablePayout();

      // The order is ASSIGNED, so releasePayout returns early — and used to
      // leave nextRetryAt in the past, which matched the due query on every run
      // from then on: an infinite, silent retry loop over a dead row.
      const first = await orders.retryStuckPayouts();
      expect(first.retried).toBeGreaterThanOrEqual(1);

      const payout = await prisma.payout.findUniqueOrThrow({ where: { orderId } });
      expect(payout.nextRetryAt).toBeNull();
      expect(payout.lastError).toContain('skipped:');
      expect(payout.lastError).toContain('ASSIGNED');

      const second = await orders.retryStuckPayouts();
      expect(second.retried).toBe(0);
    });

    it('28. a failed transfer parks through the shared schedule', async () => {
      const { orderId } = await unpayablePayout();
      await prisma.payout.update({
        where: { orderId },
        data: { status: 'paid', stripeTransferId: 'tr_fail_me', attempts: 1 },
      });

      await payments.failTransfer({ id: 'tr_fail_me' } as StripeTransfer);

      const payout = await prisma.payout.findUniqueOrThrow({ where: { orderId } });
      expect(payout.status).toBe('pending');
      expect(payout.attempts).toBe(2);
      expect(payout.stripeTransferId).toBeNull(); // freed for the retry
      expect(payout.nextRetryAt).toBeTruthy();
    });

    it('29. a failed transfer at the cap goes terminal instead of drifting past it', async () => {
      const { orderId } = await unpayablePayout();
      await prisma.payout.update({
        where: { orderId },
        data: { status: 'paid', stripeTransferId: 'tr_fail_capped', attempts: 5 },
      });

      await payments.failTransfer({ id: 'tr_fail_capped' } as StripeTransfer);

      const payout = await prisma.payout.findUniqueOrThrow({ where: { orderId } });
      expect(payout.attempts).toBe(6);
      // The bare `attempts: { increment: 1 }` this replaced left the row at 6+
      // with a nextRetryAt 15 minutes out — and the cron filters on
      // `attempts < 6`, so nothing would ever have honoured it.
      expect(payout.status).toBe('failed');
      expect(payout.nextRetryAt).toBeNull();
    });
  });
});
