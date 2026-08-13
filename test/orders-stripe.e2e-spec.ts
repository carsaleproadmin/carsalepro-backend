import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import request from 'supertest';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentsService } from '../src/payments/payments.service';
import { StripeService } from '../src/payments/stripe.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  currentRequiredAngles,
  thicknessPanelIds,
} from '../src/reports/report-completeness';
import { SettingsService } from '../src/settings/settings.service';
import { PLATFORM_SETTING_DEFAULTS } from '../src/settings/platform-settings.constants';
import { FakeStripeService } from './helpers/fake-stripe';
import {
  CompleteReportData,
  LEGACY_EXTERIOR_ANGLES_8,
  completeReportData,
  dropPhotoKind,
  legacyReportData,
} from './helpers/report-payload';
import { createTestApp, uniqueDeviceId } from './helpers/test-app';
import { PinnedTariff, colocatedQuote, pinTariff } from './helpers/tariff';

/**
 * Wave 3 — authorize now, capture when an inspector accepts.
 *
 * Until this shipped, the customer's card was CHARGED the instant the order was
 * created, before anyone had agreed to do the work: an order nobody accepted
 * left the platform sitting on real money it owed back. The ride-hailing model
 * replaces that with a HOLD, taken only at acceptance and released if the
 * search window runs out.
 *
 * Everything here runs with Stripe **reporting itself as configured**
 * ({@link FakeStripeService}), because every line that matters lives behind
 * `if (this.stripe.configured)`. The fake models the PaymentIntent lifecycle
 * manual capture turns into a state machine we depend on:
 *
 *   requires_payment_method --confirm--> requires_capture --capture--> succeeded
 *                                              |
 *                                            cancel
 *                                              v
 *                                           canceled
 *
 * Read `confirm()` as "the customer entered a card in the browser". There is no
 * counterpart on the real service — Stripe.js does it — which is exactly why the
 * webhook, not our own code, is what tells us a hold exists.
 */

const ORDER_LAT = 52.52;
const ORDER_LNG = 13.405;
const SCHEDULED_AT = '2026-07-01T09:00:00.000Z';
const PASSWORD = 'Sup3rSecret!';

function uniqueEmail(prefix = 'mc'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/**
 * `Report.code` is only partially unique (UUID-format codes), so a collision
 * with a leftover row from a sibling suite would silently attach the WRONG
 * report — `attachReportByCode` resolves by code, newest first. Random, not
 * sequential, for that reason.
 */
function uniqueReportCode(): string {
  // A real UUID v4, LOWERCASE. Both halves matter. `CSP-<8 base36 chars>` is
  // neither the legacy `CSP-<digits>` form nor the UUID form, so the attach DTO
  // rejected it with a 400 before the completeness gate could ever answer 409 —
  // the gate tests were asserting against a validation error. And the case is
  // the point of the whole report-code fix: the mobile app mints these from
  // Dart's `Uuid().v4()` in lower case, matching is literal, and a fixture that
  // shouts would quietly stop exercising what production actually stores.
  return `CSP-${randomUUID()}`;
}

interface Registered {
  token: string;
  userId: string;
  email: string;
}

describe('Manual capture: authorize → accept → capture (e2e, Stripe configured)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let payments: PaymentsService;
  let settings: SettingsService;
  const stripe = new FakeStripeService();

  const createdOrderIds = new Set<string>();
  const createdUserIds = new Set<string>();
  const createdWaitlistEmails = new Set<string>();
  const createdReportIds = new Set<string>();
  const createdEventIds = new Set<string>();
  const createdDeviceIds = new Set<string>();
  const inspectorTokens = new Map<string, string>();

  const FARE = colocatedQuote();
  /**
   * `minReportQualityScore` is no longer a threshold — since 2026-08-13 only its
   * sign is read: above zero the completeness gate runs, at zero it does not.
   * The name survived so no migration, seed or admin control had to change, and
   * it is still what `reportRequirement.minQualityScore` reports, which is why
   * this constant keeps it too. Nothing here compares a score to it.
   */
  const MIN_QUALITY = PLATFORM_SETTING_DEFAULTS.minReportQualityScore;
  let tariff: PinnedTariff;

  beforeAll(async () => {
    app = await createTestApp([{ token: StripeService, useValue: stripe }]);
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    payments = app.get(PaymentsService);
    settings = app.get(SettingsService);
    tariff = await pinTariff(app);
    // Sibling suites do not touch these two, but they are the levers this whole
    // file is about — pin them so an assertion means what it says.
    await settings.set('orderSearchWindowMinutes', PLATFORM_SETTING_DEFAULTS.orderSearchWindowMinutes);
    await settings.set('minReportQualityScore', MIN_QUALITY);
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
    if (createdReportIds.size) {
      await prisma.report.deleteMany({ where: { id: { in: [...createdReportIds] } } });
    }
    if (createdDeviceIds.size) {
      const deviceIds = [...createdDeviceIds];
      await prisma.report.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.deviceLink.deleteMany({ where: { deviceId: { in: deviceIds } } });
      await prisma.deviceQuota.deleteMany({ where: { deviceId: { in: deviceIds } } });
    }
    if (createdWaitlistEmails.size) {
      await prisma.waitlistEntry.deleteMany({
        where: { email: { in: [...createdWaitlistEmails] } },
      });
    }
    const userIds = [...createdUserIds];
    if (userIds.length) {
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
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
    createdReportIds.clear();
    createdEventIds.clear();
    createdDeviceIds.clear();
    inspectorTokens.clear();
    stripe.reset();
  });

  afterAll(async () => {
    await settings.set('minReportQualityScore', MIN_QUALITY);
    await settings.set('orderSearchWindowMinutes', PLATFORM_SETTING_DEFAULTS.orderSearchWindowMinutes);
    await tariff.restore();
    await app.close();
  });

  // ============================================================
  // Helpers
  // ============================================================

  async function registerUser(prefix: string): Promise<Registered> {
    const email = uniqueEmail(prefix);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, gdprConsent: true })
      .expect(201);
    const u = { token: res.body.token as string, userId: res.body.user.id as string, email };
    createdUserIds.add(u.userId);
    createdWaitlistEmails.add(u.email);
    return u;
  }

  async function makeCustomer(): Promise<Registered> {
    return registerUser('cust');
  }

  async function makeInspector(offsetDeg = 0): Promise<Registered> {
    const u = await registerUser('insp');
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
    const lat = ORDER_LAT + offsetDeg;
    await prisma.$executeRaw`
      UPDATE inspector_profile
      SET location = ST_SetSRID(ST_MakePoint(${ORDER_LNG}, ${lat}), 4326)::geography
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
    return res.body.orderId as string;
  }

  async function paymentFor(orderId: string) {
    return prisma.payment.findUniqueOrThrow({ where: { orderId } });
  }

  /**
   * The customer enters a card: the intent moves to `requires_capture` (a HOLD)
   * and Stripe tells us so. That webhook — not `payment_intent.succeeded` — is
   * what starts the inspector search under manual capture.
   */
  async function authorize(orderId: string): Promise<string> {
    const payment = await paymentFor(orderId);
    const piId = payment.stripePaymentIntentId as string;
    stripe.confirm(piId);
    const event = stripe.amountCapturableUpdated(piId);
    createdEventIds.add(event.id);
    await payments.handleWebhook(event);
    return piId;
  }

  async function pendingOfferFor(orderId: string) {
    return prisma.orderOffer.findFirst({ where: { orderId, status: 'PENDING' } });
  }

  async function acceptPendingOffer(orderId: string): Promise<string> {
    const offer = await prisma.orderOffer.findFirstOrThrow({
      where: { orderId, status: 'PENDING' },
    });
    const token = inspectorTokens.get(offer.inspectorId) as string;
    await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer.id}/accept`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return offer.inspectorId;
  }

  async function eventsOfType(orderId: string, type: string) {
    return prisma.orderEvent.findMany({ where: { orderId, type } });
  }

  /** Backdate a payment past the reconciler's five-minute grace period. */
  async function ageOutPayment(orderId: string): Promise<void> {
    await prisma.payment.update({
      where: { orderId },
      data: { createdAt: new Date(Date.now() - 30 * 60_000) },
    });
  }

  // ============================================================
  // 1. The happy path, end to end
  // ============================================================
  it('1. create holds the money, accept takes it', async () => {
    const customer = await makeCustomer();
    const inspector = await makeInspector();
    const orderId = await createOrder(customer);

    // --- created: an intent exists, but with MANUAL capture and nothing held ---
    let order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CREATED);
    expect(order.searchExpiresAt).toBeNull();
    let payment = await paymentFor(orderId);
    expect(payment.status).toBe('pending');
    const piId = payment.stripePaymentIntentId as string;
    expect(stripe.intent(piId)!.capture_method).toBe('manual');
    expect(stripe.countCalls('capture')).toBe(0);

    // --- the customer pays: a HOLD, not a charge ---
    stripe.confirm(piId);
    expect(stripe.intent(piId)!.status).toBe('requires_capture');
    expect(stripe.intent(piId)!.amount_capturable).toBe(FARE.totalCents);
    expect(stripe.intent(piId)!.amount_received).toBe(0);

    const event = stripe.amountCapturableUpdated(piId);
    createdEventIds.add(event.id);
    await payments.handleWebhook(event);

    order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    payment = await paymentFor(orderId);
    expect(order.status).toBe(OrderStatus.PAID);
    expect(payment.status).toBe('authorized');
    expect(payment.authorizedAt).toBeTruthy();
    // The money is still the customer's. Nothing has been taken.
    expect(payment.capturedAt).toBeNull();
    expect(stripe.countCalls('capture')).toBe(0);
    // A deadline exists now, and only now: the hold is what starts the clock.
    expect(order.searchExpiresAt).toBeTruthy();
    const windowMinutes = (order.searchExpiresAt!.getTime() - Date.now()) / 60_000;
    expect(Math.round(windowMinutes)).toBe(PLATFORM_SETTING_DEFAULTS.orderSearchWindowMinutes);

    const offer = await pendingOfferFor(orderId);
    expect(offer!.inspectorId).toBe(inspector.userId);

    // --- an inspector accepts: NOW the money moves ---
    await acceptPendingOffer(orderId);

    order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    payment = await paymentFor(orderId);
    expect(order.status).toBe(OrderStatus.ASSIGNED);
    expect(order.inspectorId).toBe(inspector.userId);
    expect(payment.status).toBe('succeeded');
    expect(payment.capturedAt).toBeTruthy();
    expect(stripe.countCalls('capture', piId)).toBe(1);
    expect(stripe.intent(piId)!.status).toBe('succeeded');
    expect(stripe.intent(piId)!.amount_received).toBe(FARE.totalCents);

    // The API contract the website reads.
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(detail.body.payment).toMatchObject({
      state: 'captured',
      amountCents: FARE.totalCents,
    });
    expect(detail.body.search.expiredAt).toBeNull();
    expect(detail.body.reportRequirement.minQualityScore).toBe(MIN_QUALITY);
  });

  it('1b. a redelivered amount_capturable_updated does not extend the deadline', async () => {
    const customer = await makeCustomer();
    await makeInspector();
    const orderId = await createOrder(customer);
    const piId = await authorize(orderId);

    const first = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    // Stripe redelivers. A NEW event id, so our dedupe lock does not swallow it
    // — this has to be idempotent on its own merits.
    const again = stripe.amountCapturableUpdated(piId);
    createdEventIds.add(again.id);
    await payments.handleWebhook(again);

    const second = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    // Re-authorizing must never push the deadline out: the expiry cron is
    // already counting down to it, and a hold that keeps renewing its own
    // countdown is a hold that never gets released.
    expect(second.searchExpiresAt!.getTime()).toBe(first.searchExpiresAt!.getTime());
    // And exactly one offer, not two.
    expect(await prisma.orderOffer.count({ where: { orderId } })).toBe(1);
  });

  // ============================================================
  // 2. Two inspectors, one order
  // ============================================================
  it('2. two inspectors accepting at once: one wins, one 409, one capture', async () => {
    const customer = await makeCustomer();
    const first = await makeInspector();
    const second = await makeInspector(0.02);
    const orderId = await createOrder(customer);
    const piId = await authorize(orderId);

    // Dispatch offers to one inspector at a time, but two live offers is a real
    // state: a redelivered authorize webhook or the reconciler can run dispatch
    // twice. The point of this case is that the CLAIM decides the winner, no
    // matter how two inspectors came to be holding an offer at once.
    const offerA = await prisma.orderOffer.findFirstOrThrow({ where: { orderId } });
    const otherId = offerA.inspectorId === first.userId ? second.userId : first.userId;
    const offerB = await prisma.orderOffer.create({
      data: {
        orderId,
        inspectorId: otherId,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const accept = (offerId: string, inspectorId: string) =>
      request(app.getHttpServer())
        .post(`/api/v1/offers/${offerId}/accept`)
        .set('Authorization', `Bearer ${inspectorTokens.get(inspectorId) as string}`);

    // Both in flight before either finishes. The previous implementation read
    // the order, then wrote `inspectorId` unguarded — both callers "won", the
    // second silently overwrote the first, and BOTH captures were attempted.
    const [resA, resB] = await Promise.all([
      accept(offerA.id, offerA.inspectorId),
      accept(offerB.id, otherId),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = resA.status === 409 ? resA : resB;
    // Which refusal depends on how far the loser got before the winner
    // committed: it lost the CLAIM (`already_assigned`), or the winner had
    // already retired its offer by the time it read the row (`offer_unavailable`).
    // Both are correct and both are 409; pinning one would make this case flake
    // on scheduling rather than on behaviour.
    expect(['already_assigned', 'offer_unavailable']).toContain(loser.body.error.code);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.ASSIGNED);
    const winnerId = resA.status === 200 ? offerA.inspectorId : otherId;
    expect(order.inspectorId).toBe(winnerId);

    // The loser's offer is retired rather than left PENDING, so the job stops
    // appearing in a list of work they can no longer take.
    expect(await pendingOfferFor(orderId)).toBeNull();

    // The invariant that actually costs money: the customer is charged once.
    expect(stripe.countCalls('capture', piId)).toBe(1);
    const payment = await paymentFor(orderId);
    expect(payment.status).toBe('succeeded');
    expect(payment.amountCents).toBe(FARE.totalCents);
  });

  // ============================================================
  // 3. A capture failure that may clear on its own
  // ============================================================
  it('3. a retryable capture failure returns the offer and leaves the hold intact', async () => {
    const customer = await makeCustomer();
    const inspector = await makeInspector();
    const orderId = await createOrder(customer);
    const piId = await authorize(orderId);
    const offer = await prisma.orderOffer.findFirstOrThrow({ where: { orderId } });

    // A dropped connection to Stripe: `classifyStripeError` calls this
    // retryable, and nothing about the order is wrong.
    stripe.failNext('capture', { type: 'StripeConnectionError', message: 'socket hang up' });

    const refused = await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer.id}/accept`)
      .set('Authorization', `Bearer ${inspector.token}`)
      .expect(503);
    expect(refused.body.error.code).toBe('payment_capture_unavailable');

    // Everything is exactly as it was: the order is back in the pool, the offer
    // is live again, and the customer's hold is untouched.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PAID);
    expect(order.inspectorId).toBeNull();
    const after = await prisma.orderOffer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(after.status).toBe('PENDING');
    const payment = await paymentFor(orderId);
    expect(payment.status).toBe('authorized');
    expect(payment.capturedAt).toBeNull();
    expect(stripe.intent(piId)!.status).toBe('requires_capture');
    // A retryable failure is not a cancellation: the hold must NOT be released.
    expect(stripe.countCalls('cancel')).toBe(0);
    expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
    expect(await eventsOfType(orderId, 'capture_deferred')).toHaveLength(1);

    // The same inspector accepts again a moment later and gets the job.
    await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer.id}/accept`)
      .set('Authorization', `Bearer ${inspector.token}`)
      .expect(200);

    const settled = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(settled.status).toBe(OrderStatus.ASSIGNED);
    expect(settled.inspectorId).toBe(inspector.userId);
    expect((await paymentFor(orderId)).status).toBe('succeeded');
    expect(stripe.countCalls('capture', piId)).toBe(1);
  });

  // ============================================================
  // 4. A capture failure that never will
  // ============================================================
  it('4. a fatal capture failure releases the hold and cancels the order', async () => {
    const customer = await makeCustomer();
    const inspector = await makeInspector();
    const orderId = await createOrder(customer);
    const piId = await authorize(orderId);
    const offer = await prisma.orderOffer.findFirstOrThrow({ where: { orderId } });

    // The bank refuses the capture. No repetition changes that.
    stripe.failNext('capture', {
      type: 'StripeCardError',
      code: 'card_declined',
      message: 'Your card was declined.',
    });

    const refused = await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer.id}/accept`)
      .set('Authorization', `Bearer ${inspector.token}`)
      .expect(409);
    expect(refused.body.error.code).toBe('payment_capture_failed');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    // Never ASSIGNED with uncaptured money — the whole invariant in one line.
    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.inspectorId).toBeNull();

    const payment = await paymentFor(orderId);
    expect(payment.status).toBe('cancelled');
    expect(payment.canceledAt).toBeTruthy();
    expect(payment.capturedAt).toBeNull();
    expect(stripe.countCalls('cancel', piId)).toBe(1);
    expect(stripe.intent(piId)!.status).toBe('canceled');

    // No Refund row: nothing ever left the customer's account, so recording one
    // would double-count the hold in the finance ledger.
    expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
    expect(stripe.countCalls('refund')).toBe(0);
    expect(await eventsOfType(orderId, 'capture_failed')).toHaveLength(1);
    expect(await eventsOfType(orderId, 'authorization_released')).toHaveLength(1);

    // The offer is dead too: re-offering an unpayable order only sends the next
    // inspector to the same dead end.
    expect(await pendingOfferFor(orderId)).toBeNull();
  });

  // ============================================================
  // 5. Nobody accepted
  // ============================================================
  it('5. the search window expiring releases the hold and cancels', async () => {
    const customer = await makeCustomer();
    await makeInspector();
    const orderId = await createOrder(customer);
    const piId = await authorize(orderId);
    const offer = await prisma.orderOffer.findFirstOrThrow({ where: { orderId } });

    // Six real hours are not testable, and a direct database write would test
    // the cron against a state the app never produces. `src/testing` exists for
    // exactly this, and only in NODE_ENV=test.
    await request(app.getHttpServer())
      .post(`/api/v1/testing/orders/${orderId}/expire-search`)
      .expect(200);

    const { expired } = await orders.expireUnfilledSearches();
    expect(expired).toBeGreaterThanOrEqual(1);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CANCELLED);
    const payment = await paymentFor(orderId);
    expect(payment.status).toBe('cancelled');
    expect(payment.canceledAt).toBeTruthy();
    expect(stripe.countCalls('cancel', piId)).toBe(1);
    expect(stripe.intent(piId)!.status).toBe('canceled');
    // Released, never refunded.
    expect(await prisma.refund.count({ where: { orderId } })).toBe(0);
    expect(await eventsOfType(orderId, 'search_expired')).toHaveLength(1);
    expect(
      (await prisma.orderOffer.findUniqueOrThrow({ where: { id: offer.id } })).status,
    ).toBe('EXPIRED');

    // The customer is told, and told the RIGHT thing. `order.cancelled` says
    // only that the order is gone, which reads as "charged me and cancelled
    // anyway" next to an authorization still visible on the statement — so this
    // path sends its own message about the money instead.
    const notified = await prisma.notification.findFirst({
      where: { userId: customer.userId, type: 'order.search_expired' },
    });
    expect(notified).toBeTruthy();
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(detail.body.payment.state).toBe('released');
    expect(detail.body.search.expiredAt).toBeTruthy();
  });

  it('5b. an order with NO search deadline is left alone', async () => {
    const customer = await makeCustomer();
    await makeInspector();
    const orderId = await createOrder(customer);
    await authorize(orderId);

    // This is a pre-manual-capture order: its money was CHARGED at creation, so
    // there is no hold to release. `searchExpiresAt IS NULL` is the flag that
    // says so, and it is why the column is never backfilled — a deadline here
    // would have the cron cancel an order the customer has genuinely paid for.
    await prisma.order.update({ where: { id: orderId }, data: { searchExpiresAt: null } });
    await prisma.payment.update({
      where: { orderId },
      data: { status: 'succeeded', capturedAt: new Date(), authorizedAt: null },
    });

    await orders.expireUnfilledSearches();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PAID);
    expect(stripe.countCalls('cancel')).toBe(0);
    // And the API reports no countdown rather than inventing one.
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(detail.body.search).toBeNull();
    expect(detail.body.payment.state).toBe('captured');
  });

  // ============================================================
  // 6. The webhook that never came
  // ============================================================
  it('6. the reconciler starts the search for a lost amount_capturable_updated', async () => {
    const customer = await makeCustomer();
    const inspector = await makeInspector();
    const orderId = await createOrder(customer);
    const payment = await paymentFor(orderId);
    const piId = payment.stripePaymentIntentId as string;

    // The customer paid; the webhook never arrived. Without reconciliation the
    // order sits in CREATED for ever while a hold quietly expires at Stripe.
    stripe.confirm(piId);
    await ageOutPayment(orderId);

    const { advanced } = await orders.reconcileStuckOrderPayments();
    expect(advanced).toBeGreaterThanOrEqual(1);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.PAID);
    expect(order.searchExpiresAt).toBeTruthy();
    expect((await paymentFor(orderId)).status).toBe('authorized');
    // It also dispatched — reconciliation has to leave the order in a state that
    // can actually be filled, not merely a tidier one.
    const offer = await pendingOfferFor(orderId);
    expect(offer!.inspectorId).toBe(inspector.userId);
    // Still a hold. Reconciling is not capturing.
    expect(stripe.countCalls('capture')).toBe(0);
  });

  it('6b. the reconciler captures an ASSIGNED order that was never charged', async () => {
    const customer = await makeCustomer();
    const inspector = await makeInspector();
    const orderId = await createOrder(customer);
    const piId = await authorize(orderId);

    // The state this selection exists for: an inspector committed to the job and
    // the money is still only held. `acceptOffer` cannot produce it — capture
    // comes first there — so it is built directly, which is the point: whatever
    // produced it (a restored row, a hand edit, a future code path), an
    // inspector is working for free and the hold dies at Stripe in seven days.
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.ASSIGNED, inspectorId: inspector.userId },
    });
    await ageOutPayment(orderId);

    const { advanced } = await orders.reconcileStuckOrderPayments();
    expect(advanced).toBeGreaterThanOrEqual(1);

    const payment = await paymentFor(orderId);
    expect(payment.status).toBe('succeeded');
    expect(payment.capturedAt).toBeTruthy();
    expect(stripe.countCalls('capture', piId)).toBe(1);
    // The order is left ASSIGNED: the money was the only thing wrong with it.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      OrderStatus.ASSIGNED,
    );
  });

  it('6c. a payment younger than the grace period is not touched', async () => {
    const customer = await makeCustomer();
    await makeInspector();
    const orderId = await createOrder(customer);
    const piId = (await paymentFor(orderId)).stripePaymentIntentId as string;
    stripe.confirm(piId);

    // No backdating: the webhook is very probably in flight. Second-guessing a
    // healthy delivery is how a reconciler turns into a race of its own.
    await orders.reconcileStuckOrderPayments();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CREATED);
    expect((await paymentFor(orderId)).status).toBe('pending');
  });

  // ============================================================
  // 7. The completeness gate
  // ============================================================
  describe('report completeness gate', () => {
    /** An order at IN_PROGRESS with its inspector's token. */
    async function orderInProgress(): Promise<{ orderId: string; token: string }> {
      const customer = await makeCustomer();
      await makeInspector();
      const orderId = await createOrder(customer);
      await authorize(orderId);
      const inspectorId = await acceptPendingOffer(orderId);
      const token = inspectorTokens.get(inspectorId) as string;
      for (const status of ['EN_ROUTE', 'IN_PROGRESS']) {
        await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/status`)
          .set('Authorization', `Bearer ${token}`)
          .send({ status })
          .expect(200);
      }
      return { orderId, token };
    }

    /**
     * Seed a report the inspector can try to close the order with.
     *
     * `reportData` is what the gate reads: the payload's own photo manifest is
     * the only evidence that exists at gate time, since no photo has been
     * uploaded yet. `qualityScore` is stored and echoed back on a refusal, but
     * it decides nothing — several cases below pass 100 and are still refused.
     */
    async function seedReport(
      inspectorId: string,
      reportData: CompleteReportData | null,
      qualityScore: number | null = reportData?.scores.qualityScore ?? null,
    ): Promise<{ id: string; code: string }> {
      const deviceId = uniqueDeviceId('gate');
      createdDeviceIds.add(deviceId);
      const report = await prisma.report.create({
        data: {
          deviceId,
          code: uniqueReportCode(),
          make: 'BMW',
          model: '320d',
          s3Key: `free/${deviceId}/gate.pdf`,
          tier: 'free',
          uploaded: true,
          userId: inspectorId,
          qualityScore,
          reportSchemaVersion: reportData ? 1 : null,
          reportData: reportData ?? undefined,
        },
      });
      createdReportIds.add(report.id);
      return { id: report.id, code: report.code };
    }

    /** Attach a report to an order as its inspector. */
    function attach(orderId: string, token: string, code: string) {
      return request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/report`)
        .set('Authorization', `Bearer ${token}`)
        .send({ code });
    }

    it('7. a missing exterior angle is refused, and the gap is named on the wire', async () => {
      const { orderId, token } = await orderInProgress();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const angle = currentRequiredAngles()[0];
      const report = await seedReport(
        order.inspectorId as string,
        dropPhotoKind(completeReportData(), `exterior-${angle}`),
      );

      const res = await attach(orderId, token, report.code).expect(409);

      expect(res.body.error.code).toBe('report_incomplete');
      // A bare code the client cannot turn into "you never shot the rear" is a
      // code the inspector cannot act on — they would drive back to the car
      // with no idea what to photograph. The structured gap list is the point
      // of refusing by family instead of by score.
      expect(res.body.missing.exteriorAngles).toEqual([angle]);
      expect(res.body.exteriorAngleCount).toBe(currentRequiredAngles().length);
      // Both numbers still ride along: the score is displayed, it just no
      // longer decides.
      expect(res.body.qualityScore).toBe(100);
      expect(res.body.minQualityScore).toBe(MIN_QUALITY);

      // Nothing was linked and the order did not move.
      const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(after.status).toBe(OrderStatus.IN_PROGRESS);
      expect(
        (await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).orderId,
      ).toBeNull();
    });

    it('7b. a report with NO structured payload is a DIFFERENT refusal', async () => {
      const { orderId, token } = await orderInProgress();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      // A perfect score and nothing to judge: exactly what an app built before
      // the structured payload existed sends.
      const report = await seedReport(order.inspectorId as string, null, 100);

      const res = await attach(orderId, token, report.code).expect(409);

      // Separate code on purpose: an inspector on an older app build is told to
      // update, not accused of poor work. Collapsing the two would have them
      // re-uploading a perfectly good report until someone reads the logs.
      expect(res.body.error.code).toBe('report_quality_unknown');
      expect(res.body.missing).toBeUndefined();
      expect(res.body.minQualityScore).toBe(MIN_QUALITY);
    });

    it('7c. a complete report attaches and submits the order', async () => {
      const { orderId, token } = await orderInProgress();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const report = await seedReport(order.inspectorId as string, completeReportData());

      await attach(orderId, token, report.code).expect(200);

      const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(after.status).toBe(OrderStatus.SUBMITTED);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // The counts are data, not copy: the website owns the wording, this owns
      // how many of each element the inspector has to bring back, so growing
      // the walk-around does not need a website release.
      expect(detail.body.reportRequirement).toEqual({
        minQualityScore: MIN_QUALITY,
        currentQualityScore: 100,
        gateEnabled: true,
        exteriorAngles: currentRequiredAngles().length,
        thicknessPanels: thicknessPanelIds().length,
        calibrationPhotos: 2,
        wheels: 4,
      });
    });

    /**
     * The families the score could not tell apart, as executable cases.
     *
     * A score is a weighted average, so a whole missing family could be paid
     * for by another: a report with no wheel data at all still cleared 90 on
     * the strength of its exterior walk. Each case below drops exactly ONE
     * element from an otherwise perfect payload scoring 100, which is what
     * proves the gate reads the payload and not the number.
     */
    it('7e. a paint panel with a photo but no reading is refused', async () => {
      // The old score counted this panel as measured — reading OR photo. A
      // picture of a gauge nobody transcribed is not a measurement.
      const { orderId, token } = await orderInProgress();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const data = completeReportData();
      const panel = thicknessPanelIds()[0];
      data.thickness.panels = data.thickness.panels.filter(
        (p) => p.panelId !== panel,
      );
      const report = await seedReport(order.inspectorId as string, data);

      const res = await attach(orderId, token, report.code).expect(409);

      expect(res.body.error.code).toBe('report_incomplete');
      expect(res.body.missing.thicknessValues).toEqual([panel]);
      // The photo is there — only the number is missing, and the refusal says so.
      expect(res.body.missing.thicknessPhotos).toEqual([]);
      expect(res.body.qualityScore).toBe(100);
    });

    it('7f. a wheel missing its DOT code is refused', async () => {
      // The old score accepted tread OR a condition word, so a tyre's age —
      // the one thing a buyer cannot read off a photograph — could be absent
      // from a report that closed a paid order.
      const { orderId, token } = await orderInProgress();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const data = completeReportData();
      delete data.wheels.find((w) => w.corner === 'rr')!.dot;
      const report = await seedReport(order.inspectorId as string, data);

      const res = await attach(orderId, token, report.code).expect(409);

      expect(res.body.error.code).toBe('report_incomplete');
      expect(res.body.missing.wheels).toEqual([{ corner: 'rr', missing: ['dot'] }]);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
      ).toBe(OrderStatus.IN_PROGRESS);
    });

    it('7g. a legacy 8-angle report still closes an order', async () => {
      // The amnesty. The walk-around grew from 8 angles to 17 on 2026-08-10,
      // and a report filed by a build that only knew the 8 can never satisfy
      // the 17 — its inspector would be permanently unable to be paid for work
      // that was correct when it was done. Judged by the set it was filed
      // under, it closes; the count on the wire says which set that was.
      const { orderId, token } = await orderInProgress();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const report = await seedReport(order.inspectorId as string, legacyReportData());

      await attach(orderId, token, report.code).expect(200);

      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
      ).toBe(OrderStatus.SUBMITTED);
    });

    it('7h. an inspector cannot claim the amnesty by skipping the new angles', async () => {
      // One newer angle proves the build knows about all of them, so the
      // remaining eight are missing rather than unknown. Without this, the
      // amnesty is an opt-out from the expansion the client paid for.
      const { orderId, token } = await orderInProgress();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const data = legacyReportData();
      const legacy: readonly string[] = LEGACY_EXTERIOR_ANGLES_8;
      const newAngle = currentRequiredAngles().find(
        (id) => !legacy.includes(id),
      ) as string;
      data.photos.push({ kind: `exterior-${newAngle}` });
      const report = await seedReport(order.inspectorId as string, data);

      const res = await attach(orderId, token, report.code).expect(409);

      expect(res.body.error.code).toBe('report_incomplete');
      expect(res.body.exteriorAngleCount).toBe(currentRequiredAngles().length);
      expect(res.body.missing.exteriorAngles).not.toContain(newAngle);
    });

    it('7d. minReportQualityScore = 0 turns the gate off', async () => {
      const { orderId, token } = await orderInProgress();
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      // Unjudgeable AND incomplete: with the lever down, neither refusal fires.
      const report = await seedReport(order.inspectorId as string, null);

      // The operational lever: an inspector fleet on an old build must be
      // unblockable from the admin panel in a minute, not by a release. The
      // setting kept both its name and this behaviour when the rule behind it
      // changed, precisely so the lever needs no deploy at the moment it is
      // wanted.
      await settings.set('minReportQualityScore', 0);
      try {
        await attach(orderId, token, report.code).expect(200);
      } finally {
        await settings.set('minReportQualityScore', MIN_QUALITY);
      }

      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
      ).toBe(OrderStatus.SUBMITTED);
    });
  });
});
