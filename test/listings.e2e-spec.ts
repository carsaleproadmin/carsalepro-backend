import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import request from 'supertest';
import { createTestApp, uniqueDeviceId } from './helpers/test-app';
import { ListingsService } from '../src/listings/listings.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { R2Service } from '../src/r2/r2.service';
import { mirroredPhotoKey } from '../src/listings/listing-photo-urls';

const FIXTURE_PHOTO = join(__dirname, 'fixtures', 'small-800x600.png');

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
        const { timestamp: _ts, ...rest } = b;
        void _ts;
        return rest;
      };
      expect(withoutTimestamp(missing.body)).toEqual(withoutTimestamp(claimed.body));
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('1b. GET /listings/:id returns the full owned row, and 403s for a stranger', async () => {
    // The manual editor hydrates a DRAFT from here. /me/listings is a summary
    // and the public route serves only ACTIVE, so this is the only read that
    // can rehydrate one — previously the editor had to issue an empty PATCH.
    const owner = await registerUser(app);
    const stranger = await registerUser(app);
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
        .get(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200);
      expect(res.body.id).toBe(listingId);
      expect(res.body.status).toBe('DRAFT');
      expect(res.body).toHaveProperty('vehicleData');
      expect(res.body).toHaveProperty('contactEmail');

      await request(app.getHttpServer())
        .get(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/v1/listings/${listingId}`)
        .expect(401);
    } finally {
      await cleanup({ listingId, reportId: report.id });
    }
  });

  it('3a-2. a blank contactEmail is accepted and clears the field, rather than failing the PATCH', async () => {
    // `@IsOptional()` skips null and undefined but NOT '', so a bare @IsEmail()
    // rejected every seller who left the optional contact e-mail blank — the
    // whole PATCH failed with `contactEmail must be an email`, and the seller
    // form shows that as a generic "something went wrong". Step 2 of the Report
    // ID claim flow and the listing edit page were both dead ends because of it.
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

      // A blank one is accepted...
      const blank = await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ city: 'Berlin', contactEmail: '' })
        .expect(200);
      expect(blank.body.contactEmail).toBeNull();

      // ...a real one is stored...
      await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ contactEmail: 'seller@example.com' })
        .expect(200);

      // ...omitting the key leaves it alone (that is what "optional" means)...
      const untouched = await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ city: 'Hamburg' })
        .expect(200);
      expect(untouched.body.contactEmail).toBe('seller@example.com');

      // ...and blanking it again CLEARS it. Omitting the key could never do
      // this, which is why the fix belongs in the DTO and not in the client.
      const cleared = await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ contactEmail: '   ' })
        .expect(200);
      expect(cleared.body.contactEmail).toBeNull();

      // A genuinely malformed address is still rejected.
      await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listingId}`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ contactEmail: 'not-an-email' })
        .expect(400);
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

  // ============================================================
  // BE-S2 — listing a car with NO inspection report
  // ============================================================
  describe('BE-S2: manual listings', () => {
    const sellerIds: string[] = [];

    async function newSeller() {
      const seller = await registerUser(app);
      sellerIds.push(seller.userId);
      return seller;
    }

    afterAll(async () => {
      // Photos are real objects in R2 during e2e — sweep the sellers' prefixes.
      const r2 = app.get(R2Service);
      if (r2.isConfigured()) {
        for (const id of sellerIds) {
          await r2.deletePrefix(`listings/${id}/`).catch(() => undefined);
        }
      }
      await prisma.listing.deleteMany({ where: { sellerId: { in: sellerIds } } });
    });

    async function createManual(token: string, body: Record<string, unknown> = {}) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/listings/manual')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);
      return res.body;
    }

    it('13. POST /listings/manual opens a DRAFT with source=manual and reportId=null', async () => {
      const seller = await newSeller();
      const listing = await createManual(seller.token, {
        priceCents: 990000,
        city: 'Dresden',
        vehicleData: {
          schemaVersion: 1,
          vehicle: {
            make: 'Opel',
            model: 'Astra',
            year: 2016,
            fuelType: 'petrol',
            transmission: 'manual',
            powerKw: 92,
            colour: 'silver',
            tuvDate: '2027-06',
            firstRegistration: '2016-04-12',
          },
          operational: { mileageKm: 132000 },
          selfDeclaration: { accidentFreeClaimed: true, ownersCount: 2 },
        },
      });

      expect(listing.status).toBe('DRAFT');
      expect(listing.source).toBe('manual');
      expect(listing.reportId).toBeNull();
      // Projected onto the searchable columns, not left inside the JSON blob.
      expect(listing.make).toBe('Opel');
      expect(listing.model).toBe('Astra');
      expect(listing.year).toBe(2016);
      expect(listing.mileageKm).toBe(132000);
      expect(listing.powerKw).toBe(92);
      expect(listing.color).toBe('silver');
      expect(listing.huValidUntil).toBe('2027-06');
      expect(listing.firstRegistration).toContain('2016-04-12');
    });

    it('14. money on seller-declared damages is stripped, and scores/signoff are refused', async () => {
      const seller = await newSeller();
      const listing = await createManual(seller.token, {
        vehicleData: {
          damages: [
            {
              id: 'd1',
              tier: 'T2',
              partId: 'door_fl',
              note: 'scratch',
              materialsEur: 120,
              hours: 3,
              hourlyRate: 90,
              manualCostEur: 400,
            },
          ],
        },
      });

      const stored = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
      const damages = (stored.vehicleData as { damages: Record<string, unknown>[] }).damages;
      expect(damages[0].id).toBe('d1');
      expect(damages[0].note).toBe('scratch');
      // AW/AZT estimation is a trained discipline; a seller pricing their own
      // damage is the one party motivated to understate it.
      expect(damages[0].materialsEur).toBeUndefined();
      expect(damages[0].hours).toBeUndefined();
      expect(damages[0].hourlyRate).toBeUndefined();
      expect(damages[0].manualCostEur).toBeUndefined();

      // A quality score and an inspector sign-off have no seller-side meaning.
      await request(app.getHttpServer())
        .post('/api/v1/listings/manual')
        .set('Authorization', `Bearer ${seller.token}`)
        .send({ vehicleData: { scores: { qualityScore: 100 } } })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/listings/manual')
        .set('Authorization', `Bearer ${seller.token}`)
        .send({ vehicleData: { signoff: { accidentFree: true } } })
        .expect(400);
    });

    it('15. PATCH vehicleData deep-merges: objects merge, arrays replace, null deletes', async () => {
      const seller = await newSeller();
      const listing = await createManual(seller.token, {
        vehicleData: {
          vehicle: { make: 'Opel', model: 'Astra', year: 2016 },
          operational: { mileageKm: 132000, keysCount: 2 },
          damages: [
            { id: 'd1', tier: 'T1' },
            { id: 'd2', tier: 'T2' },
          ],
          selfDeclaration: { accidentFreeClaimed: true, ownersCount: 2 },
        },
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listing.id}`)
        .set('Authorization', `Bearer ${seller.token}`)
        .send({
          vehicleData: {
            // object: merges, so `model` and `year` survive
            vehicle: { year: 2017 },
            // array: replaces wholesale — the ONLY way a client can delete an
            // element from a list
            damages: [{ id: 'd3', tier: 'T3' }],
            // explicit null: deletes the key
            selfDeclaration: null,
          },
        })
        .expect(200);

      const data = res.body.vehicleData as Record<string, Record<string, unknown>>;
      expect(data.vehicle).toEqual({ make: 'Opel', model: 'Astra', year: 2017 });
      expect(data.operational).toEqual({ mileageKm: 132000, keysCount: 2 });
      expect(data.damages).toEqual([{ id: 'd3', tier: 'T3' }]);
      expect(data.selfDeclaration).toBeUndefined();
      // The projected column follows the merge.
      expect(res.body.year).toBe(2017);
    });

    it('16. PATCH vehicleData on a report-backed listing is refused with vehicle_immutable', async () => {
      const owner = await newSeller();
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
        expect(created.body.source).toBe('report');
        // The claim path denormalises the report onto the listing columns.
        expect(created.body.make).toBe('BMW');
        expect(created.body.year).toBe(2018);

        const res = await request(app.getHttpServer())
          .patch(`/api/v1/listings/${listingId}`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ vehicleData: { vehicle: { make: 'Ferrari' } } })
          .expect(400);
        expect(res.body.error.code).toBe('vehicle_immutable');

        // Ordinary fields still patch fine on the same listing.
        await request(app.getHttpServer())
          .patch(`/api/v1/listings/${listingId}`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ city: 'Kiel' })
          .expect(200);
      } finally {
        await cleanup({ listingId, reportId: report.id });
      }
    });

    it('17. photos upload, list, reorder and delete', async () => {
      const seller = await newSeller();
      const listing = await createManual(seller.token, { city: 'Kiel' });

      const first = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/photos`)
        .set('Authorization', `Bearer ${seller.token}`)
        .field('caption', 'Front')
        .attach('file', FIXTURE_PHOTO)
        .expect(201);
      expect(first.body.id).toBeTruthy();
      expect(first.body.width).toBeGreaterThan(0);
      expect(first.body.caption).toBe('Front');

      // Keyed by LISTING, and deliberately not by seller. Once the public
      // bucket is configured this key is a permanent unsigned URL, and a stable
      // seller id in it would make every advert by one pseudonymous seller
      // correlatable from an image URL alone. Erasure finds the objects through
      // the rows, which is why the key does not have to carry the owner.
      const row = await prisma.listingPhoto.findUniqueOrThrow({ where: { id: first.body.id } });
      expect(row.r2Key.startsWith(`listings/${listing.id}/`)).toBe(true);
      expect(row.r2Key).not.toContain(seller.userId);
      expect(row.format).toBe('jpeg');

      // Identical bytes are a retry, not a second photo.
      const retry = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/photos`)
        .set('Authorization', `Bearer ${seller.token}`)
        .attach('file', FIXTURE_PHOTO)
        .expect(201);
      expect(retry.body.id).toBe(first.body.id);

      const second = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/photos`)
        .set('Authorization', `Bearer ${seller.token}`)
        .attach('file', join(__dirname, 'fixtures', 'photo-exif-rotated.jpg'))
        .expect(201);

      const listed = await request(app.getHttpServer())
        .get(`/api/v1/listings/${listing.id}/photos`)
        .set('Authorization', `Bearer ${seller.token}`)
        .expect(200);
      expect(listed.body.items).toHaveLength(2);
      expect(listed.body.max).toBe(20);
      expect(listed.body.items[0].id).toBe(first.body.id);

      const reordered = await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listing.id}/photos/order`)
        .set('Authorization', `Bearer ${seller.token}`)
        .send({ ids: [second.body.id, first.body.id] })
        .expect(200);
      expect(reordered.body.items.map((p: { id: string }) => p.id)).toEqual([
        second.body.id,
        first.body.id,
      ]);

      // A partial order has no well-defined result and is refused.
      const bad = await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listing.id}/photos/order`)
        .set('Authorization', `Bearer ${seller.token}`)
        .send({ ids: [first.body.id] })
        .expect(400);
      expect(bad.body.error.code).toBe('photo_order_mismatch');

      await request(app.getHttpServer())
        .delete(`/api/v1/listings/${listing.id}/photos/${second.body.id}`)
        .set('Authorization', `Bearer ${seller.token}`)
        .expect(200);
      expect(await prisma.listingPhoto.count({ where: { listingId: listing.id } })).toBe(1);
    });

    it('18. a stranger cannot read or upload to someone else\u2019s gallery', async () => {
      const seller = await newSeller();
      const stranger = await newSeller();
      const listing = await createManual(seller.token, { city: 'Kiel' });

      await request(app.getHttpServer())
        .get(`/api/v1/listings/${listing.id}/photos`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/photos`)
        .set('Authorization', `Bearer ${stranger.token}`)
        .attach('file', FIXTURE_PHOTO)
        .expect(403);
    });

    it('19. the 21st photo is refused with photo_limit_reached', async () => {
      const seller = await newSeller();
      const listing = await createManual(seller.token, { city: 'Kiel' });

      // Seed the cap directly: twenty real uploads would spend twenty sharp
      // transforms and twenty R2 round-trips to test one integer comparison.
      await prisma.listingPhoto.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          listingId: listing.id,
          r2Key: `listings/${seller.userId}/${listing.id}/seed-${i}-${randomUUID()}.jpg`,
          sizeBytes: 1000,
          width: 800,
          height: 600,
          order: i,
        })),
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/photos`)
        .set('Authorization', `Bearer ${seller.token}`)
        .attach('file', FIXTURE_PHOTO)
        .expect(400);
      expect(res.body.error.code).toBe('photo_limit_reached');
      expect(res.body.error.max).toBe(20);
    });

    it('20. publishing an incomplete manual listing returns incomplete_listing with missing[]', async () => {
      const seller = await newSeller();
      const listing = await createManual(seller.token, {});

      const empty = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/publish`)
        .set('Authorization', `Bearer ${seller.token}`)
        .send({ package: 'standard' })
        .expect(400);
      expect(empty.body.error.code).toBe('incomplete_listing');
      expect(empty.body.error.missing).toEqual(
        expect.arrayContaining(['priceCents', 'city', 'make', 'model', 'year', 'photos']),
      );

      // Fill everything except the photo — the gate must still name it, and only it.
      await request(app.getHttpServer())
        .patch(`/api/v1/listings/${listing.id}`)
        .set('Authorization', `Bearer ${seller.token}`)
        .send({
          priceCents: 990000,
          city: 'Dresden',
          vehicleData: { vehicle: { make: 'Opel', model: 'Astra', year: 2016 } },
        })
        .expect(200);

      const noPhotos = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/publish`)
        .set('Authorization', `Bearer ${seller.token}`)
        .send({ package: 'standard' })
        .expect(400);
      expect(noPhotos.body.error.code).toBe('incomplete_listing');
      expect(noPhotos.body.error.missing).toEqual(['photos']);

      await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/photos`)
        .set('Authorization', `Bearer ${seller.token}`)
        .attach('file', FIXTURE_PHOTO)
        .expect(201);

      const published = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/publish`)
        .set('Authorization', `Bearer ${seller.token}`)
        .send({ package: 'standard' })
        .expect(201);
      expect(published.body.status).toBe('ACTIVE');

      const showroom = await request(app.getHttpServer())
        .get('/api/v1/public/listings?make=Opel&city=Dresden')
        .expect(200);
      const card = showroom.body.items.find((i: { id: string }) => i.id === listing.id);
      expect(card).toBeTruthy();
      expect(card.verified).toBe(false);
      expect(card.qualityScore).toBeNull();
      expect(card.inspection.status).toBe('self_declared');
    });

    it('21. GET /me/listings reports source, photoCount and a null reportCode', async () => {
      const seller = await newSeller();
      const listing = await createManual(seller.token, { city: 'Kiel' });
      await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/photos`)
        .set('Authorization', `Bearer ${seller.token}`)
        .attach('file', FIXTURE_PHOTO)
        .expect(201);

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/listings')
        .set('Authorization', `Bearer ${seller.token}`)
        .expect(200);
      const item = res.body.items.find((i: { id: string }) => i.id === listing.id);
      expect(item.source).toBe('manual');
      expect(item.reportCode).toBeNull();
      expect(item.photoCount).toBe(1);
    });
  });

  // ============================================================
  // Permanent showroom image URLs (the public bucket)
  //
  // Two worlds are asserted here, and the FIRST one matters most: with
  // `R2_PUBLIC_*` unset — which is CI, every developer machine, and production
  // until the bucket is created — nothing about photo handling may change. The
  // second world is simulated by stubbing the four `R2Service` public-bucket
  // methods, because a real second bucket cannot be part of an offline suite.
  // ============================================================
  describe('permanent showroom URLs', () => {
    const sellerIds: string[] = [];
    const listingIds: string[] = [];
    const reportIds: string[] = [];

    async function seller() {
      const s = await registerUser(app);
      sellerIds.push(s.userId);
      return s;
    }

    async function manualListing(token: string, body: Record<string, unknown> = {}) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/listings/manual')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(201);
      listingIds.push(res.body.id);
      return res.body;
    }

    afterAll(async () => {
      const r2 = app.get(R2Service);
      if (r2.isConfigured()) {
        for (const id of sellerIds) {
          await r2.deletePrefix(`listings/${id}/`).catch(() => undefined);
        }
      }
      await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
      await prisma.report.deleteMany({ where: { id: { in: reportIds } } });
    });

    it('22. ships dark: no public bucket => signed URL, ListingPhoto.bucket stays NULL', async () => {
      const owner = await seller();
      const listing = await manualListing(owner.token, { city: 'Bremen' });

      // The premise of the whole wave: this suite runs with R2_PUBLIC_* unset.
      expect(app.get(R2Service).isPublicBucketConfigured()).toBe(false);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/listings/${listing.id}/photos`)
        .set('Authorization', `Bearer ${owner.token}`)
        .attach('file', FIXTURE_PHOTO)
        .expect(201);

      const row = await prisma.listingPhoto.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.bucket).toBeNull();
      // Byte-for-byte the old behaviour: a presigned URL, query string and all.
      expect(res.body.url).toContain('X-Amz-Signature');
      expect(res.body.url).toContain(row.r2Key);
    });

    it('23. ships dark: an unmirrored report listing keeps signed showroom URLs', async () => {
      const owner = await seller();
      const code = uniqueCode();
      const report = await seedReport({ code, userId: owner.userId });
      reportIds.push(report.id);
      const listing = await prisma.listing.create({
        data: {
          sellerId: owner.userId,
          reportId: report.id,
          source: 'report',
          status: 'ACTIVE',
          package: 'standard',
          priceCents: 1290000,
          city: 'Bochum',
          make: 'BMW',
          model: '320d',
          year: 2018,
          publishedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 86400000),
        },
      });
      listingIds.push(listing.id);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/public/listings/${listing.id}`)
        .expect(200);
      expect(listing.publicPhotosMirroredAt).toBeNull();
      expect(res.body.photos[0].url).toContain('X-Amz-Signature');
    });

    describe('with a public bucket configured', () => {
      const PUBLIC_BUCKET = 'carsalepro-public-test';
      const BASE = 'https://img.test.invalid';
      /** Stand-in for the bucket: key -> bytes. */
      const objects = new Map<string, Buffer>();

      beforeAll(() => {
        const r2 = app.get(R2Service);
        jest.spyOn(r2, 'isPublicBucketConfigured').mockReturnValue(true);
        jest.spyOn(r2, 'publicObjectUrl').mockImplementation((key: string) => `${BASE}/${key}`);
        jest
          .spyOn(r2, 'publicPutObject')
          .mockImplementation(async (key: string, body: Uint8Array | Buffer) => {
            objects.set(key, Buffer.from(body));
            return PUBLIC_BUCKET;
          });
        jest.spyOn(r2, 'publicDeleteObject').mockImplementation(async (key: string) => {
          objects.delete(key);
        });
        // The mirror reads the private original back out of the reports bucket.
        // Stubbed so the test does not depend on objects existing in R2.
        jest
          .spyOn(r2, 'getObjectBytes')
          .mockImplementation(async (key: string) => Buffer.from(`bytes:${key}`));
      });

      afterAll(() => {
        jest.restoreAllMocks();
        objects.clear();
      });

      it('24. a new upload lands in the public bucket and gets a permanent URL', async () => {
        const owner = await seller();
        const listing = await manualListing(owner.token, { city: 'Aachen' });

        const res = await request(app.getHttpServer())
          .post(`/api/v1/listings/${listing.id}/photos`)
          .set('Authorization', `Bearer ${owner.token}`)
          .attach('file', FIXTURE_PHOTO)
          .expect(201);

        const row = await prisma.listingPhoto.findUniqueOrThrow({ where: { id: res.body.id } });
        expect(row.bucket).toBe(PUBLIC_BUCKET);
        expect(objects.has(row.r2Key)).toBe(true);
        expect(res.body.url).toBe(`${BASE}/${row.r2Key}`);
        // Permanent means no signature and no expiry: nothing to go stale, and
        // a CDN can cache it because the URL never changes.
        expect(res.body.url).not.toContain('?');

        const gallery = await request(app.getHttpServer())
          .get(`/api/v1/listings/${listing.id}/photos`)
          .set('Authorization', `Bearer ${owner.token}`)
          .expect(200);
        expect(gallery.body.items[0].url).toBe(`${BASE}/${row.r2Key}`);

        // Deleting the photo must clear the PUBLIC object, not a private one
        // that was never written — otherwise a removed photo stays readable.
        await request(app.getHttpServer())
          .delete(`/api/v1/listings/${listing.id}/photos/${res.body.id}`)
          .set('Authorization', `Bearer ${owner.token}`)
          .expect(200);
        expect(objects.has(row.r2Key)).toBe(false);
      });

      it('25. publishing a manual listing serves the showroom card a permanent URL', async () => {
        const owner = await seller();
        const listing = await manualListing(owner.token, {
          city: 'Aachen',
          priceCents: 890000,
          vehicleData: { vehicle: { make: 'Skoda', model: 'Octavia', year: 2017 } },
        });
        const photo = await request(app.getHttpServer())
          .post(`/api/v1/listings/${listing.id}/photos`)
          .set('Authorization', `Bearer ${owner.token}`)
          .attach('file', FIXTURE_PHOTO)
          .expect(201);

        await request(app.getHttpServer())
          .post(`/api/v1/listings/${listing.id}/publish`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ package: 'standard' })
          .expect(201);

        const detail = await request(app.getHttpServer())
          .get(`/api/v1/public/listings/${listing.id}`)
          .expect(200);
        expect(detail.body.photos[0].url).toBe(photo.body.url);
        expect(detail.body.photos[0].url.startsWith(BASE)).toBe(true);
      });

      it('26. publishing promotes a photo that was uploaded before the bucket existed', async () => {
        const owner = await seller();
        const listing = await manualListing(owner.token, {
          city: 'Aachen',
          priceCents: 750000,
          vehicleData: { vehicle: { make: 'Ford', model: 'Focus', year: 2015 } },
        });
        // A row from the old world: object in the reports bucket, bucket NULL.
        const legacy = await prisma.listingPhoto.create({
          data: {
            listingId: listing.id,
            r2Key: `listings/${owner.userId}/${listing.id}/legacy-${randomUUID()}.jpg`,
            sizeBytes: 1234,
            width: 800,
            height: 600,
            order: 0,
          },
        });

        await request(app.getHttpServer())
          .post(`/api/v1/listings/${listing.id}/publish`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ package: 'standard' })
          .expect(201);

        const after = await prisma.listingPhoto.findUniqueOrThrow({ where: { id: legacy.id } });
        expect(after.bucket).toBe(PUBLIC_BUCKET);
        // Same key, different bucket — nothing downstream has to translate keys.
        expect(objects.has(legacy.r2Key)).toBe(true);
      });

      it('27. a report-backed listing mirrors its photos, and re-running is idempotent', async () => {
        const owner = await seller();
        const code = uniqueCode();
        const deviceId = uniqueDeviceId();
        const report = await prisma.report.create({
          data: {
            deviceId,
            code,
            s3Key: `free/${deviceId}/${code}.pdf`,
            tier: 'free',
            uploaded: true,
            userId: owner.userId,
            make: 'Audi',
            model: 'A4',
            year: 2019,
            qualityScore: 90,
            photosManifest: [
              { s3Key: `report-photos/${deviceId}/front.jpg`, kind: 'front' },
              { s3Key: `report-photos/${deviceId}/rear.jpg`, kind: 'rear' },
            ],
          },
        });
        reportIds.push(report.id);

        const created = await request(app.getHttpServer())
          .post('/api/v1/listings')
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ reportCode: code })
          .expect(201);
        const listingId = created.body.id as string;
        listingIds.push(listingId);

        await request(app.getHttpServer())
          .patch(`/api/v1/listings/${listingId}`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ priceCents: 2190000, city: 'Ulm' })
          .expect(200);
        await request(app.getHttpServer())
          .post(`/api/v1/listings/${listingId}/publish`)
          .set('Authorization', `Bearer ${owner.token}`)
          .send({ package: 'standard' })
          .expect(201);

        // A report-backed listing has NO ListingPhoto rows: its images are
        // manifest entries, copied under a deterministic key.
        expect(await prisma.listingPhoto.count({ where: { listingId } })).toBe(0);
        const stamped = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
        expect(stamped.publicPhotosMirroredAt).not.toBeNull();

        const expectedKeys = [
          mirroredPhotoKey(listingId, `report-photos/${deviceId}/front.jpg`),
          mirroredPhotoKey(listingId, `report-photos/${deviceId}/rear.jpg`),
        ];
        for (const key of expectedKeys) expect(objects.has(key)).toBe(true);
        // The source key never appears in the public one — a permanent public
        // URL must not publish the device that ran the inspection.
        for (const key of expectedKeys) expect(key).not.toContain(deviceId);

        const detail = await request(app.getHttpServer())
          .get(`/api/v1/public/listings/${listingId}`)
          .expect(200);
        expect(detail.body.photos.map((p: { url: string }) => p.url)).toEqual(
          expectedKeys.map((k) => `${BASE}/${k}`),
        );
        expect(detail.body.photos[0].url).not.toContain('?');

        // --- idempotency: a second pass changes nothing observable ---------
        const keysBefore = [...objects.keys()].sort();
        const result = await app.get(ListingsService).mirrorShowroomPhotos(listingId);
        expect(result.failed).toBe(0);
        expect([...objects.keys()].sort()).toEqual(keysBefore);
        expect(await prisma.listingPhoto.count({ where: { listingId } })).toBe(0);

        const again = await request(app.getHttpServer())
          .get(`/api/v1/public/listings/${listingId}`)
          .expect(200);
        expect(again.body.photos.map((p: { url: string }) => p.url)).toEqual(
          detail.body.photos.map((p: { url: string }) => p.url),
        );
      });

      it('28. the nightly backlog pass mirrors listings published before the cutover', async () => {
        const owner = await seller();
        const code = uniqueCode();
        const report = await seedReport({ code, userId: owner.userId });
        reportIds.push(report.id);
        const listing = await prisma.listing.create({
          data: {
            sellerId: owner.userId,
            reportId: report.id,
            source: 'report',
            status: 'ACTIVE',
            package: 'standard',
            priceCents: 1490000,
            city: 'Fulda',
            make: 'BMW',
            model: '320d',
            year: 2018,
            publishedAt: new Date(Date.now() - 10 * 86400000),
            expiresAt: new Date(Date.now() + 20 * 86400000),
          },
        });
        listingIds.push(listing.id);

        const totals = await app.get(ListingsService).mirrorPendingShowroomPhotos(200);
        expect(totals.scanned).toBeGreaterThanOrEqual(1);

        const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
        expect(after.publicPhotosMirroredAt).not.toBeNull();
        const manifest = report.photosManifest as { s3Key: string }[];
        expect(objects.has(mirroredPhotoKey(listing.id, manifest[0].s3Key))).toBe(true);
      });
    });
  });
});
