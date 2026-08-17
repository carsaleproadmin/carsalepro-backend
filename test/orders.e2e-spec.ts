import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { DEFAULT_COUNTRY_CODE, GeocodingService } from '../src/geo/geocoding.service';
import {
  currentRequiredAngles,
  thicknessPanelIds,
} from '../src/reports/report-completeness';
import { completeReportData } from './helpers/report-payload';
import { createTestApp, uniqueDeviceId } from './helpers/test-app';
import { PinnedTariff, colocatedQuote, pinTariff } from './helpers/tariff';
import { PLATFORM_SETTING_DEFAULTS } from '../src/settings/platform-settings.constants';

// Berlin Mitte — the order/customer location used across the suite.
const ORDER_LAT = 52.52;
const ORDER_LNG = 13.405;
const SCHEDULED_AT = '2026-07-01T09:00:00.000Z';

function uniqueEmail(prefix = 'ord'): string {
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

describe('Orders / Geo / Dispatch (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let tariff: PinnedTariff;

  // Every price assertion below is against a co-located inspector, so the fare
  // is base + one minute of travel, floored at the minimum fare. Derived rather
  // than hardcoded so a retuned default does not silently invalidate the suite.
  const FARE = colocatedQuote();

  // Track ids for FK-ordered cleanup.
  const createdOrderIds = new Set<string>();
  const createdUserIds = new Set<string>();
  const createdWaitlistEmails = new Set<string>();
  // userId → bearer token, so we can accept an offer as whoever actually holds it
  // (dispatch may pick any equidistant eligible inspector).
  const inspectorTokens = new Map<string, string>();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    // Sibling suites mutate the tariff; pin it so these assertions mean something.
    tariff = await pinTariff(app);
  });

  afterEach(async () => {
    // Delete in FK-dependency order.
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

  async function makeAdmin(): Promise<Registered> {
    const u = await registerUser(app, 'admin');
    createdUserIds.add(u.userId);
    createdWaitlistEmails.add(u.email);
    await prisma.user.update({ where: { id: u.userId }, data: { role: Role.ADMIN } });
    // Re-login: the registration token was minted before the role change.
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: u.email, password: 'Sup3rSecret!' })
      .expect(200);
    return { token: res.body.token as string, userId: u.userId, email: u.email };
  }

  /**
   * Register an eligible inspector: kycVerified=true + InspectorProfile with
   * stripeOnboarded=true, available=true, location set via raw SQL.
   */
  async function makeInspector(
    lat: number,
    lng: number,
    opts: { name?: string; company?: string; searchRadiusKm?: number } = {},
  ): Promise<Registered> {
    const u = await registerUser(app, 'insp');
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
        // The inspector's OWN reach, honoured since DEN-113. It defaults wide
        // here so a spec that says nothing about radii is testing the platform
        // ceiling, which is what most of them mean.
        searchRadiusKm: opts.searchRadiusKm ?? 300,
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

  function trackOrder(orderId: string): void {
    createdOrderIds.add(orderId);
  }

  /**
   * Accept the current PENDING offer on an order as whichever inspector actually
   * holds it. Equidistant inspectors are tie-broken arbitrarily by PostGIS, so a
   * test must not assume a specific recipient — it accepts as the holder.
   */
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

  async function pendingOfferFor(orderId: string) {
    return prisma.orderOffer.findFirst({ where: { orderId, status: 'PENDING' } });
  }

  // ============================================================
  // 1. Quote with an available inspector in range
  // ============================================================
  it('1. quote returns available:true with base + round(km*rate) and 80/20 split', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG); // distance ~0 → total = base

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);

    expect(res.body.available).toBe(true);
    // Co-located inspector → no distance fee; the fare is base + one minute,
    // which sits below the minimum fare and is floored up to it.
    expect(res.body.breakdown.baseFeeCents).toBe(FARE.baseFeeCents);
    expect(res.body.breakdown.distanceFeeCents).toBe(0);
    expect(res.body.breakdown.timeFeeCents).toBe(FARE.timeFeeCents);
    expect(res.body.breakdown.minimumFareApplied).toBe(true);
    expect(res.body.breakdown.minimumFareTopUpCents).toBe(
      FARE.totalCents - FARE.subtotalCents,
    );
    // No Mapbox token in .env.test, so the estimate is explicitly labelled.
    expect(res.body.breakdown.distanceSource).toBe('straight_line');
    expect(res.body.breakdown.surgeFeeCents).toBe(0);
    expect(res.body.totalCents).toBe(FARE.totalCents);
    expect(res.body.currency).toBe('EUR');
    expect(res.body.nearestKm).toBe(0);
    expect(Array.isArray(res.body.candidates)).toBe(true);
    expect(res.body.candidates.length).toBeGreaterThanOrEqual(1);

    // Verify the 80/20 split is what the order would persist.
    const platformFee = Math.round((res.body.totalCents * 20) / 100);
    expect(platformFee).toBe(FARE.platformFeeCents);
    expect(res.body.totalCents - platformFee).toBe(FARE.inspectorShareCents);

    /*
     * The split is QUOTED, not only persisted. Both sides are shown the
     * commission by name (decided 2026-08-11), and the customer sees it before
     * paying — which it cannot be if the numbers never leave the server. This
     * used to be derivable only by re-doing the percentage on the client, which
     * is the same arithmetic in a second place and a float one at that.
     */
    expect(res.body.breakdown.platformFeeCents).toBe(FARE.platformFeeCents);
    expect(res.body.breakdown.inspectorShareCents).toBe(
      FARE.inspectorShareCents,
    );
    expect(
      res.body.breakdown.platformFeeCents +
        res.body.breakdown.inspectorShareCents,
    ).toBe(res.body.totalCents);
  });

  // ============================================================
  // 2. Quote with no inspector in range → waitlist
  // ============================================================
  it('2. quote with no inspector in range returns available:false + creates a WaitlistEntry', async () => {
    const customer = await makeCustomer();
    // Inspector far away (Munich, ~500km) — outside the platform ceiling.
    await makeInspector(48.137, 11.575);

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);

    expect(res.body.available).toBe(false);
    expect(res.body.waitlisted).toBe(true);

    const entry = await prisma.waitlistEntry.findFirst({ where: { email: customer.email } });
    expect(entry).toBeTruthy();
  });

  // ============================================================
  // 2b. F-10 — a visitor can price an inspection with no account
  // ============================================================
  it('2b. quote with NO Authorization header returns 200', async () => {
    await makeInspector(ORDER_LAT, ORDER_LNG);

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);

    expect(res.body.available).toBe(true);
    expect(res.body.totalCents).toBe(FARE.totalCents);
  });

  it('2c. an anonymous no-coverage quote is not waitlisted and creates no WaitlistEntry', async () => {
    // Munich, far outside the radius of a Berlin order.
    await makeInspector(48.137, 11.575);
    // Id snapshot rather than a count: sibling suites delete waitlist rows in
    // their own cleanup, and only this suite ever creates one, so "no NEW id"
    // is the assertion that cannot flake.
    const before = new Set(
      (await prisma.waitlistEntry.findMany({ select: { id: true } })).map((e) => e.id),
    );

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);

    expect(res.body.available).toBe(false);
    // No account => no email => nothing to waitlist against. The UI prompts.
    expect(res.body.waitlisted).toBe(false);
    const after = await prisma.waitlistEntry.findMany({ select: { id: true } });
    expect(after.filter((e) => !before.has(e.id))).toEqual([]);
  });

  // ============================================================
  // 2e. DEN-113 — the inspector's own radius narrows the platform ceiling
  // ============================================================
  it("2e. an inspector inside the platform ceiling but outside their OWN radius is not a candidate", async () => {
    const customer = await makeCustomer();
    createdWaitlistEmails.add(customer.email);
    // ~78 km north: well inside the 300 km ceiling, well outside a 50 km reach.
    await makeInspector(ORDER_LAT + 0.7, ORDER_LNG, { searchRadiusKm: 50 });

    const refused = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);

    // Not "too far" — the platform serves this distance. Nobody accepts it.
    expect(refused.body.available).toBe(false);
    expect(refused.body.refusal).toBe('no_coverage');

    // The SAME inspector, at the same place, once they say they drive it.
    await prisma.inspectorProfile.updateMany({ data: { searchRadiusKm: 100 } });

    const offered = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);

    expect(offered.body.available).toBe(true);
  });

  // ============================================================
  // 2d. F-13 — an account cannot be quoted its own inspection
  // ============================================================
  it('2d. an account that is its own inspector is excluded from its own quote candidates', async () => {
    // One account, both roles, at the order coordinates.
    const self = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Self Dealer' });
    createdWaitlistEmails.add(self.email);

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${self.token}`)
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);

    expect(res.body.available).toBe(false);

    // A different customer at the same point still gets this inspector, so the
    // exclusion is about identity, not about the inspector being ineligible.
    const other = await makeCustomer();
    const otherRes = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${other.token}`)
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);
    expect(otherRes.body.available).toBe(true);
    expect(
      otherRes.body.candidates.some((c: { displayName: string }) => c.displayName === 'Self Dealer'),
    ).toBe(true);
  });

  it('2e. a forged offer to the customer is refused by acceptOffer (403) and adminAssign (400)', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);

    // Give the customer an inspector identity too, then forge the offer the
    // dispatcher would never make — the candidate filter is one new assignment
    // route away from being bypassed, so the write paths must refuse as well.
    await prisma.user.update({ where: { id: customer.userId }, data: { kycVerified: true } });
    await prisma.inspectorProfile.create({
      data: {
        userId: customer.userId,
        baseAddress: 'Teststraße 1, Berlin',
        available: true,
        stripeOnboarded: true,
      },
    });
    const forged = await prisma.orderOffer.create({
      data: {
        orderId,
        inspectorId: customer.userId,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const accept = await request(app.getHttpServer())
      .post(`/api/v1/offers/${forged.id}/accept`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(403);
    expect(accept.body.error.code).toBe('self_assignment_forbidden');

    await expect(
      orders.adminAssign(orderId, customer.userId, 'admin-e2e'),
    ).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'self_assignment_forbidden' } },
    });

    const after = await prisma.order.findUnique({ where: { id: orderId } });
    expect(after!.inspectorId).toBeNull();
    expect(after!.status).toBe('PAID');
  });

  // ============================================================
  // 3. Create order (mock) → PAID + PENDING offer + ORD-####
  // ============================================================
  it('3. create order (mock) → PAID with the money HELD, a PENDING offer, ORD-####', async () => {
    const customer = await makeCustomer();
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG);

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

    expect(res.body.orderId).toBeTruthy();
    expect(res.body.paymentClientSecret).toBeNull();
    expect(res.body.mock).toBe(true);
    trackOrder(res.body.orderId);

    const order = await prisma.order.findUnique({ where: { id: res.body.orderId } });
    expect(order!.status).toBe('PAID');
    expect(order!.number).toMatch(/^ORD-\d{4,8}$/);
    expect(order!.totalCents).toBe(FARE.totalCents);
    expect(order!.platformFeeCents).toBe(FARE.platformFeeCents);
    expect(order!.inspectorShareCents).toBe(FARE.inspectorShareCents);
    // The ride-hailing components are persisted, not just the total.
    expect(order!.timeFeeCents).toBe(FARE.timeFeeCents);
    // Two, not one: the routing floor of one minute is charged in both
    // directions, and the column stores what was billed.
    expect(order!.durationMin).toBe(2);
    expect(order!.minimumFareApplied).toBe(true);
    expect(order!.routingSource).toBe('haversine');

    const payment = await prisma.payment.findUnique({ where: { orderId: order!.id } });
    // AUTHORIZED, not charged. Under manual capture the funds are only held at
    // this point — nobody has agreed to do the work yet, so nothing is taken.
    expect(payment!.status).toBe('authorized');
    expect(payment!.authorizedAt).toBeTruthy();
    expect(payment!.capturedAt).toBeNull();
    expect(payment!.purpose).toBe('order');

    // The hold starts a countdown: past it with nobody assigned, the cron
    // releases it and cancels rather than sitting on the customer's money.
    expect(order!.searchExpiresAt).toBeTruthy();
    const windowMinutes =
      (order!.searchExpiresAt!.getTime() - order!.createdAt.getTime()) / 60_000;
    expect(Math.round(windowMinutes)).toBe(PLATFORM_SETTING_DEFAULTS.orderSearchWindowMinutes);

    const offer = await pendingOfferFor(order!.id);
    expect(offer).toBeTruthy();
    expect(offer!.inspectorId).toBe(inspector.userId);
  });

  // ============================================================
  // 3b. The order records the country of the INSPECTION ADDRESS
  // ============================================================
  //
  // `.env.test` blanks MAPBOX_TOKEN, so the real service answers null here and
  // every other test in the suite exercises the fallback. These two stand the
  // geocoder up and down on purpose: the column was written as a literal 'DE'
  // until 2026-08-13, which no assertion could see, because the fallback is
  // also 'DE'.
  it('3b. the geocoded country of the address is stored on the order', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const geocoding = app.get(GeocodingService);
    const spy = jest.spyOn(geocoding, 'countryCodeFor').mockResolvedValue('PL');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({
          make: 'BMW',
          model: '320d',
          address: 'ul. Testowa 1, Poznań',
          lat: ORDER_LAT,
          lng: ORDER_LNG,
          scheduledAt: SCHEDULED_AT,
        })
        .expect(201);
      trackOrder(res.body.orderId);

      const order = await prisma.order.findUnique({ where: { id: res.body.orderId } });
      expect(order!.countryCode).toBe('PL');
      // The point that was geocoded is the inspection address, not the
      // customer's account country.
      expect(spy).toHaveBeenCalledWith({ lat: ORDER_LAT, lng: ORDER_LNG });
    } finally {
      spy.mockRestore();
    }
  });

  it('3b2. an unknown country falls back to DE and still completes the order', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const geocoding = app.get(GeocodingService);
    const spy = jest.spyOn(geocoding, 'countryCodeFor').mockResolvedValue(null);

    try {
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

      const order = await prisma.order.findUnique({ where: { id: res.body.orderId } });
      expect(order!.countryCode).toBe(DEFAULT_COUNTRY_CODE);
      expect(order!.status).toBe('PAID');
    } finally {
      spy.mockRestore();
    }
  });

  // ============================================================
  // 3c. The return trip: the tariff factor, end to end
  // ============================================================
  //
  // The factor and the per-km rate are one decision: 0.30/km on the return trip
  // bills the same kilometre charge as the old 0.60/km on a one-direction trip.
  // These assertions exist so a later edit to one of them fails here.
  it('3c. the shipped tariff charges the trip in both directions', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);

    // The literal 2 is the owner's decision of 2026-08-13, asserted against the
    // number itself rather than the constant it is read from.
    expect(res.body.breakdown.returnTripFactor).toBe(2);
    expect(PLATFORM_SETTING_DEFAULTS.orderReturnTripFactor).toBe(2);
    expect(PLATFORM_SETTING_DEFAULTS.orderRatePerKmEur).toBe(0.3);
    expect(res.body.totalCents).toBe(FARE.totalCents);
  });

  it('3c2. a factor of 2 bills both directions and is frozen on the order', async () => {
    const customer = await makeCustomer();
    // 0.2 degrees of latitude is about 22 km — far enough that the distance
    // component is a real number rather than the co-located floor.
    await makeInspector(ORDER_LAT + 0.2, ORDER_LNG);
    const doubled = await pinTariff(app, { orderReturnTripFactor: 2 });

    try {
      const quote = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      const b = quote.body.breakdown;
      expect(b.returnTripFactor).toBe(2);
      // The factor multiplies the CHARGEABLE distance: the free radius is a
      // statement about how far the vehicle is, so it comes off once, before
      // the return trip is applied.
      expect(b.billedDistanceKm).toBeCloseTo(b.chargeableDistanceKm * 2, 5);
      expect(b.chargeableDistanceKm).toBeCloseTo(b.distanceKm - b.freeRadiusKm, 1);
      expect(b.billedDurationMin).toBe(b.durationMin * 2);
      // The fee follows the BILLED quantity, so the arithmetic a customer can
      // do on the page reaches the amount we charge.
      expect(b.distanceFeeCents).toBe(
        Math.round(b.billedDistanceKm * PLATFORM_SETTING_DEFAULTS.orderRatePerKmEur * 100),
      );

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

      // The order stores the BILLED distance and the factor that produced it,
      // so a row read years later still says what was charged and why.
      const order = await prisma.order.findUnique({ where: { id: res.body.orderId } });
      expect(Number(order!.returnTripFactor)).toBe(2);
      expect(Number(order!.distanceKm)).toBeCloseTo(b.billedDistanceKm, 5);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/orders/${res.body.orderId}`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);
      // The detail reports the measured distance too, derived back out of the
      // stored pair — a stored order and a fresh quote describe the same thing.
      expect(detail.body.money.billedDistanceKm).toBeCloseTo(b.billedDistanceKm, 5);
      expect(detail.body.money.chargeableDistanceKm).toBeCloseTo(b.chargeableDistanceKm, 5);
      // The measured trip survives the round trip through the database only
      // because the free radius is stored beside the factor.
      expect(detail.body.money.freeRadiusKm).toBe(b.freeRadiusKm);
      expect(detail.body.money.distanceKm).toBeCloseTo(b.distanceKm, 1);
    } finally {
      await doubled.restore();
      tariff = await pinTariff(app);
    }
  });

  // ============================================================
  // 3d. The free radius and the distance cap
  // ============================================================
  it('3d. the free radius comes off the trip before the rate applies', async () => {
    const customer = await makeCustomer();
    // ~22 km north, comfortably outside the 10 km free radius.
    await makeInspector(ORDER_LAT + 0.2, ORDER_LNG);

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);

    const b = res.body.breakdown;
    // The literal 10 is the owner's decision of 2026-08-13, not an incidental
    // default: asserting it against the constant it comes from would pass for
    // any value, including 0.
    expect(b.freeRadiusKm).toBe(10);
    expect(PLATFORM_SETTING_DEFAULTS.orderFreeRadiusKm).toBe(10);
    expect(b.chargeableDistanceKm).toBeCloseTo(b.distanceKm - b.freeRadiusKm, 1);
    // The rate applies to the BILLED distance — chargeable, both ways.
    expect(b.billedDistanceKm).toBeCloseTo(b.chargeableDistanceKm * b.returnTripFactor, 5);
    expect(b.distanceFeeCents).toBe(
      Math.round(b.billedDistanceKm * PLATFORM_SETTING_DEFAULTS.orderRatePerKmEur * 100),
    );
  });

  it('3d2. a trip inside the free radius carries no travel charge at all', async () => {
    const customer = await makeCustomer();
    // ~5.5 km north: a real distance, and inside the 10 km radius. A co-located
    // inspector would prove nothing — zero kilometres cost nothing anyway.
    await makeInspector(ORDER_LAT + 0.05, ORDER_LNG);

    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/quote')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
      .expect(200);

    expect(res.body.breakdown.distanceKm).toBeGreaterThan(4);
    expect(res.body.breakdown.chargeableDistanceKm).toBe(0);
    expect(res.body.breakdown.distanceFeeCents).toBe(0);
  });

  /*
   * The order page of a short job must not invent a distance.
   *
   * Inside the free radius the row bills zero kilometres whatever the trip was,
   * so the measurement is not recoverable — and the detail used to add the
   * radius back regardless. A customer who was quoted 1 km opened the order one
   * minute later and read 10 km, on the page that itemises what they paid.
   * Null is the only honest answer, and the billed figures carry the fee.
   */
  it('3d4. a short order reports no measured distance rather than the free radius', async () => {
    const customer = await makeCustomer();
    // ~1.1 km north: well inside the 10 km radius, and not zero.
    await makeInspector(ORDER_LAT + 0.01, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    const m = detail.body.money;
    expect(m.freeRadiusKm).toBe(10);
    expect(m.billedDistanceKm).toBe(0);
    expect(m.distanceFeeCents).toBe(0);
    expect(m.distanceKm).toBeNull();
  });

  /*
   * One page, one basis. `duration_min` stores the BILLED minutes, the same
   * quantity `distance_km` stores — but the detail derived the distance back to
   * one direction and left the minutes alone, so an order 38 km away was shown
   * as "38 km" beside "114 min". That reads as a traffic jam, not a return
   * trip, and no arithmetic on the page recovers either fee.
   */
  it('3d5. the detail reports the distance and the minutes on the same basis', async () => {
    const customer = await makeCustomer();
    // ~22 km north — outside the free radius, so both measurements survive.
    await makeInspector(ORDER_LAT + 0.2, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    const m = detail.body.money;
    expect(m.returnTripFactor).toBe(2);
    // Measured beside measured, billed beside billed.
    expect(m.billedDistanceKm).toBeCloseTo((m.distanceKm - m.freeRadiusKm) * 2, 1);
    expect(m.billedDurationMin).toBe(m.durationMin * 2);
    // And the fee is charged on the billed quantities, which is what the page
    // must put in the row labels for the column to add up.
    expect(m.distanceFeeCents).toBe(
      Math.round(m.billedDistanceKm * PLATFORM_SETTING_DEFAULTS.orderRatePerKmEur * 100),
    );
    expect(m.timeFeeCents).toBe(
      Math.round(m.billedDurationMin * PLATFORM_SETTING_DEFAULTS.orderRatePerMinuteEur * 100),
    );
  });

  // The cap must refuse where the money is not yet committed. An order created
  // beyond it authorizes the customer's card and then waits the whole search
  // window for a cron to cancel it, because no inspector takes such a job.
  it('3d3. beyond the cap the quote refuses and the order is rejected', async () => {
    const customer = await makeCustomer();
    // ~33 km north; the cap is pinned below that for this test.
    await makeInspector(ORDER_LAT + 0.3, ORDER_LNG);
    const tight = await pinTariff(app, { orderCapKm: 20 });

    try {
      const quote = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      expect(quote.body.available).toBe(false);
      expect(quote.body.refusal).toBe('too_far');
      // Still a lead: someone wants an inspection where we do not serve.
      expect(quote.body.waitlisted).toBe(true);
      createdWaitlistEmails.add(customer.email);

      const create = await request(app.getHttpServer())
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
        .expect(409);

      // A distinct code from no_coverage: the UI says different things.
      expect(create.body.error.code).toBe('distance_cap_exceeded');
      // And the shipped cap is the owner's 100 km, not whatever is in the file.
      expect(PLATFORM_SETTING_DEFAULTS.orderCapKm).toBe(300);
    } finally {
      await tight.restore();
      tariff = await pinTariff(app);
    }
  });

  // ============================================================
  // 3e. The band decides the base fee
  // ============================================================
  //
  // The bands are named after the price level index, not after a region: the
  // same inspection is cheaper where an expert hour is cheaper, and Chile
  // belongs with Spain rather than with its continent. The geocoder is stood up per case:
  // the location is the same Berlin point every time, and it is the COUNTRY the
  // tariff resolves on, not the coordinates.
  it('3e. a Polish address is priced on the 60-75 price-level band', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const spy = jest
      .spyOn(app.get(GeocodingService), 'countryCodeFor')
      .mockResolvedValue('PL');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      expect(res.body.breakdown.baseFeeCents).toBe(2700);
      // The floor moves with the base fee. Left at 49 EUR it would bind first
      // and the whole band would have no effect on what anybody pays.
      expect(res.body.breakdown.minimumFareCents).toBe(3400);
      expect(res.body.totalCents).toBe(3400);
    } finally {
      spy.mockRestore();
    }
  });

  it('3e2. a Ukrainian address is priced on the lowest price-level band', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const spy = jest
      .spyOn(app.get(GeocodingService), 'countryCodeFor')
      .mockResolvedValue('UA');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      expect(res.body.breakdown.baseFeeCents).toBe(1900);
      expect(res.body.breakdown.minimumFareCents).toBe(2400);
    } finally {
      spy.mockRestore();
    }
  });

  // Germany is the anchor: its band sets no money at all, so the global tariff
  // answers and an operator's admin-panel change still reaches the price.
  it('3e5. a German address follows the global tariff, not a band copy', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const spy = jest
      .spyOn(app.get(GeocodingService), 'countryCodeFor')
      .mockResolvedValue('DE');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      expect(res.body.breakdown.baseFeeCents).toBe(
        Math.round(PLATFORM_SETTING_DEFAULTS.orderBaseFeeEur * 100),
      );
      expect(res.body.totalCents).toBe(FARE.totalCents);
    } finally {
      spy.mockRestore();
    }
  });

  // The minute rate is banded too, and it is the term that decides a LONG job:
  // on a co-located order the floor hides it, so this case puts the inspector
  // ~22 km away, where the fare is mostly travel.
  it('3e6. a Polish address pays the band rate for travel time', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT + 0.2, ORDER_LNG);
    const spy = jest
      .spyOn(app.get(GeocodingService), 'countryCodeFor')
      .mockResolvedValue('PL');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      const b = res.body.breakdown;
      // Above the floor, so the band terms actually reach the total.
      expect(b.subtotalCents).toBeGreaterThan(b.minimumFareCents);
      // A literal, not the seeded column: the number is the 0.35/39 ratio
      // applied to a 27 EUR base, and reading it back out of the row it came
      // from would pass for any value.
      expect(b.timeFeeCents).toBe(Math.round(b.billedDurationMin * 24));
      expect(b.timeFeeCents).toBeLessThan(
        Math.round(b.billedDurationMin * PLATFORM_SETTING_DEFAULTS.orderRatePerMinuteEur * 100),
      );
      // The kilometre rate is NOT banded — it is a per-country national
      // mileage allowance, and Poland has its own (see 3e8).
    } finally {
      spy.mockRestore();
    }
  });

  // The kilometre rate is a per-COUNTRY figure, not a band one: Poland and
  // Ukraine share no band, and each carries its own national allowance.
  it('3e8. a Polish address pays the Polish mileage allowance, not the German one', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT + 0.2, ORDER_LNG);
    const spy = jest
      .spyOn(app.get(GeocodingService), 'countryCodeFor')
      .mockResolvedValue('PL');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      const b = res.body.breakdown;
      // PLN 1.15 at the ECB rate of 2026-08-12. A literal, because reading it
      // back out of the row it came from would pass for any number.
      expect(b.distanceFeeCents).toBe(Math.round(b.billedDistanceKm * 27));
      // The country row must also state the return-trip factor, or a rate
      // defined on the round trip would collect half of itself.
      expect(b.returnTripFactor).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('3e9. a Ukrainian address pays the fuel-derived rate', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT + 0.2, ORDER_LNG);
    const spy = jest
      .spyOn(app.get(GeocodingService), 'countryCodeFor')
      .mockResolvedValue('UA');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      expect(res.body.breakdown.distanceFeeCents).toBe(
        Math.round(res.body.breakdown.billedDistanceKm * 19),
      );
    } finally {
      spy.mockRestore();
    }
  });

  // A per-MILE allowance converted as if it were per-km is wrong by 1.6 in the
  // customer's disfavour, and nothing about the resulting number looks wrong.
  it('3e10. a British address pays the per-mile allowance converted to kilometres', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT + 0.2, ORDER_LNG);
    const spy = jest
      .spyOn(app.get(GeocodingService), 'countryCodeFor')
      .mockResolvedValue('GB');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      // 55p/mile at the ECB rate of 2026-08-12 is 0.40 EUR per KILOMETRE. Read
      // as per-km it would be 0.64 — the failure this literal exists to catch.
      expect(res.body.breakdown.distanceFeeCents).toBe(
        Math.round(res.body.breakdown.billedDistanceKm * 40),
      );
    } finally {
      spy.mockRestore();
    }
  });

  // A data invariant, not a code path: these allowances are all defined on the
  // round trip, so a country that sets a rate and stays silent on the factor
  // would collect half of what it claims the moment the global factor moves.
  it('3e11. every country rate states its own return-trip factor', async () => {
    const rows = await prisma.countryTariff.findMany({
      where: { perKmCents: { not: null } },
    });

    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) {
      expect(Number(row.returnTripFactor)).toBe(2);
      // And says where the number came from: a rate with no provenance is
      // indistinguishable from a typo.
      expect(row.derivation).toBeTruthy();
      expect(row.sourceUrl).toBeTruthy();
    }
    // A converted rate must carry the rate and the day it was taken, or
    // "we charge exactly the national rate" cannot be checked later.
    for (const row of rows.filter((r) => r.sourceCurrency !== 'EUR')) {
      expect(row.fxRate).toBeTruthy();
      expect(row.fxDate).toBeTruthy();
    }
  });

  /*
   * A regional free radius must reach the PRICE, not only the response.
   *
   * `resolveTariff` returned the resolved radius in `limits` and left the
   * global value on the tariff — and the fare reads the tariff. So the row was
   * loaded, `sources.freeRadiusKm` said 'zone', the quote echoed the global 10,
   * and the fee did not move by a cent. The cap worked, because the caller
   * reads THAT one out of `limits` by hand, which is exactly why nobody saw it.
   *
   * The test asserts the fee, never the echoed field: an assertion on
   * `breakdown.freeRadiusKm` alone would have passed throughout.
   */
  it('3e12. a band free radius changes what the customer pays', async () => {
    const customer = await makeCustomer();
    // ~29 km of road north (22 km straight, times the detour factor): charged
    // under the global 10 km radius, free under 40.
    await makeInspector(ORDER_LAT + 0.2, ORDER_LNG);
    const zone = await prisma.pricingZone.findUnique({ where: { key: 'pl_60_75' } });
    const previous = zone!.freeRadiusKm;
    const spy = jest.spyOn(app.get(GeocodingService), 'countryCodeFor').mockResolvedValue('PL');

    try {
      const quote = async () =>
        (
          await request(app.getHttpServer())
            .post('/api/v1/orders/quote')
            .set('Authorization', `Bearer ${customer.token}`)
            .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
            .expect(200)
        ).body;

      const charged = await quote();
      expect(charged.breakdown.distanceFeeCents).toBeGreaterThan(0);

      // No cache to bust: the band rows are read from the database on every
      // quote, which is what makes an operator's edit take effect at once.
      await prisma.pricingZone.update({
        where: { key: 'pl_60_75' },
        data: { freeRadiusKm: 40 },
      });

      const free = await quote();
      expect(free.breakdown.freeRadiusKm).toBe(40);
      expect(free.breakdown.chargeableDistanceKm).toBe(0);
      expect(free.breakdown.distanceFeeCents).toBe(0);
      expect(free.totalCents).toBeLessThan(charged.totalCents);
    } finally {
      await prisma.pricingZone.update({
        where: { key: 'pl_60_75' },
        data: { freeRadiusKm: previous },
      });
      spy.mockRestore();
    }
  });

  // The anchor holds no minute rate either, so `orderRatePerMinuteEur` stays a
  // live lever in the admin panel for the countries that follow the global
  // tariff. A band that restated 35 would have taken it away silently.
  it('3e7. a German address still pays the global rate for travel time', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT + 0.2, ORDER_LNG);
    const spy = jest
      .spyOn(app.get(GeocodingService), 'countryCodeFor')
      .mockResolvedValue('DE');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      const b = res.body.breakdown;
      expect(b.timeFeeCents).toBe(
        Math.round(b.billedDurationMin * PLATFORM_SETTING_DEFAULTS.orderRatePerMinuteEur * 100),
      );
    } finally {
      spy.mockRestore();
    }
  });

  // Coverage without rows: a country nobody has configured must still be able
  // to order, at the global tariff. This is what lets the country map stay
  // short instead of listing the world.
  it('3e3. an unlisted country falls through to the global tariff', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const spy = jest
      .spyOn(app.get(GeocodingService), 'countryCodeFor')
      .mockResolvedValue('MN'); // Mongolia: no row, no band

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders/quote')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({ lat: ORDER_LAT, lng: ORDER_LNG, scheduledAt: SCHEDULED_AT })
        .expect(200);

      expect(res.body.available).toBe(true);
      expect(res.body.breakdown.baseFeeCents).toBe(
        Math.round(PLATFORM_SETTING_DEFAULTS.orderBaseFeeEur * 100),
      );
      expect(res.body.totalCents).toBe(FARE.totalCents);
    } finally {
      spy.mockRestore();
    }
  });

  // The order must be charged what the quote showed, so both must resolve the
  // same country. Asking the geocoder twice could answer differently.
  it('3e4. the order is created with the band the quote was priced on', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const spy = jest
      .spyOn(app.get(GeocodingService), 'countryCodeFor')
      .mockResolvedValue('PL');

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customer.token}`)
        .send({
          make: 'BMW',
          model: '320d',
          address: 'ul. Testowa 1, Poznań',
          lat: ORDER_LAT,
          lng: ORDER_LNG,
          scheduledAt: SCHEDULED_AT,
        })
        .expect(201);
      trackOrder(res.body.orderId);

      const order = await prisma.order.findUnique({ where: { id: res.body.orderId } });
      expect(order!.countryCode).toBe('PL');
      expect(order!.baseFeeCents).toBe(2700);
      expect(order!.totalCents).toBe(3400);
    } finally {
      spy.mockRestore();
    }
  });

  // ============================================================
  // 4. Offer accept → ASSIGNED (and still no contacts either way)
  // ============================================================
  it('4. offer accept → ASSIGNED with inspectorId; contacts stay closed', async () => {
    const customer = await makeCustomer();
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Hans Müller' });
    const { orderId } = await createPaidOrder(customer);

    const assignedId = await acceptPendingOffer(orderId);
    expect(assignedId).toBe(inspector.userId);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('ASSIGNED');
    expect(order!.inspectorId).toBe(inspector.userId);

    // The money is taken HERE, not at creation: acceptance is the first moment
    // anyone has agreed to do the work. An order must never be ASSIGNED with
    // uncaptured money.
    const payment = await prisma.payment.findUnique({ where: { orderId } });
    expect(payment!.status).toBe('succeeded');
    expect(payment!.capturedAt).toBeTruthy();
    expect(payment!.authorizedAt!.getTime()).toBeLessThanOrEqual(
      payment!.capturedAt!.getTime(),
    );

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    // Assignment does NOT disclose the inspector — that waits for COMPLETED.
    expect(detail.body.inspectorContact).toBeNull();

    // The three optional blocks the website is written against.
    expect(detail.body.payment).toMatchObject({
      state: 'captured',
      amountCents: FARE.totalCents,
    });
    expect(detail.body.payment.capturedAt).toBeTruthy();
    expect(detail.body.payment.releasedAt).toBeNull();
    expect(detail.body.search.deadlineAt).toBeTruthy();
    expect(detail.body.search.expiredAt).toBeNull();
    // Readable while ASSIGNED — before the inspector drives anywhere — which is
    // the entire reason it is returned in every status: telling someone what
    // the report must contain once they have filed it is telling them too late.
    //
    // The four counts arrived with the completeness gate on 2026-08-13 and are
    // OPTIONAL on the wire so the website could ship before or after this
    // backend. `minQualityScore` survives with its old name and a new job: it
    // is now only read for its sign — above zero the gate runs, at zero it does
    // not — which `gateEnabled` states outright so no client has to infer it.
    expect(detail.body.reportRequirement).toEqual({
      minQualityScore: PLATFORM_SETTING_DEFAULTS.minReportQualityScore,
      currentQualityScore: null,
      gateEnabled: true,
      exteriorAngles: currentRequiredAngles().length,
      thicknessPanels: thicknessPanelIds().length,
      calibrationPhotos: 2,
      wheels: 4,
    });
  });

  // ============================================================
  // 4b. Contact channels — one direction, and only once the job is finished
  // ============================================================
  it('4b. discloses every channel the inspector set — to the customer, once the job ends, and to nobody else', async () => {
    const customer = await makeCustomer();
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Hans Müller' });
    await prisma.user.update({
      where: { id: customer.userId },
      data: { name: 'Klara Kunde', phone: '+49301111111' },
    });

    // The inspector fills in the work channels through the real endpoint, so the
    // normalisation on save is exercised rather than bypassed by a direct write.
    await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({
        contactPhone: '+49 176 1234567',
        contactEmail: 'kontakt@kfz-mueller.de',
        contactWhatsapp: true,
        contactTelegram: 'https://t.me/kfz_mueller?start=1',
      })
      .expect(200);

    const { orderId } = await createPaidOrder(customer);

    // An inspector who only HOLDS an offer is not a party to the order yet.
    const pending = await prisma.orderOffer.findFirst({
      where: { orderId, status: 'PENDING' },
      select: { inspectorId: true },
    });
    const offerHolderToken = inspectorTokens.get(pending!.inspectorId)!;
    const offerHolderView = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${offerHolderToken}`)
      .expect(200);
    expect(offerHolderView.body.customerContact ?? null).toBeNull();

    await acceptPendingOffer(orderId);

    /*
     * ⚠ THE WHOLE JOB HAPPENS WITH THE CONTACTS CLOSED.
     *
     * Assignment, the drive, the inspection and the filed report all pass
     * without either side seeing the other's channels. Asserting only the
     * COMPLETED case would pass just as happily against a gate that opened at
     * assignment, which is exactly what this used to do.
     */
    for (const stage of ['ASSIGNED', 'EN_ROUTE', 'IN_PROGRESS'] as const) {
      if (stage !== 'ASSIGNED') {
        await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/status`)
          .set('Authorization', `Bearer ${inspector.token}`)
          .send({ status: stage })
          .expect(200);
      }
      const mid = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${customer.token}`)
        .expect(200);
      expect(mid.body.status).toBe(stage);
      expect(mid.body.inspectorContact).toBeNull();
    }

    /*
     * The status gate binds the CUSTOMER only. A dispute is opened precisely
     * when an order did NOT finish, so an admin restricted to COMPLETED would be
     * blind on exactly the orders they are needed for.
     */
    const dutyAdmin = await makeAdmin();
    const midAdmin = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${dutyAdmin.token}`)
      .expect(200);
    expect(midAdmin.body.status).toBe('IN_PROGRESS');
    expect(midAdmin.body.inspectorContact?.email).toBe('kontakt@kfz-mueller.de');
    expect(midAdmin.body.customerContact?.email).toBe(customer.email);

    await orders.submitReportForOrder(orderId);
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    // APPROVED is the customer accepting the report — still not disclosure.
    const approved = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.inspectorContact).toBeNull();

    // COMPLETED is reached by a real payout, never by writing the status.
    await prisma.inspectorProfile.update({
      where: { userId: inspector.userId },
      data: { stripeAccountId: `acct_test_${inspector.userId}` },
    });
    await orders.releasePayout(orderId);

    const forCustomer = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(forCustomer.body.status).toBe('COMPLETED');
    expect(forCustomer.body.inspectorContact).toMatchObject({
      name: 'Hans Müller',
      companyName: 'KFZ Test GmbH',
      // The work address wins over the registration one.
      email: 'kontakt@kfz-mueller.de',
      phone: '+491761234567',
      // Bare digits for wa.me, bare username for t.me — normalised on save.
      whatsapp: '491761234567',
      telegram: 'kfz_mueller',
    });
    // The customer never sees their own block on their own order.
    expect(forCustomer.body.customerContact ?? null).toBeNull();

    /*
     * ⚠ AND THE INSPECTOR NEVER SEES THE CUSTOMER — not even here, with the job
     * finished and paid. An inspector holding the customer's number can arrange
     * the next job directly, which takes the platform out of its own market.
     * The address and the appointment ride on the order; the work needs no
     * personal channel.
     */
    const forInspector = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${inspector.token}`)
      .expect(200);
    expect(forInspector.body.customerContact ?? null).toBeNull();
    // Nor their own block, which once rendered as "the customer's contacts".
    expect(forInspector.body.inspectorContact ?? null).toBeNull();

    // An admin sees both — a dispute cannot be settled without reaching either.
    const admin = await makeAdmin();
    const forAdmin = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(forAdmin.body.inspectorContact?.email).toBe('kontakt@kfz-mueller.de');
    expect(forAdmin.body.customerContact).toMatchObject({
      name: 'Klara Kunde',
      phone: '+49301111111',
      email: customer.email,
      // A customer has no inspector profile, so these cannot be set.
      companyName: null,
      whatsapp: null,
      telegram: null,
    });
  });

  it('4b1. a parked payout keeps the order APPROVED — and the contacts closed', async () => {
    /*
     * The accepted cost of "disclose only when it is finished", pinned so it is
     * a known consequence rather than a surprise in support.
     *
     * COMPLETED is reached by a successful PAYOUT, not by the inspection. An
     * inspector without a Stripe account id is not payout-eligible, so
     * `releasePayout` parks the money and the order correctly stays APPROVED —
     * and the customer, whose car has been inspected and whose report has been
     * accepted, still cannot see who looked at it. Unsticking that is the admin
     * finance queue's job.
     */
    const customer = await makeCustomer();
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Hans Müller' });
    await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({
        contactPhone: '+49 176 1234567',
        contactWhatsapp: true,
        contactTelegram: '@kfz_mueller',
      })
      .expect(200);

    const { orderId } = await createPaidOrder(customer);
    await acceptPendingOffer(orderId);
    await orders.submitReportForOrder(orderId);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    // No stripeAccountId is set, so the payout cannot settle.
    const outcome = await orders.releasePayout(orderId);
    expect(outcome.status).toBe('parked');

    const stuck = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(stuck.body.status).toBe('APPROVED');
    expect(stuck.body.inspectorContact).toBeNull();

    // Once the payout goes through, the same order discloses.
    await prisma.inspectorProfile.update({
      where: { userId: inspector.userId },
      data: { stripeAccountId: `acct_test_${inspector.userId}` },
    });
    await orders.releasePayout(orderId);
    const completed = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(completed.body.status).toBe('COMPLETED');
    expect(completed.body.inspectorContact).toMatchObject({
      phone: '+491761234567',
      whatsapp: '491761234567',
      telegram: 'kfz_mueller',
    });
  });

  it('4b2. an erased inspector discloses nothing — not even the tombstone address', async () => {
    const customer = await makeCustomer();
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Hans Müller' });
    await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ contactTelegram: 'kfz_mueller', contactEmail: 'kontakt@kfz-mueller.de' })
      .expect(200);

    const { orderId } = await createPaidOrder(customer);
    await acceptPendingOffer(orderId);

    /*
     * ⚠ THE ORDER MUST REACH COMPLETED FIRST.
     *
     * Contacts are closed until then, so erasing at ASSIGNED and asserting
     * `null` would prove nothing about erasure — the status gate alone would
     * satisfy it. The disclosure has to be genuinely OPEN before it can be
     * shown to close.
     */
    await orders.submitReportForOrder(orderId);
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    await prisma.inspectorProfile.update({
      where: { userId: inspector.userId },
      data: { stripeAccountId: `acct_test_${inspector.userId}` },
    });
    await orders.releasePayout(orderId);

    const disclosed = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(disclosed.body.status).toBe('COMPLETED');
    expect(disclosed.body.inspectorContact?.email).toBe('kontakt@kfz-mueller.de');

    await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${inspector.token}`)
      .expect(204);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    // Erasure ANONYMISES: the row survives with deleted+<id>@carsalepro.invalid.
    // Without the deletedAt check in resolveContact the email fallback would
    // publish that tombstone to the customer as a live mailto: link.
    expect(detail.body.inspectorContact).toBeNull();

    const profile = await prisma.inspectorProfile.findUnique({
      where: { userId: inspector.userId },
    });
    expect(profile).toMatchObject({
      contactPhone: null,
      contactEmail: null,
      contactWhatsapp: false,
      contactTelegram: null,
    });
  });

  it('4b2b. a dispute discloses nothing to either side — only the admin holds both', async () => {
    /*
     * DISPUTED is NOT a disclosure point, and this test exists because it very
     * nearly became one. A dispute is arbitrated by the platform: giving the two
     * sides each other's channels mid-conflict moves the argument off the
     * platform, where nobody can see it and no admin can settle it.
     *
     * The admin holds both sides in every status, which is what makes that
     * workable — asserted below, since a rule that silences both parties is only
     * defensible if somebody can still reach them.
     */
    const customer = await makeCustomer();
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Hans Müller' });
    await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ contactEmail: 'kontakt@kfz-mueller.de', contactPhone: '+49 176 1234567' })
      .expect(200);

    const { orderId } = await createPaidOrder(customer);
    await acceptPendingOffer(orderId);
    for (const status of ['EN_ROUTE', 'IN_PROGRESS'] as const) {
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${inspector.token}`)
        .send({ status })
        .expect(200);
    }

    // Still closed while the job merely runs.
    const running = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(running.body.inspectorContact).toBeNull();

    // Only the CUSTOMER may open a dispute; the inspector is refused.
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ reason: 'not mine to open' })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ reason: 'Der Innenraum wurde nicht begutachtet.' })
      .expect(200);

    const disputed = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(disputed.body.status).toBe('DISPUTED');
    expect(disputed.body.inspectorContact).toBeNull();

    // The reverse direction is not a status question: it never opens.
    const forInspector = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${inspector.token}`)
      .expect(200);
    expect(forInspector.body.customerContact ?? null).toBeNull();

    // The admin still reaches both — otherwise a disputed order would be a
    // conflict nobody on the platform can act on.
    const arbiter = await makeAdmin();
    const forAdmin = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${arbiter.token}`)
      .expect(200);
    expect(forAdmin.body.inspectorContact?.email).toBe('kontakt@kfz-mueller.de');
    expect(forAdmin.body.customerContact?.email).toBe(customer.email);
  });

  it('4b3. refuses a malformed Telegram username instead of silently dropping it', async () => {
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG);
    const res = await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ contactTelegram: 'kfz mueller' })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_telegram_username');
  });

  it('4b4. the profile round-trips through an edit form without losing its channels', async () => {
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG);
    const saved = {
      contactPhone: '+49 176 1234567',
      contactEmail: 'kontakt@kfz-mueller.de',
      contactWhatsapp: true,
      contactTelegram: '@kfz_mueller',
    };
    await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send(saved)
      .expect(200);

    /*
     * ⚠ THE READ MUST CARRY THE RAW COLUMNS, NOT ONLY THE RESOLVED `contact`.
     *
     * The website's profile form is controlled and seeds its state from these
     * four keys. While the response held only `contact`, every field rendered
     * empty beside a preview showing the saved values, and the form then sent
     * all four back blank on the next save — which this service reads as
     * "clear". Asserting `contact` alone would pass against exactly that bug.
     */
    const read = await request(app.getHttpServer())
      .get('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .expect(200);
    expect(read.body).toMatchObject({
      contactPhone: '+491761234567',
      contactEmail: 'kontakt@kfz-mueller.de',
      contactWhatsapp: true,
      // Stored bare, so the form shows what the customer will be linked to.
      contactTelegram: 'kfz_mueller',
    });

    // Now save again with exactly what a form built from that response submits,
    // changing something unrelated — the radius. This is the ordinary edit that
    // used to answer 400 and, once that was fixed, would have wiped the lot.
    const resave = await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({
        searchRadiusKm: 42,
        contactPhone: read.body.contactPhone,
        contactEmail: read.body.contactEmail,
        contactWhatsapp: read.body.contactWhatsapp,
        contactTelegram: read.body.contactTelegram,
      })
      .expect(200);
    // The stored forms, not what was typed: re-saving what the read returned is
    // a FIXED POINT — normalisation runs on write, so a form that echoes the
    // response back must not drift the number or the username on every save.
    expect(resave.body).toMatchObject({
      searchRadiusKm: 42,
      contactPhone: '+491761234567',
      contactEmail: 'kontakt@kfz-mueller.de',
      contactWhatsapp: true,
      contactTelegram: 'kfz_mueller',
    });
    expect(resave.body.contact).toMatchObject({
      email: 'kontakt@kfz-mueller.de',
      whatsapp: '491761234567',
      telegram: 'kfz_mueller',
    });
  });

  it('4b5. an empty contact email CLEARS the channel rather than failing validation', async () => {
    const inspector = await makeInspector(ORDER_LAT, ORDER_LNG);
    await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ contactEmail: 'kontakt@kfz-mueller.de', contactPhone: '+49 176 1234567' })
      .expect(200);

    // Blank is the clear instruction — the same one the other three channels
    // have always accepted. `@IsEmail` made this field alone answer 400.
    const cleared = await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ contactEmail: '', contactPhone: '' })
      .expect(200);
    expect(cleared.body.contactEmail).toBeNull();
    expect(cleared.body.contactPhone).toBeNull();
    // Cleared, not orphaned: the disclosure falls back to the account address.
    expect(cleared.body.contact.email).toBe(inspector.email);

    // A genuinely malformed address is still refused.
    await request(app.getHttpServer())
      .patch('/api/v1/inspector/profile')
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ contactEmail: 'not-an-email' })
      .expect(400);
  });

  // ============================================================
  // 5. Offer decline → cascade to next inspector
  // ============================================================
  it('5. offer decline cascades to the next nearest inspector', async () => {
    const customer = await makeCustomer();
    const near = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Near' });
    // Second inspector ~10km north, still inside the radius.
    const far = await makeInspector(ORDER_LAT + 0.09, ORDER_LNG, { name: 'Far' });
    const { orderId } = await createPaidOrder(customer);

    const firstOffer = await pendingOfferFor(orderId);
    expect(firstOffer!.inspectorId).toBe(near.userId);

    await request(app.getHttpServer())
      .post(`/api/v1/offers/${firstOffer!.id}/decline`)
      .set('Authorization', `Bearer ${near.token}`)
      .expect(200);

    // The declined offer is now DECLINED and a new PENDING offer exists for far.
    const declined = await prisma.orderOffer.findUnique({ where: { id: firstOffer!.id } });
    expect(declined!.status).toBe('DECLINED');

    const nextOffer = await pendingOfferFor(orderId);
    expect(nextOffer).toBeTruthy();
    expect(nextOffer!.inspectorId).toBe(far.userId);
  });

  // ============================================================
  // 5c. Each offer records how far ITS inspector is
  // ============================================================
  //
  // The order is priced on the nearest candidate and the price is frozen, so
  // once dispatch walks past that candidate the inspector who accepts travels
  // further than the customer paid for. This asserts the gap is now recorded —
  // it does not change any money.
  it('5c. an offer records the distance of the inspector it went to', async () => {
    const customer = await makeCustomer();
    const near = await makeInspector(ORDER_LAT, ORDER_LNG, { name: 'Near' });
    await makeInspector(ORDER_LAT + 0.09, ORDER_LNG, { name: 'Far' });
    const { orderId } = await createPaidOrder(customer);

    const firstOffer = await pendingOfferFor(orderId);
    expect(Number(firstOffer!.straightLineKm)).toBeCloseTo(0, 1);

    await request(app.getHttpServer())
      .post(`/api/v1/offers/${firstOffer!.id}/decline`)
      .set('Authorization', `Bearer ${near.token}`)
      .expect(200);

    const nextOffer = await pendingOfferFor(orderId);
    // About 10 km north. The customer paid for the co-located inspector.
    expect(Number(nextOffer!.straightLineKm)).toBeGreaterThan(9);
    expect(Number(nextOffer!.straightLineKm)).toBeLessThan(11);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(Number(order!.distanceKm)).toBeLessThan(1);
  });

  // ============================================================
  // 5b. Decline with no one left → UNASSIGNED
  // ============================================================
  it('5b. decline with no inspector left → order UNASSIGNED', async () => {
    const customer = await makeCustomer();
    const only = await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);

    const offer = await pendingOfferFor(orderId);
    await request(app.getHttpServer())
      .post(`/api/v1/offers/${offer!.id}/decline`)
      .set('Authorization', `Bearer ${only.token}`)
      .expect(200);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('UNASSIGNED');
    const pending = await pendingOfferFor(orderId);
    expect(pending).toBeNull();
  });

  // ============================================================
  // 6. Status EN_ROUTE → IN_PROGRESS; illegal jump → 409
  // ============================================================
  it('6. assigned inspector pushes EN_ROUTE then IN_PROGRESS; illegal jump → 409', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    const assignedId = await acceptPendingOffer(orderId);
    const inspToken = inspectorTokens.get(assignedId)!;

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ status: 'EN_ROUTE' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('IN_PROGRESS');

    // Illegal: IN_PROGRESS → EN_ROUTE is not an allowed edge.
    const bad = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ status: 'EN_ROUTE' })
      .expect(409);
    expect(bad.body.error.code).toBe('illegal_transition');
  });

  // ============================================================
  // 7. Cancel before assignment RELEASES the hold — it is not a refund
  // ============================================================
  it('7. cancel from PAID releases the authorization: refundCents 0, no Refund row', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(res.body.status).toBe('CANCELLED');
    // Nothing was ever taken from the card, so nothing goes back. `refundCents`
    // alone cannot say that — 0 also means "we refunded you nothing" — which is
    // exactly why `refundMode` exists.
    expect(res.body.refundCents).toBe(0);
    expect(res.body.refundMode).toBe('authorization_released');

    // A Refund row means money went back. An uncaptured hold never left the
    // customer, so writing one would double-count every hold-and-release in the
    // finance ledger.
    expect(await prisma.refund.count({ where: { orderId } })).toBe(0);

    const payment = await prisma.payment.findUnique({ where: { orderId } });
    expect(payment!.status).toBe('cancelled');
    expect(payment!.canceledAt).toBeTruthy();
    expect(payment!.capturedAt).toBeNull();

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(detail.body.payment.state).toBe('released');
    expect(detail.body.payment.releasedAt).toBeTruthy();
  });

  // ============================================================
  // 8. Cancel from ASSIGNED → CANCELLED + 80% refund
  // ============================================================
  it('8. cancel from ASSIGNED → CANCELLED + Refund 80% (the money WAS taken)', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    await acceptPendingOffer(orderId);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.refundCents).toBe(Math.round(FARE.totalCents * 0.8)); // 80%
    // Past acceptance the funds are captured, so this really is a refund — the
    // counterpart of case 7 and the reason the two cannot share one word.
    expect(res.body.refundMode).toBe('refunded');

    const refund = await prisma.refund.findFirst({ where: { orderId } });
    expect(refund!.amountCents).toBe(Math.round(FARE.totalCents * 0.8));
    expect(refund!.reason).toBe('cancel_after_assign');
    expect(refund!.status).toBe('succeeded');

    // The refund is settled BEFORE the transition now, and it must be recorded
    // exactly once per (order, reason) — the pair is unique for that reason.
    expect(await prisma.refund.count({ where: { orderId } })).toBe(1);
  });

  // ============================================================
  // 9. Cancel from IN_PROGRESS → 409 (dispute required)
  // ============================================================
  it('9. cancel from IN_PROGRESS → 409 not_cancellable', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    const assignedId = await acceptPendingOffer(orderId);
    const inspToken = inspectorTokens.get(assignedId)!;
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ status: 'EN_ROUTE' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(409);
    expect(res.body.error.code).toBe('not_cancellable');
  });

  // ============================================================
  // 10. Dispute from SUBMITTED → DISPUTED
  // ============================================================
  it('10. dispute from SUBMITTED → DISPUTED + Dispute row', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    await acceptPendingOffer(orderId);
    // Drive to SUBMITTED via the service (single source for transitions).
    await orders.submitReportForOrder(orderId);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/dispute`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ reason: 'Report incomplete' })
      .expect(200);
    expect(res.body.status).toBe('DISPUTED');

    const dispute = await prisma.dispute.findUnique({ where: { orderId } });
    expect(dispute!.reason).toBe('Report incomplete');
    expect(dispute!.status).toBe('OPEN');
  });

  // ============================================================
  // 11. Report upload with orderId transitions IN_PROGRESS → SUBMITTED
  // ============================================================
  it('11. report upload with orderId transitions order to SUBMITTED + sets autoApproveAt', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    const assignedId = await acceptPendingOffer(orderId);
    const inspToken = inspectorTokens.get(assignedId)!;
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ status: 'EN_ROUTE' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    // Inspector's device files the report against the order. The device must be
    // linked to the assigned inspector's account — filing a report against
    // someone else's order is now a 403 (BE-S7), so the link is part of the
    // happy path rather than an optional extra.
    const deviceId = uniqueDeviceId('insp-dev');
    await prisma.deviceLink.create({
      data: { deviceId, userId: assignedId, linkedVia: 'e2e' },
    });
    const code = `CSP-${Date.now().toString().slice(-6)}`;
    const r2Off = !(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY
    );
    const reportRes = await request(app.getHttpServer())
      .post('/reports')
      .set('X-Device-Id', deviceId)
      // A full `reportData` payload is now part of the happy path: an order can
      // only be closed with a report that covers the car, and since 2026-08-13
      // "covers" is judged from the payload's own manifest — every exterior
      // angle, every paint panel with a reading and a photo, both calibration
      // shots, all four wheels. The score rides along and decides nothing.
      // The gate runs before quota and before R2, so an unjudgeable payload
      // would 409 here rather than reaching either.
      .send({
        code,
        orderId,
        make: 'BMW',
        model: '320d',
        qualityScore: 95,
        reportSchemaVersion: 1,
        reportData: completeReportData(),
      });

    if (r2Off) {
      // Without R2 the report-create returns 503 — but the order side effect runs
      // only on the success path. Skip the assertion when storage is unavailable
      // and instead drive the transition through the service to assert the shape.
      expect(reportRes.status).toBe(503);
      await orders.submitReportForOrder(orderId);
    } else {
      expect(reportRes.status).toBe(201);
      // clean up the report row created under this device
      await prisma.report.deleteMany({ where: { orderId } });
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('SUBMITTED');
    expect(order!.submittedAt).toBeTruthy();
    expect(order!.autoApproveAt).toBeTruthy();
    // autoApproveAt ≈ now + 7 days.
    const days = (order!.autoApproveAt!.getTime() - order!.submittedAt!.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
  });

  it('11b. attaching a report for a different vehicle is refused', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    await prisma.order.update({
      where: { id: orderId },
      data: { vin: 'WBA8E9G55JNU12345' },
    });
    const assignedId = await acceptPendingOffer(orderId);
    const inspToken = inspectorTokens.get(assignedId)!;
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ status: 'EN_ROUTE' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    const report = await prisma.report.create({
      data: {
        deviceId: uniqueDeviceId('mismatch'),
        code: `CSP-${Date.now().toString().slice(-6)}`,
        vin: 'WAUZZZF41GA000001',
        make: 'Audi',
        model: 'A4 Avant',
        s3Key: 'test/mismatch.pdf',
        tier: 'free',
        uploaded: true,
        // No payload, and deliberately so: the vehicle check runs BEFORE the
        // completeness gate, so "this is the wrong car" is what an inspector is
        // told first — the more useful of the two, and the only one that is
        // worth acting on. This case would still be a 409 either way, so it
        // asserts the CODE to prove which check answered.
        qualityScore: 95,
        userId: assignedId,
      },
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/report`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ code: report.code })
      .expect(409);

    expect(res.body.error.code).toBe('report_vehicle_mismatch');
    const [orderAfter, reportAfter] = await Promise.all([
      prisma.order.findUnique({ where: { id: orderId } }),
      prisma.report.findUnique({ where: { id: report.id } }),
    ]);
    expect(orderAfter!.status).toBe('IN_PROGRESS');
    expect(reportAfter!.orderId).toBeNull();

    await prisma.report.delete({ where: { id: report.id } });
  });

  // ============================================================
  // 11c. F-02 — a lower-case uuid Report ID attaches (it is what the app mints)
  // ============================================================
  it('11c. attaching a report whose code is a LOWER-CASE uuid succeeds', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    const assignedId = await acceptPendingOffer(orderId);
    const inspToken = inspectorTokens.get(assignedId)!;
    for (const status of ['EN_ROUTE', 'IN_PROGRESS']) {
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${inspToken}`)
        .send({ status })
        .expect(200);
    }

    // Exactly what carsalepro-mobile mints: CSP- + a LOWER-CASE uuid v4. The
    // DTO used to upper-case it and Report.code is matched literally, so this
    // was a guaranteed 404 on a code the public preview endpoint resolved fine.
    const code = `CSP-${randomUUID().toLowerCase()}`;
    expect(code.slice('CSP-'.length)).toBe(code.slice('CSP-'.length).toLowerCase());
    const report = await prisma.report.create({
      data: {
        deviceId: uniqueDeviceId('lower'),
        code,
        make: 'BMW',
        model: '320d',
        s3Key: 'test/lowercase.pdf',
        tier: 'free',
        uploaded: true,
        qualityScore: 95,
        // A complete payload, so the 200 below can only be about the code's
        // case. Without it the completeness gate answers 409 first and this
        // case would pass or fail for the wrong reason.
        reportSchemaVersion: 1,
        reportData: completeReportData(),
        userId: assignedId,
      },
    });

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/report`)
      .set('Authorization', `Bearer ${inspToken}`)
      .send({ code })
      .expect(200);

    const attached = await prisma.report.findUnique({ where: { id: report.id } });
    expect(attached!.orderId).toBe(orderId);
    // Stored verbatim — never normalized to upper case.
    expect(attached!.code).toBe(code);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order!.status).toBe('SUBMITTED');
  });

  // ============================================================
  // 12. Approve from SUBMITTED → APPROVED; autoApprove + expireStaleOffers jobs
  // ============================================================
  it('12. approve from SUBMITTED → APPROVED; autoApproveOverdue + expireStaleOffers work', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    await acceptPendingOffer(orderId);
    await orders.submitReportForOrder(orderId);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(res.body.status).toBe('APPROVED');

    // --- autoApproveOverdue: a SUBMITTED order past autoApproveAt flips APPROVED ---
    const customer2 = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId: order2 } = await createPaidOrder(customer2);
    await acceptPendingOffer(order2);
    await orders.submitReportForOrder(order2);
    // Backdate autoApproveAt into the past.
    await prisma.order.update({
      where: { id: order2 },
      data: { autoApproveAt: new Date(Date.now() - 60_000) },
    });
    const autoRes = await orders.autoApproveOverdue();
    expect(autoRes.approved).toBeGreaterThanOrEqual(1);
    const flipped = await prisma.order.findUnique({ where: { id: order2 } });
    expect(flipped!.status).toBe('APPROVED');

    // --- expireStaleOffers: a stale PENDING offer becomes EXPIRED ---
    const customer3 = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId: order3 } = await createPaidOrder(customer3);
    const staleOffer = await pendingOfferFor(order3);
    await prisma.orderOffer.update({
      where: { id: staleOffer!.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const expRes = await orders.expireStaleOffers();
    expect(expRes.expired).toBeGreaterThanOrEqual(1);
    const expired = await prisma.orderOffer.findUnique({ where: { id: staleOffer!.id } });
    expect(expired!.status).toBe('EXPIRED');
  });

  // ============================================================
  // 13. Illegal transition (approve from PAID) → 409
  // ============================================================
  it('13. approve from PAID → 409 illegal_transition', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(409);
    expect(res.body.error.code).toBe('illegal_transition');
  });

  // ============================================================
  // 14. Detail access control (stranger → 403)
  // ============================================================
  it('14. order detail by an unrelated user → 403', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);
    const stranger = await makeCustomer();

    const res = await request(app.getHttpServer())
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  // ============================================================
  // 15. GET /orders/me as customer lists own orders
  // ============================================================
  it('15. GET /orders/me?role=customer lists the customer own orders', async () => {
    const customer = await makeCustomer();
    await makeInspector(ORDER_LAT, ORDER_LNG);
    const { orderId } = await createPaidOrder(customer);

    const res = await request(app.getHttpServer())
      .get('/api/v1/orders/me?role=customer')
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const found = res.body.items.find((o: { id: string }) => o.id === orderId);
    expect(found).toBeTruthy();
    expect(found.status).toBe('PAID');

    /*
     * The row carries the split. The inspector's offer LIST is the first place
     * a job is priced for them, and it printed `totalCents` — the customer's
     * number, which overstates the earning by the whole commission. Without
     * these two fields on the row there is nothing else for it to print.
     */
    expect(found.platformFeeCents + found.inspectorShareCents).toBe(
      found.totalCents,
    );
  });
});
