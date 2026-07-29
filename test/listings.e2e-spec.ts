import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, uniqueDeviceId } from './helpers/test-app';
import { ListingsService } from '../src/listings/listings.service';
import { PrismaService } from '../src/prisma/prisma.service';

let codeCounter = 0;
function uniqueCode(): string {
  // CSP-#### sequence (validated by the listings DTO).
  codeCounter = (codeCounter + 1) % 1_000_000;
  return `CSP-${Date.now().toString().slice(-5)}${codeCounter}`.slice(0, 14);
}

function uniqueEmail(): string {
  return `listing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function registerUser(
  app: INestApplication,
): Promise<{ token: string; userId: string; email: string }> {
  const email = uniqueEmail();
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password: 'Sup3rSecret!', gdprConsent: true })
    .expect(201);
  return { token: res.body.token as string, userId: res.body.user.id as string, email };
}

describe('Listings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Seed a report. By default no userId (device-owned); pass userId to make a user the owner. */
  async function seedReport(opts: { code: string; deviceId?: string; userId?: string }) {
    const deviceId = opts.deviceId ?? uniqueDeviceId();
    return prisma.report.create({
      data: {
        deviceId,
        code: opts.code,
        s3Key: `free/${deviceId}/${opts.code}.pdf`,
        tier: 'free',
        uploaded: true,
        userId: opts.userId ?? null,
        make: 'BMW',
        model: '320d',
        year: 2018,
        mileageKm: 120000,
        color: 'Black',
        bodyType: 'sedan',
        driveType: 'rwd',
        qualityScore: 87,
        reportData: { checklist: { brakes: 'ok' }, damages: [] },
        photosManifest: [{ s3Key: `report-photos/${deviceId}/front.jpg`, kind: 'front' }],
      },
    });
  }

  async function cleanup(ids: { listingId?: string; reportId?: string }) {
    if (ids.listingId) await prisma.listing.deleteMany({ where: { id: ids.listingId } });
    if (ids.reportId) await prisma.report.deleteMany({ where: { id: ids.reportId } });
  }

  it('1. POST /listings as the report owner creates a DRAFT listing', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    let listingId: string | undefined;
    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('DRAFT');
      expect(res.body.package).toBe('standard');
      expect(res.body.priceCents).toBe(0);
      expect(res.body.city).toBe('');
      expect(res.body.reportId).toBe(report.id);
      expect(res.body.sellerId).toBe(owner.userId);
      // denormalized from report
      expect(res.body.color).toBe('Black');
      expect(res.body.bodyType).toBe('sedan');
      expect(res.body.driveType).toBe('rwd');
      listingId = res.body.id;
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('2. BE-S1: a stranger holding the code CAN claim it — the code is the authorisation', async () => {
    // Deliberate product change. The Report ID is now a bearer capability, so a
    // seller who never installed the app can list their car from the printed
    // code. Previously this returned 403 not_report_owner.
    const code = uniqueCode();
    const report = await seedReport({ code }); // device-owned, no user
    const stranger = await registerUser(app);
    let listingId: string | undefined;
    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${stranger.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = res.body.id;
      expect(res.body.sellerId).toBe(stranger.userId);
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('3. BE-S1: claiming is single-use, and a second claim looks like "not found"', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    let listingId: string | undefined;
    try {
      const first = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = first.body.id;

      const claimed = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(404);
      expect(claimed.body.error.code).toBe('report_not_claimable');

      // A code that never existed must be INDISTINGUISHABLE from a claimed one,
      // or this endpoint becomes an oracle for which report codes are real.
      const missing = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: uniqueCode() })
        .expect(404);
      // Everything but the timestamp, which the exception filter stamps on every
      // error and which says nothing about the code.
      const withoutTimestamp = (b: Record<string, unknown>) => {
        const { timestamp: _timestamp, ...rest } = b;
        return rest;
      };
      expect(withoutTimestamp(missing.body)).toEqual(withoutTimestamp(claimed.body));
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('3b. BE-S1: a different user claiming an already-claimed code gets the same 404', async () => {
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    let listingId: string | undefined;
    try {
      const first = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = first.body.id;

      const res = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${stranger.token}`)
        .send({ reportCode: code })
        .expect(404); // not 403 — a 403 would confirm the code exists
      expect(res.body.error.code).toBe('report_not_claimable');
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('3c. BE-S1: concurrent claims resolve to exactly one listing', async () => {
    const code = uniqueCode();
    const report = await seedReport({ code });
    const users = await Promise.all([
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
      registerUser(app),
    ]);
    try {
      const results = await Promise.all(
        users.map((u) =>
          request(app.getHttpServer())
            .post('/api/v1/listings')
            .set('Authorization', `Bearer ${u.token}`)
            .send({ reportCode: code }),
        ),
      );

      const created = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status === 404);
      expect(created).toHaveLength(1);
      expect(refused).toHaveLength(4);

      // The unique index is the claim marker, so the database agrees.
      const rows = await prisma.listing.findMany({ where: { reportId: report.id } });
      expect(rows).toHaveLength(1);
    } finally {
      await prisma.listing.deleteMany({ where: { reportId: report.id } });
      await cleanup({ reportId: report.id });
    }
  });

  it('3d. BE-S1: a modern CSP-<uuid> code can be claimed', async () => {
    // The old regex only matched CSP-###, so every report the current mobile
    // app produces was un-listable.
    const owner = await registerUser(app);
    const code = `CSP-${randomUUID()}`;
    const report = await seedReport({ code, userId: owner.userId });
    let listingId: string | undefined;
    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = res.body.id;
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('4. PATCH /listings/:id updates price and city', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    let listingId: string | undefined;
    try {
      const created = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = created.body.id;

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ priceCents: 1850000, city: 'Berlin', plz: '10115' })
        .expect(200);
      expect(res.body.priceCents).toBe(1850000);
      expect(res.body.city).toBe('Berlin');
      expect(res.body.plz).toBe('10115');
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('5. publish standard activates and the listing appears in the public showroom', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    let listingId: string | undefined;
    try {
      const created = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = created.body.id;

      await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ priceCents: 1500000, city: 'Munich' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listingId}/publish`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ package: 'standard' })
        .expect(201);
      expect(res.body.status).toBe('ACTIVE');
      expect(typeof res.body.expiresAt).toBe('string');

      const expiresAt = new Date(res.body.expiresAt).getTime();
      const in29Days = Date.now() + 29 * 86400000;
      const in31Days = Date.now() + 31 * 86400000;
      expect(expiresAt).toBeGreaterThan(in29Days);
      expect(expiresAt).toBeLessThan(in31Days);

      const showroom = await request(app.getHttpServer())
        .get('/api/v1/public/listings?city=Munich')
        .expect(200);
      expect(showroom.body.items.find((i: { id: string }) => i.id === listingId)).toBeTruthy();
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('6. publish without price/city returns 400 incomplete_listing', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    let listingId: string | undefined;
    try {
      const created = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = created.body.id;

      const res = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listingId}/publish`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ package: 'standard' })
        .expect(400);
      expect(res.body.error.code).toBe('incomplete_listing');
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('7. publish gold (mock) activates as gold, marks payment succeeded, and ranks gold-first', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    // A standard listing in the same city to verify gold-first ordering.
    const stdCode = uniqueCode();
    const stdReport = await seedReport({ code: stdCode, userId: owner.userId });
    let listingId: string | undefined;
    let stdListingId: string | undefined;
    try {
      const created = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = created.body.id;

      await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ priceCents: 2500000, city: 'Hamburg' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listingId}/publish`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ package: 'gold' })
        .expect(201);
      expect(res.body.mock).toBe(true);
      expect(typeof res.body.checkoutUrl).toBe('string');
      expect(res.body.checkoutUrl).toContain('gold=mock');

      const goldListing = await prisma.listing.findUnique({ where: { id: listingId } });
      expect(goldListing!.status).toBe('ACTIVE');
      expect(goldListing!.package).toBe('gold');
      expect(goldListing!.publishedAt).toBeTruthy();
      expect(goldListing!.expiresAt).toBeTruthy();

      const goldPayment = await prisma.payment.findFirst({
        where: { userId: owner.userId, purpose: 'gold' },
        orderBy: { createdAt: 'desc' },
      });
      expect(goldPayment!.status).toBe('succeeded');

      // Seed a standard ACTIVE listing in Hamburg and confirm gold ranks first.
      const stdCreated = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: stdCode })
        .expect(201);
      stdListingId = stdCreated.body.id;
      await request(app.getHttpServer())
        .patch(`/api/v1/listings/${stdListingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ priceCents: 900000, city: 'Hamburg' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/listings/${stdListingId}/publish`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ package: 'standard' })
        .expect(201);

      const showroom = await request(app.getHttpServer())
        .get('/api/v1/public/listings?city=Hamburg')
        .expect(200);
      const ids: string[] = showroom.body.items.map((i: { id: string }) => i.id);
      const goldIdx = ids.indexOf(listingId!);
      const stdIdx = ids.indexOf(stdListingId!);
      expect(goldIdx).toBeGreaterThanOrEqual(0);
      expect(stdIdx).toBeGreaterThanOrEqual(0);
      expect(goldIdx).toBeLessThan(stdIdx);
    } finally {
      await cleanup({ listingId, reportId: report.id });
      await cleanup({ listingId: stdListingId, reportId: stdReport.id });
    }
  });

  it('8. unpublish hides the listing from the showroom', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    let listingId: string | undefined;
    try {
      const created = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = created.body.id;
      await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ priceCents: 1200000, city: 'Cologne' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/listings/${listingId}/publish`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ package: 'standard' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listingId}/unpublish`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);
      expect(res.body.status).toBe('HIDDEN');

      const showroom = await request(app.getHttpServer())
        .get('/api/v1/public/listings?city=Cologne')
        .expect(200);
      expect(showroom.body.items.find((i: { id: string }) => i.id === listingId)).toBeUndefined();
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('9. mark-sold sets status SOLD', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    let listingId: string | undefined;
    try {
      const created = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = created.body.id;

      const res = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listingId}/mark-sold`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);
      expect(res.body.status).toBe('SOLD');
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('10. renew an expired listing sets ACTIVE with a future expiresAt', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    // Seed an EXPIRED listing directly.
    const listing = await prisma.listing.create({
      data: {
        sellerId: owner.userId,
        reportId: report.id,
        status: 'EXPIRED',
        package: 'standard',
        priceCents: 1000000,
        city: 'Bremen',
        publishedAt: new Date(Date.now() - 40 * 86400000),
        expiresAt: new Date(Date.now() - 10 * 86400000),
      },
    });
    try {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/renew`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(201);
      expect(res.body.status).toBe('ACTIVE');
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    } finally {
      await cleanup({ listingId: listing.id, reportId: report.id });
    }
  });

  it('11. GET /api/v1/me/listings lists the user listings', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    let listingId: string | undefined;
    try {
      const created = await request(app.getHttpServer())
        .post('/api/v1/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reportCode: code })
        .expect(201);
      listingId = created.body.id;

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/listings')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      const item = res.body.items.find((i: { id: string }) => i.id === listingId);
      expect(item).toBeTruthy();
      expect(item.status).toBe('DRAFT');
      expect(item.reportCode).toBe(code);
      expect(item.vehicle.make).toBe('BMW');
      expect(item.vehicle.model).toBe('320d');
      expect(item.vehicle.year).toBe(2018);
      expect(item.vehicle.mileageKm).toBe(120000);
      expect(typeof item.viewsCount).toBe('number');
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('11b. GET /api/v1/me/listings without a token returns 401', async () => {
    await request(app.getHttpServer()).get('/api/v1/me/listings').expect(401);
  });

  it('12. expireOverdue() flips an ACTIVE past-expiry listing to EXPIRED', async () => {
    const owner = await registerUser(app);
    const code = uniqueCode();
    const report = await seedReport({ code, userId: owner.userId });
    const listing = await prisma.listing.create({
      data: {
        sellerId: owner.userId,
        reportId: report.id,
        status: 'ACTIVE',
        package: 'standard',
        priceCents: 1000000,
        city: 'Leipzig',
        publishedAt: new Date(Date.now() - 40 * 86400000),
        expiresAt: new Date(Date.now() - 1 * 86400000),
      },
    });
    try {
      const service = app.get(ListingsService);
      const count = await service.expireOverdue();
      expect(count).toBeGreaterThanOrEqual(1);

      const after = await prisma.listing.findUnique({ where: { id: listing.id } });
      expect(after!.status).toBe('EXPIRED');
    } finally {
      await cleanup({ listingId: listing.id, reportId: report.id });
    }
  });
});
