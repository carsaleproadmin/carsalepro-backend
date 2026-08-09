// Category: DOCUMENT RENDERING. Pure — no DB, no R2, no Nest container.
//
// Only the things a rendered PDF can actually testify to live here: it is a
// PDF, it paginates, every page gets a footer, and no input makes it throw.
// What the document SAYS is asserted in `vin-history-report-model.spec.ts`,
// which is the layer that can be read.
import { pdfFontsAvailable } from '../legal/pdf-fonts';
import { pdfPageCount, trackPageVisits } from '../../test/helpers/pdf-inspect';
import { VinHistoryPayloadV1, VinHistoryMileageRecord } from './vin-history-payload-v1';
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
