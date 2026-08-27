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

  /** The same walk, keeping the ORDER the API returned this spec's rows in. */
  async function actualOrdered(q: Record<string, unknown>): Promise<string[]> {
    const mine = new Set(ids);
    const found: string[] = [];
    for (let page = 1; page <= 60; page++) {
      const res = await request(app.getHttpServer())
        .get('/api/v1/public/listings')
        .query({ ...q, page })
        .expect(200);
      for (const item of res.body.items) if (mine.has(item.id)) found.push(item.id);
      if (page >= (res.body.pages || 1)) break;
    }
    return found;
  }

  /** The seed behind an id, so a returned order can be judged against its data. */
  function seedOf(id: string): Seed {
    return SEEDS[ids.indexOf(id)];
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
    it.each([
      'default',
      'recent',
      'price_asc',
      'price_desc',
      'year_asc',
      'year_desc',
      'mileage_asc',
      'mileage_desc',
    ])('sort=%s returns the same set', (sort) => check({ country: 'DE', sort }));

    /*
     * DEN-211. A sort orders rows; it must never REMOVE one. `year` and
     * `mileageKm` are nullable, and the ordinary way to get this wrong is to
     * filter the nulls out to keep the order tidy - which quietly hides every
     * listing whose seller left the field blank.
     */
    it('keeps a listing with no year and no mileage in every order', async () => {
      const base = await request(app.getHttpServer())
        .get('/api/v1/public/listings')
        .query({ perPage: 100 })
        .expect(200);

      for (const sort of ['year_asc', 'year_desc', 'mileage_asc', 'mileage_desc']) {
        const res = await request(app.getHttpServer())
          .get('/api/v1/public/listings')
          .query({ perPage: 100, sort })
          .expect(200);
        expect(res.body.total).toBe(base.body.total);
      }
    });

    it.each([10, 20, 30, 50, 100])('perPage=%i is honoured', async (perPage) => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/public/listings')
        .query({ perPage })
        .expect(200);

      expect(res.body.pageSize).toBe(perPage);
      expect(res.body.items.length).toBeLessThanOrEqual(perPage);
      expect(res.body.pages).toBe(Math.ceil(res.body.total / perPage));
    });

    it('refuses a page size that is not offered', async () => {
      // Closed set, not a clamp: an open integer is an invitation to ask for
      // ten thousand rows, and answering 25 with 20 tells the reader nothing.
      await request(app.getHttpServer())
        .get('/api/v1/public/listings')
        .query({ perPage: 25 })
        .expect(400);
    });

    it('refuses a sort it does not offer', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/public/listings')
        .query({ sort: 'cheapest' })
        .expect(400);
    });
  });

  /* ── 9. a filter and a sort applied together ─────────────────────────── */
  describe('filtering and sorting at the same time', () => {
    /*
     * DEN-211. The two features were built separately and this is the place
     * they can disagree.
     *
     * Two properties, and they are different questions:
     *
     *  - WHICH rows come back must be decided by the filter ALONE. A sort that
     *    changes the set is a sort that hides a car - the way to get this wrong
     *    is to drop null years to keep an ORDER BY tidy, and every seed below
     *    is chosen so a filter leaves several rows with the same package.
     *  - The ORDER of those rows must obey the sort. Asserting the set alone
     *    would pass with the sort ignored entirely, which is exactly what a
     *    mistyped query parameter does.
     */
    const KEY: Record<string, { of: (s: Seed) => number; dir: 1 | -1 }> = {
      price_asc: { of: (s) => s.priceCents, dir: 1 },
      price_desc: { of: (s) => s.priceCents, dir: -1 },
      year_asc: { of: (s) => s.year, dir: 1 },
      year_desc: { of: (s) => s.year, dir: -1 },
      mileage_asc: { of: (s) => s.mileageKm, dir: 1 },
      mileage_desc: { of: (s) => s.mileageKm, dir: -1 },
    };

    const FILTERS: Record<string, unknown>[] = [
      { country: 'DE' },
      { city: 'Берлин' },
      { bodyType: 'SEDAN' },
      { driveType: 'fwd' },
      { make: 'skoda' },
      { yearFrom: 2017 },
      { priceTo: 2000000 },
      { mileageTo: 120000 },
      { country: 'DE', bodyType: 'sedan' },
      { city: 'Munchen', make: 'BMW' },
    ];

    const CASES = FILTERS.flatMap((filter) =>
      Object.keys(KEY).map((sort) => [filter, sort] as const),
    );

    it.each(CASES)('%j sorted by %s', async (filter, sort) => {
      const returned = await actualOrdered({ ...filter, sort, perPage: 100 });

      // 1. The filter, and only the filter, decides the set.
      expect([...returned].sort()).toEqual([...expected(filter)].sort());

      // 2. The sort decides the order of it.
      const { of, dir } = KEY[sort];
      const values = returned.map((id) => of(seedOf(id)));
      for (let i = 1; i < values.length; i++) {
        expect(Math.sign(values[i] - values[i - 1]) * dir).toBeGreaterThanOrEqual(0);
      }
    });

    it('gives the same answer whichever order the query names things in', async () => {
      // A query string is a bag, not a sequence. This fails when a builder
      // overwrites one key with another - the sibling-OR defect of DEN-205 in
      // a new place.
      const a = await actualOrdered({ country: 'DE', sort: 'price_asc', perPage: 100 });
      const b = await actualOrdered({ sort: 'price_asc', perPage: 100, country: 'DE' });
      expect(a).toEqual(b);
    });

    it('keeps the filter across every page of a sorted result', async () => {
      /*
       * Paging is where a filter is most likely to be lost: page 1 is built by
       * one code path in most implementations and the rest by another. Two rows
       * a page over a filtered, sorted set walks that seam repeatedly.
       */
      const seen: string[] = [];
      const mine = new Set(ids);
      for (let page = 1; page <= 60; page++) {
        const res = await request(app.getHttpServer())
          .get('/api/v1/public/listings')
          .query({ country: 'DE', sort: 'price_desc', perPage: 10, page })
          .expect(200);
        for (const item of res.body.items) {
          if (mine.has(item.id)) seen.push(item.id);
          // Every row on every page must satisfy the filter, not only mine.
          expect(item.countryCode ?? 'DE').toBe('DE');
        }
        if (page >= (res.body.pages || 1)) break;
      }

      expect([...seen].sort()).toEqual([...expected({ country: 'DE' })].sort());
      // And no row twice - the tiebreaker still holds under a filter.
      expect(new Set(seen).size).toBe(seen.length);

      const prices = seen.map((id) => seedOf(id).priceCents);
      for (let i = 1; i < prices.length; i++) {
        expect(prices[i]).toBeLessThanOrEqual(prices[i - 1]);
      }
    });

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
