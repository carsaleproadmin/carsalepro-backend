import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { R2Service } from '../src/r2/r2.service';
import { mirroredPhotoKey } from '../src/listings/listing-photo-urls';
import { createTestApp } from './helpers/test-app';
import { listingSearchColumns } from '../src/listings/listing-search-columns';

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
        source: 'report',
        status: 'ACTIVE',
        package: 'gold',
        priceCents: 1850000,
        city: 'Berlin',
        bodyType: 'limousine',
        driveType: 'diesel',
        color: 'black',
        // BE-S2: search reads the LISTING's denormalised columns, not the
        // report relation, so a fixture must populate them the way the claim
        // path does - including the folded copies the filters actually match
        // on (DEN-205), which is what `listingSearchColumns` is for.
        make: 'BMW',
        model: '320d',
        ...listingSearchColumns({ city: 'Berlin', make: 'BMW', model: '320d' }),
        year: 2019,
        mileageKm: 84500,
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
    // BE-S2: provenance is stated explicitly, not implied by a bare boolean.
    expect(res.body.source).toBe('report');
    expect(res.body.verified).toBe(true);
    expect(res.body.inspection).toEqual({ status: 'inspected', reportCode: code });
    expect(res.body.qualityScore).toBe(82);
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

  // DEN-224 - the report stopped being a purchase. These four tests are the
  // whole contract of that change: everything is returned, the two things that
  // are not findings are still withheld, and the gate is the LISTING.
  describe('DEN-224: the full report is public', () => {
    it('10-1. returns the findings in full, with no payment and no token', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/public/reports/${code}/full`)
        .expect(200);
      expect(res.body.code).toBe(code);
      expect(res.body.qualityScore).toBe(82);
      expect(res.body.reportData.damages).toHaveLength(2);
      expect(res.body.reportData.damages[0].part).toBe('door');
    });

    it('10-2. masks the VIN and never sends the PDF', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/public/reports/${code}/full`)
        .expect(200);
      expect(res.body.vin).toBeUndefined();
      expect(res.body.vinMasked).toMatch(/^WAU\*+/);
      // The document carries the signature and the unmasked VIN, neither of
      // which passes through the masking above. Free to read is not free to
      // download the paperwork.
      expect(res.body.pdf).toBeUndefined();
    });

    it('10-3. strips PII out of the free-form payload at any depth', async () => {
      await prisma.report.update({
        where: { id: reportId },
        data: {
          reportData: {
            damages: [{ part: 'door', owner: 'Anna Muster' }],
            signoff: { rating: 3, signature: 'data:image/png;base64,AAA', phone: '+49301234567' },
          },
        },
      });
      const res = await request(app.getHttpServer())
        .get(`/api/v1/public/reports/${code}/full`)
        .expect(200);
      // The finding stays; the person does not.
      expect(res.body.reportData.signoff.rating).toBe(3);
      expect(res.body.reportData.signoff.signature).toBeUndefined();
      expect(res.body.reportData.signoff.phone).toBeUndefined();
      expect(res.body.reportData.damages[0].part).toBe('door');
      expect(res.body.reportData.damages[0].owner).toBeUndefined();
      await prisma.report.update({
        where: { id: reportId },
        data: { reportData: { damages: [{ part: 'door' }, { part: 'bumper' }] } },
      });
    });

    it('10-3a. removes every person-bearing field the DTO defines', async () => {
      // Not a guess at what PII looks like: these are the fields
      // `ReportDataV1Dto` actually declares that can hold a person, plus the
      // recipient rows. The first blocklist missed all of them.
      await prisma.report.update({
        where: { id: reportId },
        data: {
          reportData: {
            vehicle: {
              make: 'BMW',
              company: 'AutoCheck GmbH',
              branch: 'Berlin Mitte',
              responsible: 'Klaus Muster',
            },
            recipients: [{ name: 'Anna Muster', email: 'anna@example.com' }],
            damages: [{ part: 'door' }],
          },
        },
      });
      const res = await request(app.getHttpServer())
        .get(`/api/v1/public/reports/${code}/full`)
        .expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('Anna Muster');
      expect(body).not.toContain('Klaus Muster');
      expect(body).not.toContain('AutoCheck GmbH');
      expect(body).not.toContain('Berlin Mitte');
      expect(res.body.reportData.recipients).toBeUndefined();
      // The findings around them are untouched.
      expect(res.body.reportData.vehicle.make).toBe('BMW');
      expect(res.body.reportData.damages[0].part).toBe('door');
      await prisma.report.update({
        where: { id: reportId },
        data: { reportData: { damages: [{ part: 'door' }, { part: 'bumper' }] } },
      });
    });

    it('10-3b. 404s while the report upload has not completed', async () => {
      // `checkReport` has always tested `uploaded`; this route did not, and a
      // half-uploaded report was served as a finished document.
      await prisma.report.update({ where: { id: reportId }, data: { uploaded: false } });
      await request(app.getHttpServer())
        .get(`/api/v1/public/reports/${code}/full`)
        .expect(404);
      await prisma.report.update({ where: { id: reportId }, data: { uploaded: true } });
    });

    it('10-4. 404s once the car is off the market', async () => {
      await prisma.listing.update({ where: { id: listingId }, data: { status: 'HIDDEN' } });
      await request(app.getHttpServer())
        .get(`/api/v1/public/reports/${code}/full`)
        .expect(404);
      await prisma.listing.update({ where: { id: listingId }, data: { status: 'ACTIVE' } });
    });
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

  // BE-S2 — a listing with no inspection behind it. The whole point of the
  // feature is that these are sellable AND unmistakable.
  describe('BE-S2: manual (self-declared) listings', () => {
    let manualId: string;

    beforeAll(async () => {
      const manual = await prisma.listing.create({
        data: {
          sellerId,
          reportId: null,
          source: 'manual',
          status: 'ACTIVE',
          package: 'standard',
          priceCents: 990000,
          city: 'Dresden',
          make: 'Opel',
          model: 'Astra',
          ...listingSearchColumns({ city: 'Dresden', make: 'Opel', model: 'Astra' }),
          year: 2016,
          mileageKm: 132000,
          fuelType: 'petrol',
          transmission: 'manual',
          powerKw: 92,
          vehicleData: {
            schemaVersion: 1,
            vehicle: { make: 'Opel', model: 'Astra', year: 2016 },
            selfDeclaration: { accidentFreeClaimed: true, ownersCount: 2 },
          },
          publishedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 86400000),
        },
      });
      manualId = manual.id;
    });

    afterAll(async () => {
      await prisma.listing.deleteMany({ where: { id: manualId } });
    });

    it('11a. two manual listings coexist despite reportId being UNIQUE (NULLs are distinct)', async () => {
      // The load-bearing assumption behind making reportId nullable rather than
      // synthesising a Report row: the single-use claim index still works.
      const second = await prisma.listing.create({
        data: {
          sellerId,
          reportId: null,
          source: 'manual',
          status: 'DRAFT',
          priceCents: 0,
          city: '',
        },
      });
      try {
        const both = await prisma.listing.findMany({
          where: { id: { in: [manualId, second.id] }, reportId: null },
        });
        expect(both).toHaveLength(2);
      } finally {
        await prisma.listing.deleteMany({ where: { id: second.id } });
      }
    });

    it('11b. appears in the showroom, but verified:false / qualityScore:null / self_declared', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/public/listings?city=Dresden')
        .expect(200);
      const card = res.body.items.find((i: { id: string }) => i.id === manualId);
      expect(card).toBeTruthy();
      expect(card.verified).toBe(false);
      expect(card.qualityScore).toBeNull();
      expect(card.source).toBe('manual');
      expect(card.inspection).toEqual({ status: 'self_declared', reportCode: null });
      expect(card.vehicle.make).toBe('Opel');
    });

    it('11c. is filterable by make/model/year through the listing columns', async () => {
      const hit = await request(app.getHttpServer())
        .get('/api/v1/public/listings?make=Opel&model=Astra&yearFrom=2015&yearTo=2017')
        .expect(200);
      expect(hit.body.items.some((i: { id: string }) => i.id === manualId)).toBe(true);

      const miss = await request(app.getHttpServer())
        .get('/api/v1/public/listings?make=Opel&yearFrom=2020')
        .expect(200);
      expect(miss.body.items.some((i: { id: string }) => i.id === manualId)).toBe(false);
    });

    it('11d. ?verifiedOnly=true excludes it and keeps the inspected one', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/public/listings?verifiedOnly=true')
        .expect(200);
      const ids: string[] = res.body.items.map((i: { id: string }) => i.id);
      expect(ids).not.toContain(manualId);
      expect(res.body.items.every((i: { verified: boolean }) => i.verified)).toBe(true);

      // Default (absent) must NOT filter — manual listings are shown, badged.
      const unfiltered = await request(app.getHttpServer())
        .get('/api/v1/public/listings?city=Dresden')
        .expect(200);
      expect(unfiltered.body.items.map((i: { id: string }) => i.id)).toContain(manualId);
    });

    it('11f. ?country filters on the exact code, and never returns a listing with none', async () => {
      // Two rows in two countries, plus the fixture above, which has no country
      // at all: that third row is the point of the test. `country_code` is
      // nullable and never backfilled, so a search must not answer with rows
      // that never claimed the country.
      const de = await prisma.listing.create({
        data: {
          sellerId,
          source: 'manual',
          status: 'ACTIVE',
          priceCents: 1200000,
          city: 'Leipzig',
          countryCode: 'DE',
          make: 'Skoda',
          model: 'Octavia',
          ...listingSearchColumns({ city: 'Leipzig', make: 'Skoda', model: 'Octavia' }),
          publishedAt: new Date(),
        },
      });
      const at = await prisma.listing.create({
        data: {
          sellerId,
          source: 'manual',
          status: 'ACTIVE',
          priceCents: 1300000,
          city: 'Wien',
          countryCode: 'AT',
          make: 'Skoda',
          model: 'Octavia',
          ...listingSearchColumns({ city: 'Wien', make: 'Skoda', model: 'Octavia' }),
          publishedAt: new Date(),
        },
      });
      try {
        const res = await request(app.getHttpServer())
          .get('/api/v1/public/listings?country=DE&make=Skoda')
          .expect(200);
        const ids: string[] = res.body.items.map((i: { id: string }) => i.id);
        expect(ids).toContain(de.id);
        expect(ids).not.toContain(at.id);
        expect(ids).not.toContain(manualId);

        // Lower case from a hand-written URL resolves to the same rows: the
        // query DTO upper-cases before the query, so the column never has to
        // be compared case-insensitively.
        const lower = await request(app.getHttpServer())
          .get('/api/v1/public/listings?country=de&make=Skoda')
          .expect(200);
        expect(lower.body.items.map((i: { id: string }) => i.id)).toContain(de.id);

        // A two-character code is the whole contract; anything else is a 400
        // rather than a silently unfiltered search.
        await request(app.getHttpServer())
          .get('/api/v1/public/listings?country=DEU')
          .expect(400);

        // The card carries the code, so the showroom can show the country
        // without a second call.
        const card = res.body.items.find((i: { id: string }) => i.id === de.id);
        expect(card.countryCode).toBe('DE');
      } finally {
        await prisma.listing.deleteMany({ where: { id: { in: [de.id, at.id] } } });
      }
    });

    it('11e. the detail view is honest and surfaces the seller declaration separately', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/public/listings/${manualId}`)
        .expect(200);
      expect(res.body.verified).toBe(false);
      expect(res.body.qualityScore).toBeNull();
      expect(res.body.reportCode).toBeNull();
      expect(res.body.inspection.status).toBe('self_declared');
      // Never merged into `vehicle` — a claim is not a finding.
      expect(res.body.selfDeclaration).toEqual({ accidentFreeClaimed: true, ownersCount: 2 });
      expect(res.body.vehicle.powerKw).toBe(92);
      expect(res.body.vehicle.fuelType).toBe('petrol');
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
        sellerId, reportId: stdReport.id, source: 'report', status: 'ACTIVE', package: 'standard',
        priceCents: 1000000, city: 'Berlin', publishedAt: new Date(),
        make: 'BMW', model: '318i', year: 2017,
        ...listingSearchColumns({ city: 'Berlin', make: 'BMW', model: '318i' }),
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

  // ============================================================
  // Permanent image URLs — the showroom read path
  //
  // The listing seeded above is report-backed, so its images are entries in
  // `report.photosManifest` and it owns no `ListingPhoto` rows at all. Which URL
  // the showroom serves for them is decided by ONE column,
  // `listing.publicPhotosMirroredAt`, plus whether a public bucket is wired.
  // ============================================================
  describe('permanent showroom image URLs', () => {
    const BASE = 'https://img.test.invalid';

    afterEach(async () => {
      jest.restoreAllMocks();
      await prisma.listing.update({
        where: { id: listingId },
        data: { publicPhotosMirroredAt: null },
      });
    });

    it('12. unmirrored + no public bucket => exactly today’s signed URLs', async () => {
      const r2 = app.get(R2Service);
      expect(r2.isPublicBucketConfigured()).toBe(false);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/public/listings/${listingId}`)
        .expect(200);

      if (r2.isConfigured()) {
        expect(res.body.photos).toHaveLength(1);
        expect(res.body.photos[0].url).toContain('X-Amz-Signature');
        expect(res.body.photos[0].kind).toBe('front');
      } else {
        // No credentials in this environment: nothing to sign, nothing to show.
        expect(res.body.photos).toEqual([]);
      }
    });

    it('13. mirrored + public bucket => a permanent, query-string-free URL', async () => {
      const r2 = app.get(R2Service);
      jest.spyOn(r2, 'isPublicBucketConfigured').mockReturnValue(true);
      jest.spyOn(r2, 'publicObjectUrl').mockImplementation((key: string) => `${BASE}/${key}`);
      await prisma.listing.update({
        where: { id: listingId },
        data: { publicPhotosMirroredAt: new Date() },
      });

      const expected = `${BASE}/${mirroredPhotoKey(listingId, `report-photos/${did}/front.jpg`)}`;

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/public/listings/${listingId}`)
        .expect(200);
      expect(detail.body.photos[0].url).toBe(expected);
      expect(detail.body.photos[0].url).not.toContain('?');
      expect(detail.body.photos[0].kind).toBe('front');

      const search = await request(app.getHttpServer())
        .get('/api/v1/public/listings?make=BMW&model=320d&city=Berlin')
        .expect(200);
      const card = search.body.items.find((i: { id: string }) => i.id === listingId);
      expect(card).toBeTruthy();
      expect(card.thumbnailUrl).toBe(expected);
    });

    /**
     * The rollback case. A stamped listing in an environment whose `R2_PUBLIC_*`
     * vars were removed must not emit `${BASE}`-less garbage; it goes back to
     * signing, which still works because the mirror never deleted the original.
     */
    it('14. mirrored but the bucket was un-configured => back to signed URLs', async () => {
      const r2 = app.get(R2Service);
      await prisma.listing.update({
        where: { id: listingId },
        data: { publicPhotosMirroredAt: new Date() },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/public/listings/${listingId}`)
        .expect(200);
      for (const photo of res.body.photos) {
        expect(photo.url.startsWith(BASE)).toBe(false);
        if (r2.isConfigured()) expect(photo.url).toContain('X-Amz-Signature');
      }
    });
  });
});
