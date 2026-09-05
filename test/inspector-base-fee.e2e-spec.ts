import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { createTestApp } from './helpers/test-app';
import { PinnedTariff, pinTariff } from './helpers/tariff';
import { inspectorBaseFeeBounds } from '../src/orders/inspector-base-fee';
import { SettingsService } from '../src/settings/settings.service';
import { PLATFORM_SETTING_DEFAULTS } from '../src/settings/platform-settings.constants';

/*
 * DEN-213. The inspector sets their own base fee.
 *
 * The four rules the client decided, one block each:
 *
 *  1. only the BASE is theirs to move;
 *  2. it is held inside a flat window of 5 to 500 EUR;
 *  3. the customer is shown ONE price and never charged above it;
 *  4. the price is frozen when the offer is SENT, not when it is accepted.
 *
 * Rule 4 is the one that needs a database to prove: it is about what happens
 * between two events, and a unit test can only assert the arithmetic.
 */

/** The platform base a lowest-base inspector must come in under. */
const PLATFORM_BASE_CENTS = Math.round(PLATFORM_SETTING_DEFAULTS.orderBaseFeeEur * 100);

const LAT = 52.52;
const LNG = 13.405;
const SCHEDULED_AT = '2026-07-01T09:00:00.000Z';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe('Inspector base fee (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let tariff: PinnedTariff;
  let platformBaseCents: number;

  const userIds = new Set<string>();
  const orderIds = new Set<string>();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    tariff = await pinTariff(app);
    platformBaseCents = await app.get(SettingsService).getCents('orderBaseFeeEur');
  });

  afterEach(async () => {
    const ids = [...orderIds];
    if (ids.length) {
      await prisma.orderEvent.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.orderOffer.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: ids } } });
      await prisma.order.deleteMany({ where: { id: { in: ids } } });
    }
    const users = [...userIds];
    if (users.length) {
      await prisma.orderOffer.deleteMany({ where: { inspectorId: { in: users } } });
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

  /** An eligible inspector at the vehicle, optionally with a fee of their own. */
  async function makeInspector(baseFeeCents?: number, lat = LAT, lng = LNG) {
    const u = await register('insp');
    await prisma.user.update({ where: { id: u.userId }, data: { kycVerified: true } });
    await prisma.inspectorProfile.create({
      data: {
        userId: u.userId,
        companyName: 'KFZ Test GmbH',
        baseAddress: 'Teststraße 1, Berlin',
        searchRadiusKm: 300,
        available: true,
        stripeOnboarded: true,
        baseFeeCents: baseFeeCents ?? null,
      },
    });
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
        address: 'Musterstraße 1, Berlin',
        lat: LAT,
        lng: LNG,
        scheduledAt: SCHEDULED_AT,
      })
      .expect(201);
    orderIds.add(res.body.orderId);
    return res.body.orderId;
  }

  /* ── the profile field ───────────────────────────────────────────────── */

  describe('setting the fee', () => {
    it('refuses a fee outside the window, and names the window', async () => {
      const insp = await makeInspector();
      const { maxCents } = inspectorBaseFeeBounds();

      const res = await request(app.getHttpServer())
        .patch('/api/v1/inspector/profile')
        .set('Authorization', `Bearer ${insp.token}`)
        .send({ baseFeeCents: maxCents + 1 })
        .expect(400);

      // The message must carry the bound: "invalid" sends somebody guessing.
      expect(res.body.error.code).toBe('base_fee_out_of_range');
      expect(res.body.maxCents).toBe(maxCents);
    });

    it('accepts a fee inside the window and reports the window back', async () => {
      const insp = await makeInspector();
      const { minCents, maxCents } = inspectorBaseFeeBounds();
      const chosen = maxCents;

      const res = await request(app.getHttpServer())
        .patch('/api/v1/inspector/profile')
        .set('Authorization', `Bearer ${insp.token}`)
        .send({ baseFeeCents: chosen })
        .expect(200);

      expect(res.body.baseFeeCents).toBe(chosen);
      // The form states the bound from the API rather than hardcoding 30 %.
      expect(res.body.baseFee).toEqual({
        minCents,
        maxCents,
        platformCents: platformBaseCents,
      });
    });

    it('returns to the platform base when the fee is cleared', async () => {
      const insp = await makeInspector(platformBaseCents + 100);
      await request(app.getHttpServer())
        .patch('/api/v1/inspector/profile')
        .set('Authorization', `Bearer ${insp.token}`)
        .send({ baseFeeCents: null })
        .expect(200);

      const profile = await prisma.inspectorProfile.findUniqueOrThrow({
        where: { userId: insp.userId },
      });
      // Null, not zero. "Has not said" and "charges nothing" are different.
      expect(profile.baseFeeCents).toBeNull();
    });
  });

  /* ── the quote ───────────────────────────────────────────────────────── */

  describe('the price the customer is shown', () => {
    it('is the nearest inspector own base, not the platform base', async () => {
      const dearer = platformBaseCents + 500;
      await makeInspector(dearer);
      const customer = await register('cust');

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: LAT, lng: LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      expect(res.body.breakdown.baseFeeCents).toBe(dearer);
    });

    it('is the platform base when the inspector has said nothing', async () => {
      await makeInspector();
      const customer = await register('cust');

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: LAT, lng: LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      expect(res.body.breakdown.baseFeeCents).toBe(platformBaseCents);
    });
  });

  /* ── dispatch ────────────────────────────────────────────────────────── */

  describe('dispatch', () => {
    it('freezes the price on the offer when it is SENT', async () => {
      /*
       * The client's rule, and the reason for it: an inspector who could raise
       * their base while looking at a live offer would be pricing a job they
       * have already seen.
       */
      const insp = await makeInspector();
      const customer = await register('cust');
      const orderId = await createOrder(customer.token);
      await orders.dispatch(orderId);

      const offer = await prisma.orderOffer.findFirstOrThrow({ where: { orderId } });
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(offer.priceCents).toBe(order.totalCents);

      // Raising the fee AFTER the offer must not change what was offered.
      await prisma.inspectorProfile.update({
        where: { userId: insp.userId },
        data: { baseFeeCents: platformBaseCents + 900 },
      });
      const again = await prisma.orderOffer.findUniqueOrThrow({ where: { id: offer.id } });
      expect(again.priceCents).toBe(offer.priceCents);
    });

    it('skips an inspector who costs more than the customer authorised', async () => {
      /*
       * The order was quoted and authorised on the nearest inspector. A dearer
       * one further out cannot be offered the job: Stripe can capture less than
       * an authorisation and never more, and there is no second card to ask.
       */
      const { maxCents } = inspectorBaseFeeBounds();
      const cheap = await makeInspector(undefined, LAT, LNG);
      const customer = await register('cust');
      const orderId = await createOrder(customer.token);

      // The cheap one declines, leaving only somebody dearer.
      await orders.dispatch(orderId);
      const first = await prisma.orderOffer.findFirstOrThrow({ where: { orderId } });
      expect(first.inspectorId).toBe(cheap.userId);
      await prisma.orderOffer.update({ where: { id: first.id }, data: { status: 'DECLINED' } });

      await makeInspector(maxCents, LAT + 0.01, LNG);
      await orders.dispatch(orderId);

      const offers = await prisma.orderOffer.findMany({ where: { orderId } });
      expect(offers).toHaveLength(1); // no second offer was made
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.status).toBe('UNASSIGNED');
    });
  });

  /* ── acceptance ──────────────────────────────────────────────────────── */

  describe('what the customer actually pays', () => {
    it('charges LESS when the accepting inspector is cheaper than the quote', async () => {
      /*
       * The quote is a ceiling, not a target. The difference goes back to the
       * customer rather than to the platform - keeping it would be pocketing a
       * spread the customer was never told about.
       *
       * Both inspectors are ~40 km out ON PURPOSE. A co-located job is floored
       * at the minimum fare, and under the floor a cheaper base changes nothing
       * at all - which is the case the test below this one states.
       */
      const { minCents } = inspectorBaseFeeBounds();
      const dear = await makeInspector(platformBaseCents, LAT + 0.36, LNG);
      const customer = await register('cust');
      const orderId = await createOrder(customer.token);
      const quoted = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).totalCents;

      // The quoted inspector declines; a cheaper one takes it.
      await orders.dispatch(orderId);
      const first = await prisma.orderOffer.findFirstOrThrow({ where: { orderId } });
      expect(first.inspectorId).toBe(dear.userId);
      await prisma.orderOffer.update({ where: { id: first.id }, data: { status: 'DECLINED' } });

      const cheap = await makeInspector(minCents, LAT + 0.37, LNG);
      await orders.dispatch(orderId);
      const second = await prisma.orderOffer.findFirstOrThrow({
        where: { orderId, status: 'PENDING' },
      });
      expect(second.inspectorId).toBe(cheap.userId);
      expect(second.priceCents).toBeLessThan(quoted);

      await request(app.getHttpServer())
        .post(`/api/v1/offers/${second.id}/accept`)
        .set('Authorization', `Bearer ${cheap.token}`)
        .expect(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.totalCents).toBe(second.priceCents);
      expect(order.platformFeeCents).toBe(second.platformFeeCents);
      expect(order.inspectorShareCents).toBe(second.inspectorShareCents);
      // Fee + share must still reconcile to the total exactly.
      expect(order.platformFeeCents! + order.inspectorShareCents!).toBe(order.totalCents);
    });

    it('reaches the fare on a short job, and still stops at the platform floor', async () => {
      /*
       * This asserted the opposite until 2026-09-04, and the assertion was
       * right at the time: with the floor at 49 EUR a short job cost the same
       * whatever the inspector had set, so the one number DEN-213 gave them
       * changed nothing where most orders are. The floor came down to 5, and
       * the number now reaches the customer.
       *
       * Both halves are asserted deliberately. The lowest base must produce a
       * fare BELOW the platform base - that is the feature working - and it
       * must still not fall through the floor, which is what stops a race to
       * zero once dispatch starts preferring the cheaper candidate (DEN-241).
       */
      const { minCents } = inspectorBaseFeeBounds();
      await makeInspector(minCents, LAT, LNG);
      const customer = await register('cust');

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: LAT, lng: LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      expect(res.body.breakdown.baseFeeCents).toBe(minCents);
      expect(res.body.totalCents).toBeLessThan(PLATFORM_BASE_CENTS);
      expect(res.body.totalCents).toBeGreaterThanOrEqual(
        res.body.breakdown.minimumFareCents,
      );
    });

    it('charges the quote when the accepting inspector is the quoted one', async () => {
      const insp = await makeInspector();
      const customer = await register('cust');
      const orderId = await createOrder(customer.token);
      const quoted = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).totalCents;

      await orders.dispatch(orderId);
      const offer = await prisma.orderOffer.findFirstOrThrow({ where: { orderId } });
      await request(app.getHttpServer())
        .post(`/api/v1/offers/${offer.id}/accept`)
        .set('Authorization', `Bearer ${insp.token}`)
        .expect(200);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.totalCents).toBe(quoted);
    });
  });
});
