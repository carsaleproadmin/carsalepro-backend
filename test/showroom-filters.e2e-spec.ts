import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './helpers/test-app';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  citySearchKeys,
  normalizeCompact,
  normalizeSearchText,
} from '../src/common/search-text';
import { listingSearchColumns } from '../src/listings/listing-search-columns';

/*
 * DEN-205. Every showroom filter, against a real database.
 *
 * The bug reported was one case - a Berlin car that "Berlin" found and "Берлин"
 * did not - but six independent defects turned up under it, and each has its
 * own block below. The unit tests in `src/common/search-text.spec.ts` cover the
 * fold itself; this covers the query built around it, which is where two of the
 * six lived (a numeric filter dropped when it was zero, and an unstable page
 * order that showed one row twice and another never).
 *
 * Expectations are computed by an ORACLE rather than written out, so a case
 * costs one line and a wrong expectation cannot pass by agreeing with a wrong
 * implementation.
 */

const TAG = `FILTERS-${Date.now().toString(36)}`;

type Seed = {
  city: string;
  countryCode: string | null;
  make: string;
  model: string;
  year: number;
  priceCents: number;
  mileageKm: number;
  bodyType: string;
  driveType: string;
};

/**
 * Deliberately mixed scripts, cases, diacritics and punctuation - the shapes
 * real rows actually have, because the table is written by a geocoder answering
 * in whatever language the seller's browser asked in.
 */
const SEEDS: Seed[] = [
  { city: 'Berlin', countryCode: 'DE', make: 'BMW', model: '320d', year: 2018, priceCents: 1499000, mileageKm: 120000, bodyType: 'sedan', driveType: 'rwd' },
  { city: 'Берлин', countryCode: 'DE', make: 'Volkswagen', model: 'Passat', year: 2018, priceCents: 1650000, mileageKm: 99000, bodyType: 'estate', driveType: 'fwd' },
  { city: 'BERLIN', countryCode: 'DE', make: 'Ford', model: 'Focus', year: 2014, priceCents: 599000, mileageKm: 210000, bodyType: 'hatchback', driveType: 'fwd' },
  { city: 'München', countryCode: 'DE', make: 'BMW', model: 'X5', year: 2020, priceCents: 4599000, mileageKm: 54000, bodyType: 'suv', driveType: 'awd' },
  { city: 'Köln', countryCode: 'DE', make: 'Mercedes-Benz', model: 'C 220', year: 2017, priceCents: 1750000, mileageKm: 131000, bodyType: 'sedan', driveType: 'rwd' },
  { city: 'Frankfurt am Main', countryCode: 'DE', make: 'Porsche', model: 'Macan', year: 2019, priceCents: 5299000, mileageKm: 61000, bodyType: 'suv', driveType: 'awd' },
  { city: 'Zürich', countryCode: 'CH', make: 'Tesla', model: 'Model 3', year: 2021, priceCents: 3299000, mileageKm: 32000, bodyType: 'sedan', driveType: 'rwd' },
  { city: 'Wien', countryCode: 'AT', make: 'Škoda', model: 'Octavia', year: 2017, priceCents: 1199000, mileageKm: 167000, bodyType: 'estate', driveType: 'fwd' },
  { city: 'Киев', countryCode: 'UA', make: 'Renault', model: 'Megane', year: 2015, priceCents: 749000, mileageKm: 198000, bodyType: 'hatchback', driveType: 'fwd' },
  { city: 'Москва', countryCode: 'RU', make: 'Lada', model: 'Vesta', year: 2019, priceCents: 650000, mileageKm: 72000, bodyType: 'sedan', driveType: 'fwd' },
  { city: 'Praha', countryCode: 'CZ', make: 'Škoda', model: 'Superb', year: 2020, priceCents: 2199000, mileageKm: 77000, bodyType: 'estate', driveType: 'awd' },
  { city: 'Warszawa', countryCode: 'PL', make: 'Toyota', model: 'Corolla', year: 2021, priceCents: 1899000, mileageKm: 41000, bodyType: 'sedan', driveType: 'fwd' },
  { city: 'Göteborg', countryCode: 'SE', make: 'Volvo', model: 'V90', year: 2018, priceCents: 2499000, mileageKm: 118000, bodyType: 'estate', driveType: 'awd' },
  { city: 'Leipzig', countryCode: null, make: 'Seat', model: 'Leon', year: 2016, priceCents: 999000, mileageKm: 152000, bodyType: 'hatchback', driveType: 'fwd' },
];

describe('Showroom filters (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sellerId: string;
  let ids: string[];

  /** The oracle: what a query SHOULD return, stated once in plain terms. */
  function expected(q: Record<string, unknown>): Set<string> {
    const keys = citySearchKeys(q.city as string | undefined);
    const makeKey = normalizeCompact(q.make as string | undefined);
    const modelKey = normalizeCompact(q.model as string | undefined);
    const body = normalizeSearchText(q.bodyType as string | undefined);
    const drive = normalizeSearchText(q.driveType as string | undefined);
    const out = new Set<string>();
    SEEDS.forEach((s, i) => {
      if (keys.length && !keys.some((k) => normalizeSearchText(s.city).includes(k))) return;
      if (q.country && s.countryCode !== q.country) return;
      if (makeKey && !normalizeCompact(s.make).includes(makeKey)) return;
      if (modelKey && !normalizeCompact(s.model).includes(modelKey)) return;
      if (body && s.bodyType !== body) return;
      if (drive && s.driveType !== drive) return;
      if (q.yearFrom != null && s.year < (q.yearFrom as number)) return;
      if (q.yearTo != null && s.year > (q.yearTo as number)) return;
      if (q.priceFrom != null && s.priceCents < (q.priceFrom as number)) return;
      if (q.priceTo != null && s.priceCents > (q.priceTo as number)) return;
      if (q.mileageTo != null && s.mileageKm > (q.mileageTo as number)) return;
      // Every seed is seller-declared, so a verified-only search returns none.
      if (q.verifiedOnly) return;
      out.add(ids[i]);
    });
    return out;
  }

  /** Walk every page and keep only the rows this spec created. */
  async function actual(q: Record<string, unknown>): Promise<Set<string>> {
    const mine = new Set(ids);
    const found = new Set<string>();
    for (let page = 1; page <= 60; page++) {
      const res = await request(app.getHttpServer())
        .get('/api/v1/public/listings')
        .query({ ...q, page })
        .expect(200);
      for (const item of res.body.items) if (mine.has(item.id)) found.add(item.id);
      if (page >= (res.body.pages || 1)) break;
    }
    return found;
  }

  async function check(q: Record<string, unknown>): Promise<void> {
    expect([...(await actual(q))].sort()).toEqual([...expected(q)].sort());
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);

    const user = await prisma.user.create({
      data: { email: `${TAG}@example.com`.toLowerCase(), gdprConsentAt: new Date() },
    });
    sellerId = user.id;

    ids = [];
    for (const s of SEEDS) {
      const row = await prisma.listing.create({
        data: {
          sellerId,
          source: 'manual',
          status: 'ACTIVE',
          package: 'standard',
          description: TAG,
          city: s.city,
          countryCode: s.countryCode,
          make: s.make,
          model: s.model,
          // The same derivation production uses - a fixture that rolled its own
          // would be testing the fixture, not the write path.
          ...listingSearchColumns(s),
          year: s.year,
          priceCents: s.priceCents,
          mileageKm: s.mileageKm,
          bodyType: s.bodyType,
          driveType: s.driveType,
          // Every row in the same second, on purpose: that is what exposed the
          // page order having no tiebreaker.
          publishedAt: new Date(),
        },
      });
      ids.push(row.id);
    }
  });

  afterAll(async () => {
    await prisma.listing.deleteMany({ where: { sellerId } });
    await prisma.user.delete({ where: { id: sellerId } }).catch(() => undefined);
    await app.close();
  });

  /* ── 1. the reported bug: a city written in another script ───────────── */
  describe('city, across scripts', () => {
    it.each(['Berlin', 'berlin', 'BERLIN', '  Berlin  ', 'Берлин', 'БЕРЛИН', 'бЕрЛиН'])(
      'finds the Berlin cars by %j',
      async (city) => {
        // All three Berlin rows, whichever alphabet either side used.
        expect((await actual({ city })).size).toBe(3);
        await check({ city });
      },
    );
  });

  /* ── 2. diacritics ───────────────────────────────────────────────────── */
  describe('city, with and without diacritics', () => {
    it.each([
      'München', 'Munchen', 'MUENCHEN', 'Мюнхен', 'munich',
      'Köln', 'Koln', 'koeln', 'Cologne',
      'Zürich', 'Zurich', 'Göteborg', 'Goteborg',
    ])('resolves %j', (city) => check({ city }));
  });

  /* ── 3. exonyms: different words for one place ───────────────────────── */
  describe('city, across languages', () => {
    it.each([
      'Wien', 'Vienna', 'Киев', 'Kyiv', 'Kiev', 'Москва', 'Moscow',
      'Praha', 'Prague', 'Warszawa', 'Warsaw', 'Gothenburg',
    ])('resolves %j', (city) => check({ city }));

    it('matches a partial city name', () => check({ city: 'Frankfurt' }));
    it('finds nothing for a city nobody listed', async () => {
      expect((await actual({ city: 'Nowhere' })).size).toBe(0);
    });
    it('treats a blank city as no filter at all', async () => {
      expect((await actual({ city: '   ' })).size).toBe(SEEDS.length);
    });
  });

  /* ── 4. make and model, where the punctuation is never agreed ────────── */
  describe('make and model', () => {
    it.each(['BMW', 'bmw', 'BMW ', 'Volvo', 'Mercedes', 'Mercedes-Benz', 'mercedes benz',
      'Skoda', 'Škoda', 'Tesla', 'Porsche', 'Nothing'])('make %j', (make) => check({ make }));

    it.each(['Octavia', 'octavia', 'A4', 'C 220', 'C220', 'c-220', 'Model 3', 'model3',
      'V90', '320', 'Nothing'])('model %j', (model) => check({ model }));
  });

  /* ── 5. the enumerations, which arrive hand-typed as often as picked ─── */
  describe('country, body and drive', () => {
    it.each(['DE', 'CH', 'AT', 'UA', 'RU', 'CZ', 'PL', 'SE', 'XX'])('country %s', (country) =>
      check({ country }),
    );
    it('never returns a listing that claims no country', async () => {
      // Null means "nobody said". Answering a country search with it would be
      // the same defect as backfilling the column with a guess.
      const found = await actual({ country: 'DE' });
      expect(found.has(ids[SEEDS.findIndex((s) => s.countryCode === null)])).toBe(false);
    });
    it.each(['sedan', 'SEDAN', 'Sedan', 'suv', 'estate', 'hatchback', 'coupe'])(
      'bodyType %s', (bodyType) => check({ bodyType }),
    );
    it.each(['fwd', 'RWD', 'awd', 'AWD', 'rwd', '4wd'])('driveType %s', (driveType) =>
      check({ driveType }),
    );
  });

  /* ── 6. the numeric ranges, and the zero that used to be ignored ─────── */
  describe('year, price and mileage', () => {
    it.each([1900, 2014, 2015, 2018, 2020, 2021, 2100])('yearFrom %s', (yearFrom) =>
      check({ yearFrom }),
    );
    it.each([1900, 2014, 2016, 2019, 2021, 2100])('yearTo %s', (yearTo) => check({ yearTo }));
    it('handles a closed year range', () => check({ yearFrom: 2018, yearTo: 2019 }));
    it('returns nothing for an inverted range', async () => {
      expect((await actual({ yearFrom: 2020, yearTo: 2015 })).size).toBe(0);
    });

    it.each([0, 599000, 700000, 1000000, 3000000, 9900000])('priceFrom %s', (priceFrom) =>
      check({ priceFrom }),
    );
    it.each([0, 599000, 1500000, 5299000])('priceTo %s', (priceTo) => check({ priceTo }));
    it('handles a closed price range', () => check({ priceFrom: 1000000, priceTo: 1500000 }));

    it.each([0, 32000, 41000, 50000, 100000, 210000, 999999])('mileageTo %s', (mileageTo) =>
      check({ mileageTo }),
    );

    it('treats mileageTo=0 as a real question, not as no filter', async () => {
      /*
       * The whole of one of the six defects. `q.mileageTo ? … : {}` dropped the
       * filter when it was zero and answered "nothing on the clock" with the
       * entire table - the one answer that is certainly wrong.
       */
      expect((await actual({ mileageTo: 0 })).size).toBe(0);
      expect((await actual({ priceTo: 0 })).size).toBe(0);
    });
  });

  /* ── 7. combinations, which is how the filters are actually used ─────── */
  describe('combinations', () => {
    it.each([
      { country: 'DE', bodyType: 'suv' },
      { city: 'Берлин', make: 'BMW' },
      { city: 'Berlin', make: 'BMW' },
      { city: 'Мюнхен', bodyType: 'suv' },
      { driveType: 'awd', priceFrom: 2000000 },
      { bodyType: 'sedan', driveType: 'rwd' },
      { make: 'BMW', yearFrom: 2019 },
      { country: 'DE', mileageTo: 100000 },
      { country: 'DE', city: 'Moscow' },
      {
        country: 'DE', city: 'Берлин', make: 'BMW', model: '320', bodyType: 'SEDAN',
        driveType: 'RWD', yearFrom: 2015, yearTo: 2020, priceFrom: 100000,
        priceTo: 2000000, mileageTo: 200000,
      },
    ])('%j', (q) => check(q));
  });

  /* ── 8. paging and sorting must not change WHICH rows come back ──────── */
  describe('sort and paging', () => {
    it.each(['recent', 'price_asc', 'price_desc'])('sort=%s returns the same set', (sort) =>
      check({ country: 'DE', sort }),
    );

    it('shows every row exactly once across the pages', async () => {
      /*
       * The sixth defect. Ordering was `package` then `price` or `publishedAt`,
       * with no tiebreaker, so rows that agreed on both had an undefined order
       * that Postgres was free to change per page: one listing appeared twice
       * and another never appeared at all. Every seed here is published in the
       * same second, which is what makes it reproducible.
       */
      const seen: string[] = [];
      const mine = new Set(ids);
      for (let page = 1; page <= 60; page++) {
        const res = await request(app.getHttpServer())
          .get('/api/v1/public/listings')
          .query({ page })
          .expect(200);
        for (const item of res.body.items) if (mine.has(item.id)) seen.push(item.id);
        if (page >= (res.body.pages || 1)) break;
      }
      expect(seen.sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(seen.length);
    });
  });
});
