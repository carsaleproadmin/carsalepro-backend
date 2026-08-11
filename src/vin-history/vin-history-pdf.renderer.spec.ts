// Category: DOCUMENT RENDERING. Pure — no DB, no R2, no Nest container.
//
// Only the things a rendered PDF can actually testify to live here: it is a
// PDF, it paginates, every page gets a footer, and no input makes it throw.
// What the document SAYS is asserted in `vin-history-report-model.spec.ts`,
// which is the layer that can be read.
import { pdfFontsAvailable } from '../legal/pdf-fonts';
import { pdfPageCount, trackPageVisits } from '../../test/helpers/pdf-inspect';
import { VinHistoryPayloadV1, VinHistoryMileageRecord } from './vin-history-payload-v1';
import {
  VinHistoryCoverageMap,
  VinHistoryPayloadV2,
  VinHistorySectionCoverage,
  emptyCoverageMap,
} from './vin-history-payload-v2';
import { VIN_HISTORY_PDF_LOCALES } from './vin-history-pdf.i18n';
import { renderVinHistoryPdf, vinHistoryPdfFilename } from './vin-history-pdf.renderer';

const RENDERED_AT = new Date('2026-02-05T10:30:00.000Z');

const OPTS = {
  locale: 'de',
  purchaseId: 'ckqz2zk5e0000a8b8h4t8j2z3',
  purchasedAt: new Date('2026-02-04T08:15:00.000Z'),
  renderedAt: RENDERED_AT,
};

function mileage(count: number): VinHistoryMileageRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `20${String(10 + Math.floor(i / 12)).padStart(2, '0')}-${String((i % 12) + 1).padStart(2, '0')}-14`,
    mileageKm: 10_000 + i * 1_700,
    source: 'service' as const,
    countryCode: 'DE',
    suspicious: i % 17 === 0,
  }));
}

function payload(overrides: Partial<VinHistoryPayloadV1> = {}): VinHistoryPayloadV1 {
  return {
    schemaVersion: 1,
    vin: 'WAUZZZ8V8MA012345',
    provider: 'mock',
    synthetic: true,
    generatedAt: '2026-02-01T00:00:00.000Z',
    summary: {
      recordCount: 6,
      ownersCount: 1,
      countriesSeen: ['DE'],
      hasAccidentRecords: true,
      hasSalvageOrTotalLoss: false,
      hasOdometerRollback: false,
      hasStolenRecord: false,
      hasOpenRecalls: true,
      lastRecordedMileageKm: 184000,
      firstRegistration: '2015-06-12',
    },
    owners: [
      {
        sequence: 1,
        type: 'private',
        countryCode: 'DE',
        fromDate: '2015-06-12',
        toDate: null,
        durationMonths: null,
      },
    ],
    mileageRecords: mileage(3),
    damageRecords: [
      {
        date: '2021-09-02',
        severity: 'moderate',
        areas: ['front', 'left'],
        estimatedRepairCostCents: 1_234_500,
        currency: 'EUR',
        salvage: false,
        airbagDeployed: true,
        description: 'Front left collision, bumper and wing replaced',
        source: 'insurance_claim',
      },
    ],
    registrations: [
      {
        countryCode: 'DE',
        region: 'Bayern',
        firstRegistration: '2015-06-12',
        lastRegistration: null,
        plateMasked: 'DE-****42',
        status: 'active',
      },
    ],
    recalls: [
      {
        reference: 'RC-2019-4711',
        issuedAt: '2019-04-01',
        authority: 'KBA',
        title: 'Airbag inflator replacement',
        description: 'Passenger-side inflator may rupture. Remedy available.',
        open: true,
      },
    ],
    theft: {
      stolen: false,
      reportedAt: null,
      countryCode: null,
      recoveredAt: null,
      source: 'police_registry',
    },
    inspections: [
      {
        date: '2023-03-11',
        countryCode: 'DE',
        authority: 'TÜV',
        result: 'pass_with_defects',
        mileageKm: 150000,
        defects: ['brake wear'],
        nextDueDate: '2025-03-11',
      },
    ],
    ...overrides,
  };
}

describe('renderVinHistoryPdf', () => {
  it('reuses the embedded Unicode fonts', () => {
    // The document is served in Russian. pdfkit's built-in Helvetica is
    // WinAnsi — Cyrillic labels would render as mojibake in something a buyer
    // paid for. The faces are shared with the contract renderer rather than
    // copied: 1.2 MB of TTF, one copy.
    expect(pdfFontsAvailable()).toBe(true);
  });

  it('produces a PDF', async () => {
    const pdf = await renderVinHistoryPdf(payload(), OPTS);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2048);
  });

  it('is deterministic for identical input', async () => {
    const [a, b] = await Promise.all([
      renderVinHistoryPdf(payload(), OPTS),
      renderVinHistoryPdf(payload(), OPTS),
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it('renders every supported locale, Cyrillic included', async () => {
    for (const locale of VIN_HISTORY_PDF_LOCALES) {
      const pdf = await renderVinHistoryPdf(payload(), { ...OPTS, locale });
      expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    }
  });

  it('renders a report with no records at all rather than an empty file', async () => {
    const pdf = await renderVinHistoryPdf(
      payload({
        owners: [],
        mileageRecords: [],
        damageRecords: [],
        registrations: [],
        recalls: [],
        inspections: [],
        theft: {
          stolen: false,
          reportedAt: null,
          countryCode: null,
          recoveredAt: null,
          source: null,
        },
      }),
      OPTS,
    );
    // Seven "we hold nothing here" notes still make a page.
    expect(pdfPageCount(pdf)).toBeGreaterThanOrEqual(1);
  });

  it('never throws on a payload the renderer has not seen before', async () => {
    const broken = {
      schemaVersion: 1,
      vin: 'WAUZZZ8V8MA012345',
      provider: 'mock',
      synthetic: false,
      generatedAt: null,
    } as unknown as VinHistoryPayloadV1;
    const pdf = await renderVinHistoryPdf(broken, OPTS);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('names the download after the VIN', () => {
    expect(vinHistoryPdfFilename('wauzzz8v8ma012345')).toBe(
      'carsalepro-vin-history-WAUZZZ8V8MA012345.pdf',
    );
  });
});

describe('renderVinHistoryPdf — pagination and footers', () => {
  /**
   * The regression that motivated `bufferPages: true`.
   *
   * pdfkit flushes a page the moment the next one opens unless the document is
   * buffered, and `bufferedPageRange()` then reports only the page still in
   * memory. The footer loop ran once, on the last page, numbered "1 / 1" — and
   * the only existing test measured file size, which that bug does not change.
   */
  it('visits EVERY page when drawing the footer, not just the last one', async () => {
    const tracker = trackPageVisits();
    try {
      const pdf = await renderVinHistoryPdf(payload({ mileageRecords: mileage(160) }), OPTS);
      const pages = pdfPageCount(pdf);
      expect(pages).toBeGreaterThan(1);
      expect(tracker.visited()).toEqual(Array.from({ length: pages }, (_, i) => i));
    } finally {
      tracker.restore();
    }
  });

  it('paginates a long history and still terminates', async () => {
    const pdf = await renderVinHistoryPdf(payload({ mileageRecords: mileage(400) }), OPTS);
    expect(pdfPageCount(pdf)).toBeGreaterThan(3);
  });

  it('repeats the table header after a page break', async () => {
    // Not directly readable in the bytes, so this asserts the cheap proxy: a
    // long table produces more pages than a short one and never fewer.
    const short = await renderVinHistoryPdf(payload({ mileageRecords: mileage(10) }), OPTS);
    const long = await renderVinHistoryPdf(payload({ mileageRecords: mileage(120) }), OPTS);
    expect(pdfPageCount(long)).toBeGreaterThan(pdfPageCount(short));
  });
});


// ============================================================
// Contract v2
// ============================================================
//
// Same rules as above: the renderer can only testify that it produced a PDF,
// paginated it and did not throw. WHAT the v2 document says — the coverage
// notes, the verbatim brands, the vehicle and sources blocks — is asserted in
// `vin-history-report-model.spec.ts`, on data.

function coverageMap(state: VinHistorySectionCoverage): VinHistoryCoverageMap {
  const map = emptyCoverageMap();
  for (const id of Object.keys(map) as (keyof VinHistoryCoverageMap)[]) map[id] = state;
  return map;
}

function payloadV2(overrides: Partial<VinHistoryPayloadV2> = {}): VinHistoryPayloadV2 {
  const v1 = payload();
  return {
    schemaVersion: 2,
    vin: v1.vin,
    provider: 'carsxe',
    synthetic: true,
    generatedAt: v1.generatedAt,
    summary: {
      ...v1.summary,
      hasCommercialUse: true,
      hasTitleBrand: true,
      hasInsuranceTotalLoss: true,
      insuranceRecordCount: 1,
      brandCount: 2,
      serviceRecordCount: 0,
    },
    vehicle: {
      make: 'BMW',
      model: '320d',
      modelYear: 2015,
      bodyClass: 'Sedan/Saloon',
      fuelType: 'Diesel',
      plantCountry: null,
      source: 'carsxe-specs',
    },
    owners: v1.owners,
    mileageRecords: v1.mileageRecords,
    damageRecords: v1.damageRecords,
    registrations: v1.registrations,
    recalls: v1.recalls,
    theft: v1.theft,
    inspections: v1.inspections,
    insuranceRecords: [
      {
        date: '2021-09-20',
        insurer: 'Allianz',
        countryCode: 'US',
        totalLoss: true,
        reason: 'Collision — repair cost exceeds value',
        source: 'nmvtis',
      },
    ],
    brands: [
      {
        code: 'PT',
        category: 'commercial',
        label: 'Prior Taxi',
        reportedAt: '2018-02-01',
        authority: 'NY DMV',
        countryCode: 'US',
      },
      {
        code: 'FL',
        category: 'flood',
        label: 'Flood Damage',
        reportedAt: '2020-08-15',
        authority: 'TX DMV',
        countryCode: 'US',
      },
    ],
    serviceRecords: [],
    equipment: {
      standard: ['Air conditioning', 'Anti-lock braking system', 'Rain sensor'],
      exteriorColors: ['Alpine White'],
      interiorColors: [],
      warranties: [{ type: 'Basic', months: 36, distanceKm: 60_000 }],
      msrpCents: 4_512_300,
      invoiceCents: null,
      currency: 'USD',
    },
    marketValue: {
      currency: 'USD',
      retail: {
        excellentCents: 1_850_000,
        cleanCents: 1_620_000,
        averageCents: 1_410_000,
        roughCents: 1_120_000,
      },
      tradeIn: {
        excellentCents: 1_450_000,
        cleanCents: 1_260_000,
        averageCents: 1_090_000,
        roughCents: 860_000,
      },
      msrpCents: 4_512_300,
      mileageKm: 184_000,
      asOf: '2026-01-15',
    },
    coverage: { ...coverageMap('covered'), service: 'not_covered', inspections: 'unavailable' },
    sources: [
      { id: 'carsxe.history', status: 'ok', dataset: 'NMVTIS' },
      { id: 'carsxe.lienTheft', status: 'failed', dataset: 'CarsXE Lien & Theft' },
      { id: 'carsxe.recalls', status: 'skipped', dataset: 'NHTSA' },
    ],
    ...overrides,
  };
}

describe('renderVinHistoryPdf — contract v2', () => {
  it('produces a PDF from a v2 payload', async () => {
    const pdf = await renderVinHistoryPdf(payloadV2(), OPTS);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2048);
  });

  it('is deterministic for identical input', async () => {
    const [a, b] = await Promise.all([
      renderVinHistoryPdf(payloadV2(), OPTS),
      renderVinHistoryPdf(payloadV2(), OPTS),
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it('renders every supported locale, Cyrillic included', async () => {
    for (const locale of VIN_HISTORY_PDF_LOCALES) {
      const pdf = await renderVinHistoryPdf(payloadV2(), { ...OPTS, locale });
      expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    }
  });

  it('draws more than the v1 document did, which is the five new sections and two blocks', async () => {
    // Not readable in the bytes; this is the cheap proxy that the additions
    // actually reach the page rather than being built and dropped.
    const v1 = await renderVinHistoryPdf(payload(), OPTS);
    const v2 = await renderVinHistoryPdf(payloadV2(), OPTS);
    expect(v2.length).toBeGreaterThan(v1.length);
    expect(pdfPageCount(v2)).toBeGreaterThanOrEqual(pdfPageCount(v1));
  });

  it('renders a v2 report with every section empty rather than an empty file', async () => {
    // Twelve "here is why there is nothing here" notes still make a document.
    const pdf = await renderVinHistoryPdf(
      payloadV2({
        owners: [],
        mileageRecords: [],
        damageRecords: [],
        registrations: [],
        recalls: [],
        inspections: [],
        theft: {
          stolen: false,
          reportedAt: null,
          countryCode: null,
          recoveredAt: null,
          source: null,
        },
        insuranceRecords: [],
        brands: [],
        serviceRecords: [],
        equipment: null,
        marketValue: null,
      }),
      OPTS,
    );
    expect(pdfPageCount(pdf)).toBeGreaterThanOrEqual(1);
  });

  it('renders each coverage state without complaint', async () => {
    for (const state of ['covered', 'unavailable', 'not_covered'] as const) {
      const pdf = await renderVinHistoryPdf(
        payloadV2({ brands: [], insuranceRecords: [], coverage: coverageMap(state) }),
        OPTS,
      );
      expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    }
  });

  it('paginates a long v2 history and puts a footer on every page', async () => {
    const tracker = trackPageVisits();
    try {
      const pdf = await renderVinHistoryPdf(payloadV2({ mileageRecords: mileage(160) }), OPTS);
      const pages = pdfPageCount(pdf);
      expect(pages).toBeGreaterThan(1);
      expect(tracker.visited()).toEqual(Array.from({ length: pages }, (_, i) => i));
    } finally {
      tracker.restore();
    }
  });

  it('never throws on a v2 payload the renderer has not seen before', async () => {
    const broken = {
      schemaVersion: 2,
      vin: 'WAUZZZ8V8MA012345',
      provider: 'carsxe',
      synthetic: false,
      generatedAt: null,
    } as unknown as VinHistoryPayloadV2;
    const pdf = await renderVinHistoryPdf(broken, OPTS);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});
