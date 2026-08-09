// Category: DOCUMENT CONTENT. Pure — no DB, no R2, no Nest container, no pdfkit.
//
// This is where the VIN history document is actually tested. The PDF layer can
// only be checked for "is a PDF and has N pages" — embedded subset fonts make
// its text unreadable without a parser — so every rule that matters to a buyer
// is asserted here, on the model the renderer draws.
import {
  VinHistoryPayloadV1,
  VinHistorySummary,
} from './vin-history-payload-v1';
import {
  VIN_HISTORY_PDF_LOCALES,
  VinHistoryPdfLocale,
  vinHistoryPdfStrings,
} from './vin-history-pdf.i18n';
import {
  NO_VALUE,
  VIN_HISTORY_REPORT_SECTION_IDS,
  VinHistoryReportSectionId,
  buildVinHistoryReportModel,
  formatCents,
  formatIsoDate,
  monthsBetween,
  normalizeOwnerPeriods,
} from './vin-history-report-model';

const RETRIEVED_AT = '2026-02-01T00:00:00.000Z';
const RENDERED_AT = new Date('2026-02-05T10:30:00.000Z');
const PURCHASED_AT = new Date('2026-02-04T08:15:00.000Z');

const SUMMARY: VinHistorySummary = {
  recordCount: 9,
  ownersCount: 2,
  countriesSeen: ['DE'],
  hasAccidentRecords: true,
  hasSalvageOrTotalLoss: false,
  hasOdometerRollback: true,
  hasStolenRecord: false,
  hasOpenRecalls: true,
  lastRecordedMileageKm: 184000,
  firstRegistration: '2015-06-12',
};

function payload(overrides: Partial<VinHistoryPayloadV1> = {}): VinHistoryPayloadV1 {
  return {
    schemaVersion: 1,
    vin: 'WAUZZZ8V8MA012345',
    provider: 'mock',
    synthetic: true,
    generatedAt: RETRIEVED_AT,
    summary: { ...SUMMARY, ...(overrides.summary ?? {}) },
    owners: [
      {
        sequence: 1,
        type: 'private',
        countryCode: 'DE',
        fromDate: '2015-06-12',
        // Overlaps owner 2 by half a year, and the provider's own duration is
        // wrong for it either way.
        toDate: '2019-12-31',
        durationMonths: 12,
      },
      {
        sequence: 2,
        type: 'lease',
        countryCode: 'DE',
        fromDate: '2019-03-01',
        toDate: null,
        durationMonths: 12,
      },
    ],
    mileageRecords: [
      {
        date: '2018-05-04',
        mileageKm: 62000,
        source: 'inspection',
        countryCode: 'DE',
        suspicious: false,
      },
      {
        date: '2020-05-04',
        mileageKm: 41000,
        source: 'service',
        countryCode: 'DE',
        suspicious: true,
      },
      {
        date: '2024-05-04',
        mileageKm: 184000,
        source: 'registration',
        countryCode: 'DE',
        suspicious: false,
      },
    ],
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
        lastRegistration: '2020-01-15',
        plateMasked: 'DE-****42',
        status: 'deregistered',
      },
      {
        countryCode: 'DE',
        region: 'Hessen',
        firstRegistration: '2020-02-01',
        lastRegistration: null,
        plateMasked: 'DE-****77',
        status: 'active',
      },
    ],
    recalls: [
      {
        reference: 'RC-2019-4711',
        issuedAt: '2019-04-01',
        authority: 'KBA',
        title: 'Airbag inflator replacement',
        description: null,
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

function emptyPayload(): VinHistoryPayloadV1 {
  return payload({
    owners: [],
    mileageRecords: [],
    damageRecords: [],
    registrations: [],
    recalls: [],
    inspections: [],
    theft: { stolen: false, reportedAt: null, countryCode: null, recoveredAt: null, source: null },
    summary: {
      ...SUMMARY,
      recordCount: 0,
      ownersCount: 0,
      countriesSeen: [],
      hasAccidentRecords: false,
      hasSalvageOrTotalLoss: false,
      hasOdometerRollback: false,
      hasStolenRecord: false,
      hasOpenRecalls: false,
      lastRecordedMileageKm: null,
      firstRegistration: null,
    },
  });
}

function build(p = payload(), locale: VinHistoryPdfLocale = 'de') {
  return buildVinHistoryReportModel(p, {
    locale,
    purchaseId: 'ckqz2zk5e0000a8b8h4t8j2z3',
    purchasedAt: PURCHASED_AT,
    renderedAt: RENDERED_AT,
  });
}

function sectionOf(model: ReturnType<typeof build>, id: VinHistoryReportSectionId) {
  const found = model.sections.find((s) => s.id === id);
  if (!found) throw new Error(`section ${id} missing`);
  return found;
}

describe('VIN history report model — sections', () => {
  it('always contains all seven sections, in a fixed order', () => {
    expect(build().sections.map((s) => s.id)).toEqual([...VIN_HISTORY_REPORT_SECTION_IDS]);
  });

  it('keeps every section when the provider returned nothing at all', () => {
    // The load-bearing one. "No accident records" and "we hold no accident
    // data" are different claims to a buyer, and a section that quietly
    // disappears makes the second read as the first.
    const model = build(emptyPayload());
    expect(model.sections).toHaveLength(VIN_HISTORY_REPORT_SECTION_IDS.length);
    for (const section of model.sections) {
      expect(section.rows).toHaveLength(0);
      expect(section.emptyNote).toBeTruthy();
      expect(section.title).toBeTruthy();
      expect(section.columns.length).toBeGreaterThan(0);
    }
  });

  it('never carries an empty note next to rows, or rows without a note', () => {
    for (const locale of VIN_HISTORY_PDF_LOCALES) {
      for (const section of build(payload(), locale).sections) {
        expect(section.emptyNote === null).toBe(section.rows.length > 0);
      }
    }
  });

  it('gives every row exactly as many cells as its section has columns', () => {
    // A drifted column count is a document with a value under the wrong
    // heading — silent, and worse than a crash.
    for (const locale of VIN_HISTORY_PDF_LOCALES) {
      for (const section of build(payload(), locale).sections) {
        for (const row of section.rows) {
          expect(row.cells).toHaveLength(section.columns.length);
        }
      }
    }
  });
});

describe('VIN history report model — money', () => {
  it('formats integer cents through Intl, never as raw cents', () => {
    const cell = sectionOf(build(), 'damages').rows[0].cells[3];
    expect(cell).toContain('12.345'); // 1 234 500 cents = 12 345,00 EUR
    expect(cell).toContain('€');
    expect(cell).not.toContain('1234500');
  });

  it('follows the locale for separators', () => {
    expect(formatCents(1_234_500, 'EUR', 'de')).toContain('12.345,00');
    expect(formatCents(1_234_500, 'EUR', 'en')).toContain('12,345.00');
  });

  it('renders a missing amount as the placeholder rather than 0', () => {
    // "0 €" is a claim that the repair was free.
    expect(formatCents(null, 'EUR', 'de')).toBe(NO_VALUE);
    expect(formatCents(undefined, null, 'en')).toBe(NO_VALUE);
  });

  it('survives a currency Intl refuses', () => {
    // A provider sending a bad code must not turn a paid download into a 500.
    const value = formatCents(1000, 'EURO', 'en');
    expect(value).toContain('10');
    expect(value).toContain('EURO');
  });
});

describe('VIN history report model — dates', () => {
  it('renders a null date as the placeholder', () => {
    expect(formatIsoDate(null, 'de')).toBe(NO_VALUE);
    expect(formatIsoDate('', 'en')).toBe(NO_VALUE);
    // …and in a real row: the second registration has no last-registration date.
    expect(sectionOf(build(), 'registrations').rows[1].cells[3]).toBe(NO_VALUE);
  });

  it('writes dates the way the locale does', () => {
    expect(formatIsoDate('2019-04-01', 'de')).toBe('01.04.2019');
    expect(formatIsoDate('2019-04-01', 'ru')).toBe('01.04.2019');
    expect(formatIsoDate('2019-04-01', 'en')).toBe('2019-04-01');
  });

  it('passes an unparsable date through instead of throwing or printing Invalid Date', () => {
    expect(formatIsoDate('sometime in 2019', 'de')).toBe('sometime in 2019');
  });

  it('states ONE retrieval date, separate from the purchase and render dates', () => {
    const model = build();
    const s = vinHistoryPdfStrings('de');
    const labels = model.meta.map((m) => m.label);
    expect(labels.filter((l) => l === s.meta.retrievedAt)).toHaveLength(1);

    const byId = Object.fromEntries(model.meta.map((m) => [m.id, m.value]));
    expect(byId.retrievedAt).toBe('2026-02-01 00:00 UTC');
    expect(byId.purchasedAt).toBe('2026-02-04 08:15 UTC');
    expect(byId.renderedAt).toBe('2026-02-05 10:30 UTC');
    // Three different facts, three different values — the audit found two of
    // them printed as if they were both "when the data was pulled".
    expect(new Set([byId.retrievedAt, byId.purchasedAt, byId.renderedAt]).size).toBe(3);
  });
});

describe('VIN history report model — enums', () => {
  it('translates the values it knows', () => {
    const de = sectionOf(build(payload(), 'de'), 'owners').rows[0].cells[1];
    const ru = sectionOf(build(payload(), 'ru'), 'owners').rows[0].cells[1];
    expect(de).toBe('Privat');
    expect(ru).toBe('Частное лицо');
  });

  it('passes an unknown value through as text rather than throwing', () => {
    // A provider adding a category must not break a download someone paid for.
    const p = payload();
    p.damageRecords[0].severity = 'flood' as never;
    p.inspections[0].result = 'referred' as never;
    p.owners[0].type = 'diplomatic' as never;

    const model = build(p);
    expect(sectionOf(model, 'damages').rows[0].cells[1]).toBe('flood');
    expect(sectionOf(model, 'inspections').rows[0].cells[2]).toBe('referred');
    expect(sectionOf(model, 'owners').rows[0].cells[1]).toBe('diplomatic');
  });
});

describe('VIN history report model — mileage', () => {
  it('marks a suspicious reading as suspicious', () => {
    const rows = sectionOf(build(), 'mileage').rows;
    const flagged = rows.filter((r) => r.flagged);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].cells[0]).toBe('04.05.2020');
    expect(flagged[0].notes.join(' ')).toContain(vinHistoryPdfStrings('de').notes.suspiciousMileage);
    expect(rows[0].flagged).toBe(false);
  });

  it('orders readings oldest first and formats them with a thousands separator', () => {
    const rows = sectionOf(build(), 'mileage').rows;
    expect(rows.map((r) => r.cells[0])).toEqual(['04.05.2018', '04.05.2020', '04.05.2024']);
    expect(rows[2].cells[1]).toBe('184.000 km');
  });

  it('agrees with the headline about the last reading', () => {
    const model = build();
    const last = sectionOf(model, 'mileage').rows.at(-1)!.cells[1];
    expect(model.highlights.find((h) => h.id === 'lastMileage')!.value).toBe(last);
  });
});

describe('VIN history report model — ownership periods', () => {
  it('computes the duration from its own dates, not from the provider field', () => {
    // The fixture claims durationMonths: 12 for a period of 2015-06-12 →
    // (adjusted) 2019-03-01. A 9-month span labelled "12 months" is exactly the
    // defect this rule exists for.
    const periods = normalizeOwnerPeriods(
      [
        {
          sequence: 1,
          type: 'private',
          countryCode: 'DE',
          fromDate: '2019-03-01',
          toDate: '2019-12-01',
          durationMonths: 12,
        },
      ],
      '2026-02-01',
    );
    expect(periods[0].durationMonths).toBe(9);
    expect(monthsBetween('2019-03-01', '2019-12-01')).toBe(9);
  });

  it('closes an overlapping period where the next one starts, and says so', () => {
    const rows = sectionOf(build(), 'owners').rows;
    // Owner 1 claimed to hold the car until 2019-12-31 while owner 2 already
    // had it from 2019-03-01. Two owners of one car at one time is impossible.
    expect(rows[0].cells[4]).toBe('01.03.2019');
    expect(rows[0].notes.join(' ')).toContain(
      vinHistoryPdfStrings('de').notes.overlapAdjusted,
    );
    // Moving a stated date silently would be worse than the overlap.
    expect(rows[1].notes).toHaveLength(0);
  });

  it('leaves non-overlapping periods exactly as recorded', () => {
    const periods = normalizeOwnerPeriods(
      [
        { sequence: 1, type: 'private', countryCode: 'DE', fromDate: '2015-01-01', toDate: '2018-01-01', durationMonths: null },
        { sequence: 2, type: 'company', countryCode: 'DE', fromDate: '2019-01-01', toDate: null, durationMonths: null },
      ],
      '2026-02-01',
    );
    expect(periods[0].to).toBe('2018-01-01');
    expect(periods[0].adjusted).toBe(false);
    expect(periods[0].durationMonths).toBe(36);
  });

  it('measures an open final period to the retrieval date and labels it as open', () => {
    const model = build();
    const last = sectionOf(model, 'owners').rows.at(-1)!;
    expect(last.cells[4]).toBe(vinHistoryPdfStrings('de').values.present);
    // 2019-03-01 → 2026-02-01 is 83 months.
    expect(last.cells[5]).toBe('83 Monate');
  });

  it('orders owners by sequence even when the provider does not', () => {
    const p = payload();
    p.owners = [p.owners[1], p.owners[0]];
    expect(sectionOf(build(p), 'owners').rows.map((r) => r.cells[0])).toEqual(['1', '2']);
  });
});

describe('VIN history report model — countries', () => {
  it('separates the country LIST from the country COUNT', () => {
    // `countries` used to mean a code in one place and a count in another, and
    // `registrationCount` was fed the number of countries.
    const model = build();
    expect(model.countryCodes).toEqual(['DE']);
    expect(model.counts.countryCount).toBe(1);
    // Two registrations in ONE country: the two numbers are not the same fact.
    expect(model.counts.registrations).toBe(2);
    expect(model.counts.countryCount).not.toBe(model.counts.registrations);
  });

  it('collects every country the document mentions, once each', () => {
    const p = payload();
    p.registrations[1].countryCode = 'PL';
    p.summary.countriesSeen = ['DE', 'PL'];
    const model = build(p);
    expect(model.countryCodes).toEqual(['DE', 'PL']);
    expect(model.counts.countryCount).toBe(2);
  });
});

describe('VIN history report model — headline', () => {
  it('counts the records the document actually contains', () => {
    const model = build();
    const printed = model.sections.reduce((n, s) => n + s.rows.length, 0);
    expect(model.counts.records).toBe(printed);
    expect(model.highlights.find((h) => h.id === 'records')!.value).toBe(String(printed));
  });

  it('keeps the provider count for reconciliation without printing it as a second headline', () => {
    const model = build();
    expect(model.providerRecordCount).toBe(SUMMARY.recordCount);
  });

  it('never headlines "no damage" above a printed damage row', () => {
    const p = payload();
    p.summary.hasAccidentRecords = false; // provider summary disagrees with itself
    const model = build(p);
    const accidents = model.highlights.find((h) => h.id === 'accidents')!;
    expect(accidents.tone).toBe('alert');
    expect(accidents.value).not.toBe(vinHistoryPdfStrings('de').values.no);
  });

  it('keeps a provider claim that the arrays do not detail', () => {
    // A tier that withholds the detail still says the records exist; dropping
    // the claim would be worse than showing it without rows.
    const p = emptyPayload();
    p.summary.hasStolenRecord = true;
    const model = build(p);
    expect(model.highlights.find((h) => h.id === 'stolen')!.tone).toBe('alert');
    expect(sectionOf(model, 'theft').rows).toHaveLength(0);
  });

  it('flags rollback, open recalls and salvage from the rows themselves', () => {
    const p = payload();
    p.damageRecords[0].severity = 'total_loss';
    const model = build(p);
    const tone = (id: string) => model.highlights.find((h) => h.id === id)!.tone;
    expect(tone('rollback')).toBe('alert');
    expect(tone('openRecalls')).toBe('alert');
    expect(tone('salvage')).toBe('alert');
    expect(sectionOf(model, 'damages').rows[0].flagged).toBe(true);
  });
});

describe('VIN history report model — theft', () => {
  it('prints a clean answer from a registry that answered', () => {
    const section = sectionOf(build(), 'theft');
    expect(section.rows).toHaveLength(1);
    expect(section.rows[0].cells[0]).toBe(vinHistoryPdfStrings('de').values.notStolen);
    expect(section.rows[0].flagged).toBe(false);
  });

  it('prints the empty note when no registry answered at all', () => {
    // "Not stolen" and "nobody checked" are different answers.
    const p = payload();
    p.theft = { stolen: false, reportedAt: null, countryCode: null, recoveredAt: null, source: null };
    const section = sectionOf(build(p), 'theft');
    expect(section.rows).toHaveLength(0);
    expect(section.emptyNote).toBeTruthy();
  });

  it('flags a stolen record', () => {
    const p = payload();
    p.theft = {
      stolen: true,
      reportedAt: '2022-07-01',
      countryCode: 'PL',
      recoveredAt: null,
      source: 'police_registry',
    };
    const row = sectionOf(build(p), 'theft').rows[0];
    expect(row.flagged).toBe(true);
    expect(row.cells[1]).toBe('01.07.2022');
    expect(row.cells[3]).toBe(vinHistoryPdfStrings('de').values.notRecovered);
  });
});

describe('VIN history report model — synthetic data', () => {
  it('carries the warning frame AND the per-page footer text when the data is generated', () => {
    const model = build();
    expect(model.synthetic).toBe(true);
    expect(model.syntheticWarning).not.toBeNull();
    expect(model.syntheticWarning!.badge).toBeTruthy();
    expect(model.syntheticWarning!.body).toBeTruthy();
    expect(model.syntheticWarning!.footer).toBeTruthy();
  });

  it('carries no warning for real data', () => {
    expect(build(payload({ synthetic: false })).syntheticWarning).toBeNull();
  });

  it('warns in every locale', () => {
    for (const locale of VIN_HISTORY_PDF_LOCALES) {
      expect(build(payload(), locale).syntheticWarning!.footer).toBeTruthy();
    }
  });
});

describe('VIN history report model — localization', () => {
  it('produces the same structure and different words in each locale', () => {
    const models = VIN_HISTORY_PDF_LOCALES.map((l) => build(payload(), l));
    const shape = models.map((m) =>
      m.sections.map((s) => `${s.id}:${s.columns.length}:${s.rows.length}`).join('|'),
    );
    expect(new Set(shape).size).toBe(1);
    expect(new Set(models.map((m) => m.title)).size).toBe(models.length);
  });

  it('falls back to the platform default for an unsupported tag, and honours a regional one', () => {
    expect(buildVinHistoryReportModel(payload(), { locale: 'fr' }).locale).toBe('de');
    expect(buildVinHistoryReportModel(payload(), { locale: null }).locale).toBe('de');
    expect(buildVinHistoryReportModel(payload(), { locale: 'ru-RU' }).locale).toBe('ru');
    expect(buildVinHistoryReportModel(payload(), { locale: 'en-US' }).locale).toBe('en');
  });

  it('writes Cyrillic labels for ru', () => {
    expect(build(payload(), 'ru').sections[0].title).toMatch(/[А-Яа-я]/);
  });
});

describe('VIN history report model — robustness', () => {
  it('does not throw on a payload missing every array', () => {
    // Payloads come back out of a JSON column. A shape the renderer cannot
    // survive would take the buyer's download with it.
    const broken = {
      schemaVersion: 1,
      vin: 'WAUZZZ8V8MA012345',
      provider: 'mock',
      synthetic: false,
      generatedAt: RETRIEVED_AT,
    } as unknown as VinHistoryPayloadV1;

    const model = buildVinHistoryReportModel(broken, { locale: 'en' });
    expect(model.sections).toHaveLength(VIN_HISTORY_REPORT_SECTION_IDS.length);
    expect(model.counts.records).toBe(0);
    expect(model.highlights.length).toBeGreaterThan(0);
  });

  it('does not throw on nulls where objects are expected', () => {
    const broken = payload({
      theft: null as never,
      summary: null as never,
      owners: null as never,
      generatedAt: null as never,
    });
    expect(() => buildVinHistoryReportModel(broken, { locale: 'de' })).not.toThrow();
  });

  it('renders an empty document with a placeholder in every headline slot', () => {
    const model = build(emptyPayload());
    expect(model.highlights.find((h) => h.id === 'lastMileage')!.value).toBe(NO_VALUE);
    expect(model.highlights.find((h) => h.id === 'firstRegistration')!.value).toBe(NO_VALUE);
    expect(model.highlights.find((h) => h.id === 'countries')!.value).toBe(NO_VALUE);
  });
});
