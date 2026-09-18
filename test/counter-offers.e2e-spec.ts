import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { CounterOffersService } from '../src/orders/counter-offers.service';
import { SettingsService } from '../src/settings/settings.service';
import { createTestApp } from './helpers/test-app';
import { PinnedTariff, pinTariff } from './helpers/tariff';
import {
  COUNTER_OFFER_PAYMENT_PURPOSE,
  counterOfferMaxPayoutCents,
} from '../src/orders/counter-offer-rules';

/*
 * DEN-344. An inspector names a price for an order the search could not give
 * them, and the customer answers it.
 *
 * What needs a database rather than a unit test, and is therefore what this
 * suite is about:
 *
 *  1. the trade is SHUT until a dispatch round has failed;
 *  2. exactly ONE counter-offer can wait for a customer at a time;
 *  3. accepting REPLACES the authorization — the order ends up assigned at the
 *     new price, with the old payment row kept and superseded;
 *  4. while the customer pays, the pool cannot take the order underneath them;
 *  5. an inspector who takes other work stops waiting on a customer's screen.
 *
 * Stripe is in mock mode (NODE_ENV=test), so the payment steps resolve in our
 * own ledger and run the same two-authorization shape the webhook drives.
 */

const LAT = 52.52;
const LNG = 13.405;
/** Far enough that the fair price for this inspector is well above the order. */
const FAR_LAT = 52.85;
const FAR_LNG = 13.95;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe('Counter-offers (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let counterOffers: CounterOffersService;
  let settings: SettingsService;
  let tariff: PinnedTariff;

  const userIds = new Set<string>();
  const orderIds = new Set<string>();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    counterOffers = app.get(CounterOffersService);
    settings = app.get(SettingsService);
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
    const users = [...userIds];
    if (users.length) {
      await prisma.orderCounterOffer.deleteMany({ where: { inspectorId: { in: users } } });
      await prisma.orderOffer.deleteMany({ where: { inspectorId: { in: users } } });
      await prisma.notification.deleteMany({ where: { userId: { in: users } } });
      await prisma.inspectorProfile.deleteMany({ where: { userId: { in: users } } });
      await prisma.verificationToken.deleteMany({ where: { userId: { in: users } } });
      await prisma.payment.deleteMany({ where: { userId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    orderIds.clear();
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

  async function makeInspector(opts: {
    baseFeeCents?: number;
    lat?: number;
    lng?: number;
    available?: boolean;
  }) {
    const u = await register('insp');
    await prisma.user.update({ where: { id: u.userId }, data: { kycVerified: true } });
    await prisma.inspectorProfile.create({
      data: {
        userId: u.userId,
        companyName: 'KFZ Gegenangebot GmbH',
        baseAddress: 'Teststraße 1, Berlin',
        searchRadiusKm: 300,
        available: opts.available ?? true,
        stripeOnboarded: true,
        baseFeeCents: opts.baseFeeCents ?? null,
      },
    });
    const lat = opts.lat ?? LAT;
    const lng = opts.lng ?? LNG;
    await prisma.$executeRaw`
      UPDATE inspector_profile
      SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
      WHERE user_id = ${u.userId}
    `;
    return u;
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

  /**
   * An order nobody took: UNASSIGNED and past the first round, which is the
   * state the trade opens in. Written directly because driving a real dispatch
   * round to exhaustion needs five inspectors who are all too expensive.
   */
  async function orderWaitingForTrade(customerToken: string): Promise<string> {
    const orderId = await createOrder(customerToken);
    await prisma.orderOffer.deleteMany({ where: { orderId } });
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.UNASSIGNED,
        inspectorId: null,
        dispatchRound: 1,
        searchExpiresAt: new Date(Date.now() + 6 * 3600_000),
      },
    });
    return orderId;
  }

  describe('when the trade may be used at all', () => {
    it('refuses a price while the automatic search is still running', async () => {
      // A nearby, affordable inspector so the order is dispatched normally and
      // stays in its first round.
      await makeInspector({});
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await createOrder(customer.token);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: 20_000, reason: 'The car is far from me.' })
        .expect(409);

      expect(res.body.error.code).toBe('counter_offer_closed');
    });

    it('refuses the customer naming a price on their own order', async () => {
      // Somebody has to be in range or the order cannot be quoted at all.
      await makeInspector({});
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      // The customer also happens to be an inspector.
      await prisma.user.update({ where: { id: customer.userId }, data: { kycVerified: true } });
      await prisma.inspectorProfile.create({
        data: {
          userId: customer.userId,
          baseAddress: 'Teststraße 2, Berlin',
          stripeOnboarded: true,
          available: true,
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ payoutCents: 20_000, reason: 'I will do it myself.' })
        .expect(403);

      expect(res.body.error.code).toBe('self_assignment_forbidden');
    });
  });

  describe('the price bounds', () => {
    it('refuses a price at or below what the order already pays', async () => {
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        // What the order already pays this inspector: grossing it back up
        // reproduces the order's own total, which is the floor.
        .send({ payoutCents: order.inspectorShareCents, reason: 'Same price as the order.' })
        .expect(400);

      expect(res.body.error.code).toBe('counter_offer_price_invalid');
    });

    it('refuses a price above the ceiling and names the ceiling', async () => {
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: 5_000_000, reason: 'Because I can.' })
        .expect(400);

      expect(res.body.error.code).toBe('counter_offer_price_invalid');
      // The inspector must be told what they CAN ask; "invalid" sends them guessing.
      expect(res.body.error.maxPriceCents ?? res.body.maxPriceCents).toBeGreaterThan(0);
    });
  });

  describe('one offer at a time', () => {
    it('refuses a second inspector while the first price waits', async () => {
      const first = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const second = await makeInspector({ baseFeeCents: 45_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const max = await payoutCeilingFor(orderId, first.userId);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${first.token}`)
        .send({ payoutCents: max, reason: 'The car is 38 km from me.' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${second.token}`)
        .send({ payoutCents: max, reason: 'I can go too.' })
        .expect(409);

      expect(res.body.error.code).toBe('counter_offer_slot_taken');
    });

    it('frees the slot the moment the customer refuses', async () => {
      const first = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const second = await makeInspector({ baseFeeCents: 45_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const max = await payoutCeilingFor(orderId, first.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${first.token}`)
        .send({ payoutCents: max, reason: 'The car is 38 km from me.' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers/${created.body.id}/decline`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      // No waiting period: the search window is short enough as it is.
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${second.token}`)
        .send({ payoutCents: max, reason: 'I can go instead.' })
        .expect(201);

      // The customer's hold was never touched by any of this.
      const payments = await prisma.payment.findMany({ where: { orderId } });
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe('authorized');
    });
  });

  /*
   * DEN-346. The summary above the customer's list of orders. It answers for
   * every order at once, and it must answer for PENDING alone: a price the
   * customer has already accepted and is paying for must not keep calling for
   * an answer from the top of the page.
   */
  describe('the summary of waiting prices', () => {
    it('lists a pending price, and only on the caller’s own orders', async () => {
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const stranger = await register('other');
      const orderId = await orderWaitingForTrade(customer.token);
      const price = await payoutCeilingFor(orderId, far.userId);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: price, reason: 'The car is 38 km from me.' })
        .expect(201);

      const mine = await request(app.getHttpServer())
        .get('/api/v1/counter-offers/mine')
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);
      expect(mine.body.items).toHaveLength(1);
      // The card is read away from the order, so it has to name it. The
      // customer's card speaks in the CUSTOMER's sum, which is the payout the
      // inspector named plus the platform's cut.
      expect(mine.body.items[0].orderId).toBe(orderId);
      expect(mine.body.items[0].priceCents).toBeGreaterThan(price);
      expect(mine.body.items[0].orderNumber).toMatch(/^ORD-/);

      const theirs = await request(app.getHttpServer())
        .get('/api/v1/counter-offers/mine')
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(200);
      expect(theirs.body.items).toHaveLength(0);
    });

    it('drops the price the customer is already paying for', async () => {
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const price = await payoutCeilingFor(orderId, far.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: price, reason: 'The car is 38 km from me.' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers/${created.body.id}/accept`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      const mine = await request(app.getHttpServer())
        .get('/api/v1/counter-offers/mine')
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);
      expect(mine.body.items).toHaveLength(0);
    });
  });

  /*
   * One price per inspector per order. The row is keyed (order, inspector) and
   * upserted, which is what lets a failed payment be retried - and, until this
   * was closed, also let a refused inspector come straight back with a lower
   * number until the customer stopped saying no.
   */
  describe('a refused inspector cannot come back', () => {
    it('refuses a second price after the customer continued the search', async () => {
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const payout = await payoutCeilingFor(orderId, far.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: payout, reason: 'The car is 38 km from me.' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers/${created.body.id}/decline`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      // The slot is free - another inspector may still name a price - but this
      // one has had their answer.
      const again = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: payout - 5_000, reason: 'I can do it cheaper after all.' })
        .expect(409);
      expect(again.body.error.code).toBe('counter_offer_already_answered');

      const other = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${other.token}`)
        .send({ payoutCents: payout, reason: 'I can go instead.' })
        .expect(201);
    });

    it('lets the same inspector price again after they withdrew', async () => {
      // Nobody answered that offer, so nobody is being asked twice.
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const payout = await payoutCeilingFor(orderId, far.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: payout, reason: 'The car is 38 km from me.' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/counter-offers/${created.body.id}/withdraw`)
        .set('Authorization', `Bearer ${far.token}`)
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: payout - 1_000, reason: 'A better price.' })
        .expect(201);
    });
  });

  describe('the customer accepts', () => {
    it('replaces the authorization and assigns the inspector at the new price', async () => {
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const payout = await payoutCeilingFor(orderId, far.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: payout, reason: 'The car is 38 km from me.' })
        .expect(201);

      /*
       * DEN-344. The inspector named a PAYOUT, and the answer states all three
       * figures: the promise is that the payout is exactly what was typed, and
       * the platform's cut is the difference rather than a second rounding.
       */
      expect(created.body.payoutCents).toBe(payout);
      expect(created.body.priceCents).toBeGreaterThan(payout);
      expect(created.body.priceCents - created.body.platformFeeCents).toBe(payout);
      const price = created.body.priceCents;

      // The customer sees exactly one offer, with the difference spelled out.
      const current = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}/counter-offers/current`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);
      // In the CUSTOMER's unit: what they will pay, against what they were quoted.
      expect(current.body.counterOffer.priceCents).toBe(price);
      expect(current.body.counterOffer.orderTotalCents).toBe(before.totalCents);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers/${created.body.id}/accept`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe(OrderStatus.ASSIGNED);
      expect(order.inspectorId).toBe(far.userId);
      // The order's money describes the sale that happened, not the quote.
      expect(order.totalCents).toBe(price);
      expect(order.platformFeeCents + order.inspectorShareCents).toBe(price);
      // The whole point of the change: the inspector is paid what they asked.
      expect(order.inspectorShareCents).toBe(payout);

      // Two payment rows: the released original and the captured replacement.
      // The first is kept because it is the record of a hold that existed.
      const payments = await prisma.payment.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
      });
      expect(payments).toHaveLength(2);
      expect(payments[0]).toMatchObject({ amountCents: before.totalCents, status: 'cancelled' });
      expect(payments[0].supersededAt).not.toBeNull();
      expect(payments[1]).toMatchObject({
        amountCents: price,
        status: 'succeeded',
        purpose: COUNTER_OFFER_PAYMENT_PURPOSE,
        supersededAt: null,
      });

      const counter = await prisma.orderCounterOffer.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(counter.status).toBe('ACCEPTED');
    });

    it('refuses when the inspector has taken other work in the meantime', async () => {
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const price = await payoutCeilingFor(orderId, far.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: price, reason: 'The car is 38 km from me.' })
        .expect(201);

      // The same inspector is now busy with another job.
      const otherCustomer = await register('cust2');
      const otherOrderId = await createOrder(otherCustomer.token);
      await prisma.order.update({
        where: { id: otherOrderId },
        data: { status: OrderStatus.ASSIGNED, inspectorId: far.userId },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers/${created.body.id}/accept`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(409);

      expect(res.body.error.code).toBe('counter_offer_inspector_busy');
      // Nothing was charged, and the offer leaves the customer's screen.
      const counter = await prisma.orderCounterOffer.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(counter.status).toBe('WITHDRAWN');
      const payments = await prisma.payment.findMany({ where: { orderId } });
      expect(payments).toHaveLength(1);
    });

    it('takes the offer off the screen when somebody takes the order at the tariff price', async () => {
      const near = await makeInspector({});
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const price = await payoutCeilingFor(orderId, far.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: price, reason: 'The car is 38 km from me.' })
        .expect(201);

      // The ordinary search wins. The offer is written rather than dispatched:
      // the shared test database holds inspectors from other suites at these
      // coordinates, so which candidate a real dispatch picks is not ours to
      // decide — and what this test is about is what happens to the
      // counter-offer once SOMEBODY takes the order at its own price.
      const quoted = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      const offer = await prisma.orderOffer.create({
        data: {
          orderId,
          inspectorId: near.userId,
          status: 'PENDING',
          round: quoted.dispatchRound,
          expiresAt: new Date(Date.now() + 3600_000),
          priceCents: quoted.totalCents,
          platformFeeCents: quoted.platformFeeCents,
          inspectorShareCents: quoted.inspectorShareCents,
        },
      });
      await orders.acceptOffer(offer.id, near.userId);

      const counter = await prisma.orderCounterOffer.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      // SUPERSEDED, not DECLINED: the customer refused nothing, and the
      // cheaper outcome is the one the platform wants.
      expect(counter.status).toBe('SUPERSEDED');

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.inspectorId).toBe(near.userId);
      expect(order.totalCents).toBeLessThan(price);
    });
  });

  describe('while the customer is paying', () => {
    it('keeps the pool out of the order and lets it back in when the window closes', async () => {
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      await makeInspector({});
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const price = await payoutCeilingFor(orderId, far.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: price, reason: 'The car is 38 km from me.' })
        .expect(201);

      // Mock mode finishes a payment as soon as it starts, so the lock is put
      // in by hand to hold the order in the one state that matters.
      await prisma.orderCounterOffer.update({
        where: { id: created.body.id },
        data: { status: 'ACCEPTING', acceptingUntil: new Date(Date.now() + 10 * 60_000) },
      });

      // Dispatch must refuse to send anybody an offer.
      await expect(orders.dispatch(orderId)).resolves.toBe(false);
      expect(await prisma.orderOffer.count({ where: { orderId, status: 'PENDING' } })).toBe(0);

      // The payment window runs out: the offer goes back to the customer and
      // the order returns to the pool.
      await prisma.orderCounterOffer.update({
        where: { id: created.body.id },
        data: { acceptingUntil: new Date(Date.now() - 1000) },
      });
      await counterOffers.sweepExpired();

      const counter = await prisma.orderCounterOffer.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(counter.status).toBe('PENDING');
      expect(counter.acceptingUntil).toBeNull();
      // A mistyped card costs the customer nothing: the original hold stands.
      const payments = await prisma.payment.findMany({ where: { orderId, supersededAt: null } });
      expect(payments).toHaveLength(1);
      expect(payments[0].status).toBe('authorized');
      // And the pool was asked again at once. WHICH inspector was asked is not
      // asserted: other suites leave inspectors at these coordinates in the
      // shared test database, and the claim here is that dispatch ran at all.
      expect(await prisma.orderOffer.count({ where: { orderId, status: 'PENDING' } })).toBe(1);
    });
  });

  describe('the sweep', () => {
    it('expires an offer the customer never answered and frees the slot', async () => {
      const far = await makeInspector({ baseFeeCents: 40_000, lat: FAR_LAT, lng: FAR_LNG });
      const customer = await register('cust');
      const orderId = await orderWaitingForTrade(customer.token);
      const price = await payoutCeilingFor(orderId, far.userId);

      const created = await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/counter-offers`)
        .set('Authorization', `Bearer ${far.token}`)
        .send({ payoutCents: price, reason: 'The car is 38 km from me.' })
        .expect(201);
      await prisma.orderCounterOffer.update({
        where: { id: created.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const { expired } = await counterOffers.sweepExpired();
      expect(expired).toBeGreaterThanOrEqual(1);

      const counter = await prisma.orderCounterOffer.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(counter.status).toBe('EXPIRED');
      // The inspector is told, or a cabinet empties with no explanation.
      const note = await prisma.notification.findFirst({
        where: { userId: far.userId, type: 'counter_offer.expired' },
      });
      expect(note).not.toBeNull();
    });
  });

  /** The most this inspector may ask for this order, as the service computes it. */
  /**
   * The largest PAYOUT this inspector may name for the order - the unit the API
   * now takes (DEN-344). The ceiling itself is still a customer total, so it is
   * converted through the same rule the service uses, which guarantees the
   * figure is accepted rather than refused a cent over.
   */
  async function payoutCeilingFor(orderId: string, inspectorUserId: string): Promise<number> {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const distanceKm = await appGeoDistance(inspectorUserId, orderId);
    const fair = await orders.fairPriceForInspector(order, inspectorUserId, distanceKm);
    const multiplier = await settings.getNumber('counterOfferMaxMultiplier');
    const percent = await settings.getNumber('platformFeePercent');
    return counterOfferMaxPayoutCents(Math.round(fair.totalCents * multiplier), percent);
  }

  async function appGeoDistance(inspectorUserId: string, orderId: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<Array<{ d: number }>>(
      `SELECT ST_Distance(ip.location, o.location) AS d
       FROM inspector_profile ip CROSS JOIN "order" o
       WHERE ip.user_id = $1 AND o.id = $2`,
      inspectorUserId,
      orderId,
    );
    return Math.round((Number(rows[0].d) / 1000) * 10) / 10;
  }
});
