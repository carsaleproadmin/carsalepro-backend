import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/test-app';

describe('Public showroom + report check (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const did = `pub-${Date.now().toString(36)}`;
  const code = `CSP-${Math.floor(Math.random() * 900000 + 100000)}`;
  const vin = 'WAUZZZ8V8MA012345';
  let reportId: string;
  let listingId: string;
  let sellerId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    const seller = await prisma.user.create({
      data: { email: `seller-${did}@example.com`, name: 'Seller', gdprConsentAt: new Date() },
    });
    sellerId = seller.id;
    const report = await prisma.report.create({
      data: {
        deviceId: did,
        code,
        vin,
        s3Key: `free/${did}/r.pdf`,
        tier: 'free',
        uploaded: true,
        make: 'BMW',
        model: '320d',
        year: 2019,
        mileageKm: 84500,
        color: 'black',
        bodyType: 'limousine',
        driveType: 'diesel',
        qualityScore: 82,
        reportData: { damages: [{ part: 'door' }, { part: 'bumper' }] },
        photosManifest: [{ s3Key: `report-photos/${did}/front.jpg`, kind: 'front' }],
      },
    });
    reportId = report.id;
    const listing = await prisma.listing.create({
      data: {
        sellerId,
        reportId: report.id,
        status: 'ACTIVE',
        package: 'gold',
        priceCents: 1850000,
        city: 'Berlin',
        bodyType: 'limousine',
        driveType: 'diesel',
        color: 'black',
        publishedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    });
    listingId = listing.id;
  });

  afterAll(async () => {
    await prisma.listing.deleteMany({ where: { id: listingId } });
    await prisma.report.deleteMany({ where: { id: reportId } });
    await prisma.user.deleteMany({ where: { id: sellerId } });
    await app.close();
  });

  it('1. lists verified listings without a token', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/public/listings').expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('2. includes the seeded listing with vehicle data and verified flag', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/public/listings?make=BMW').expect(200);
    const found = res.body.items.find((i: { id: string }) => i.id === listingId);
    expect(found).toBeTruthy();
    expect(found.verified).toBe(true);
    expect(found.vehicle.make).toBe('BMW');
    expect(found.qualityScore).toBe(82);
  });

  it('3. filters out non-matching makes', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/public/listings?make=Audi').expect(200);
    expect(res.body.items.find((i: { id: string }) => i.id === listingId)).toBeUndefined();
  });

  it('4. returns a single listing and increments views', async () => {
    const res = await request(app.getHttpServer()).get(`/api/v1/public/listings/${listingId}`).expect(200);
    expect(res.body.vehicle.model).toBe('320d');
    expect(res.body.reportCode).toBe(code);
    expect(res.body.views).toBeGreaterThanOrEqual(1);
  });

  it('5. 404s for an unknown listing', async () => {
    await request(app.getHttpServer()).get('/api/v1/public/listings/nope').expect(404);
  });

  it('6. report-check by code returns found with no PII', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/public/report-check?code=${code}`)
      .expect(200);
    expect(res.body.found).toBe(true);
    expect(res.body.qualityScore).toBe(82);
    expect(res.body.vehicle.make).toBe('BMW');
  });

  it('7. report-check by VIN returns found', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/public/report-check?vin=${vin.toLowerCase()}`)
      .expect(200);
    expect(res.body.found).toBe(true);
  });

  it('8. report-check returns not found for unknown', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/public/report-check?code=CSP-000001')
      .expect(200);
    expect(res.body.found).toBe(false);
  });

  it('9. report preview masks the VIN and counts damages, no PII', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/public/reports/${code}/preview`)
      .expect(200);
    expect(res.body.damageCount).toBe(2);
    expect(res.body.vinMasked).toMatch(/^WAU\*+/);
    expect(res.body.signature).toBeUndefined();
    expect(res.body.address).toBeUndefined();
  });

  it('10. preview 404s for an unknown code', async () => {
    await request(app.getHttpServer()).get('/api/v1/public/reports/CSP-000002/preview').expect(404);
  });

  // BE-J5 — these two endpoints are the unauthenticated "does this exist?"
  // surface. They used to take raw query strings with no validation at all.
  describe('BE-J5: public lookup input validation', () => {
    it('10a. rejects a malformed VIN with 400 rather than answering', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/public/report-check?vin=NOTAVIN')
        .expect(400);
    });

    it('10b. rejects a VIN containing I, O or Q (ISO 3779 excludes them)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/public/report-check?vin=WAUZZZ8K9IA00Q01')
        .expect(400);
    });

    it('10c. rejects a report code that is not a CSP code', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/public/report-check?code=%3Cscript%3E')
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/v1/public/reports/bogus/preview')
        .expect(400);
    });

    it('10d. still accepts a lowercase VIN and a well-formed code', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/public/report-check?vin=${vin.toLowerCase()}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/public/report-check?code=${code}`)
        .expect(200);
    });

    it('10e. answers "not found" for a well-formed but unknown code', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/public/report-check?code=CSP-999999')
        .expect(200);
      expect(res.body.found).toBe(false);
    });
  });

  it('11. gold listings rank before standard (W.1.9)', async () => {
    const stdReport = await prisma.report.create({
      data: {
        deviceId: did, code: `CSP-${Math.floor(Math.random() * 900000 + 100000)}`,
        s3Key: `free/${did}/std.pdf`, tier: 'free', uploaded: true,
        make: 'BMW', model: '318i', year: 2017,
      },
    });
    const stdListing = await prisma.listing.create({
      data: {
        sellerId, reportId: stdReport.id, status: 'ACTIVE', package: 'standard',
        priceCents: 1000000, city: 'Berlin', publishedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    });
    try {
      const res = await request(app.getHttpServer())
        .get('/api/v1/public/listings?make=BMW')
        .expect(200);
      const ids: string[] = res.body.items.map((i: { id: string }) => i.id);
      const goldIdx = ids.indexOf(listingId); // seeded gold listing
      const stdIdx = ids.indexOf(stdListing.id);
      expect(goldIdx).toBeGreaterThanOrEqual(0);
      expect(stdIdx).toBeGreaterThanOrEqual(0);
      expect(goldIdx).toBeLessThan(stdIdx);
    } finally {
      await prisma.listing.delete({ where: { id: stdListing.id } });
      await prisma.report.delete({ where: { id: stdReport.id } });
    }
  });
});
