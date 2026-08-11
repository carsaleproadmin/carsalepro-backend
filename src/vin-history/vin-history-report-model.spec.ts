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
  VIN_HISTORY_V2_SECTION_IDS,
  VinHistoryCoverageMap,
  VinHistoryPayload,
  VinHistoryPayloadV2,
  VinHistorySectionCoverage,
  VinHistorySummaryV2,
  emptyCoverageMap,
} from './vin-history-payload-v2';
import {
  VIN_HISTORY_PDF_LOCALES,
  VinHistoryPdfLocale,
  vinHistoryPdfStrings,
} from './vin-history-pdf.i18n';
import {
  NO_VALUE,
  VIN_HISTORY_REPORT_SECTION_IDS,
  VIN_HISTORY_V2_REPORT_SECTION_IDS,
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

function build(p: VinHistoryPayload = payload(), locale: VinHistoryPdfLocale = 'de') {
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


// ============================================================
// Contract v2
// ============================================================
//
// v1 payloads are frozen artefacts that buyers have already paid for, so every
// assertion above is their regression test and not one of them moved.
// Everything below is the ADDITION: the categories v1 had no field for, the two
// blocks that are not tables, and the rule that decides which of three things an
// empty section means.

const V2_SUMMARY: VinHistorySummaryV2 = {
  ...SUMMARY,
  hasCommercialUse: true,
  hasTitleBrand: true,
  hasInsuranceTotalLoss: true,
  insuranceRecordCount: 1,
  brandCount: 2,
  serviceRecordCount: 0,
};

const FULL_COVERAGE: VinHistoryCoverageMap = {
  ...emptyCoverageMap(),
  owners: 'covered',
  mileage: 'covered',
  damages: 'covered',
  registrations: 'covered',
  recalls: 'covered',
  theft: 'covered',
  inspections: 'not_covered',
  insurance: 'covered',
  brands: 'covered',
  // Permanently not covered with today's provider. See `VinHistoryServiceRecord`.
  service: 'not_covered',
  equipment: 'covered',
  marketValue: 'covered',
};

function payloadV2(overrides: Partial<VinHistoryPayloadV2> = {}): VinHistoryPayloadV2 {
  const v1 = payload();
  return {
    schemaVersion: 2,
    vin: v1.vin,
    provider: 'carsxe',
    synthetic: false,
    generatedAt: RETRIEVED_AT,
    summary: { ...V2_SUMMARY, ...(overrides.summary ?? {}) },
    vehicle: {
      make: 'BMW',
      model: '320d',
      modelYear: 2015,
      bodyClass: 'Sedan/Saloon',
      fuelType: 'Diesel',
      // The decoder did not know this one. It must be OMITTED, not printed empty.
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
      standard: ['Air conditioning', 'Anti-lock braking system'],
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
      tradeIn: null,
      msrpCents: 4_512_300,
      mileageKm: 184_000,
      asOf: '2026-01-15',
    },
    coverage: { ...FULL_COVERAGE, ...(overrides.coverage ?? {}) },
    sources: [
      { id: 'carsxe.history', status: 'ok', dataset: 'NMVTIS' },
      { id: 'carsxe.lienTheft', status: 'failed', dataset: 'CarsXE Lien & Theft' },
      { id: 'carsxe.recalls', status: 'skipped', dataset: 'NHTSA' },
      { id: 'some.registry.we.have.no.wording.for', status: 'ok', dataset: null },
    ],
    ...overrides,
  };
}

/** Nothing but the empty arrays, so only the coverage decides what each note says. */
function emptyV2Payload(coverage: VinHistorySectionCoverage): VinHistoryPayloadV2 {
  const map = VIN_HISTORY_V2_SECTION_IDS.reduce((acc, id) => {
    acc[id] = coverage;
    return acc;
  }, {} as VinHistoryCoverageMap);
  return v2WithNoRecords({ coverage: map });
}

function v2WithNoRecords(overrides: Partial<VinHistoryPayloadV2> = {}): VinHistoryPayloadV2 {
  return payloadV2({
    summary: {
      ...V2_SUMMARY,
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
      hasCommercialUse: false,
      hasTitleBrand: false,
      hasInsuranceTotalLoss: false,
      insuranceRecordCount: 0,
      brandCount: 0,
    },
    owners: [],
    mileageRecords: [],
    damageRecords: [],
    registrations: [],
    recalls: [],
    inspections: [],
    theft: { stolen: false, reportedAt: null, countryCode: null, recoveredAt: null, source: null },
    insuranceRecords: [],
    brands: [],
    serviceRecords: [],
    equipment: null,
    marketValue: null,
    ...overrides,
  });
}

describe('VIN history report model — a v1 payload is not touched by v2', () => {
  it('prints the seven v1 sections and none of the v2 ones', () => {
    const model = build(payload());
    expect(model.schemaVersion).toBe(1);
    expect(model.sections.map((s) => s.id)).toEqual([...VIN_HISTORY_REPORT_SECTION_IDS]);
  });

  it('has no vehicle block and no sources block, because v1 carries neither', () => {
    const model = build(payload());
    expect(model.vehicle).toBeNull();
    expect(model.sources).toBeNull();
  });

  it('keeps the ORIGINAL empty wording, since v1 has no coverage map', () => {
    // The load-bearing one for already-sold reports. A v1 payload has nothing to
    // say about WHY a section is empty, so it must not start claiming "we
    // checked and found none" — that is a finding nobody made.
    const s = vinHistoryPdfStrings('de');
    for (const section of build(emptyPayload()).sections) {
      expect(section.coverage).toBeNull();
      expect(section.emptyNote).toBe(s.sections[section.id].empty);
    }
  });

  it('reports zero for every v2 count and adds no v2 headline', () => {
    const model = build(payload());
    expect(model.counts.insurance).toBe(0);
    expect(model.counts.brands).toBe(0);
    expect(model.counts.service).toBe(0);
    expect(model.highlights.find((h) => h.id === 'titleBrands')).toBeUndefined();
    expect(model.highlights.find((h) => h.id === 'commercialUse')).toBeUndefined();
  });
});

describe('VIN history report model — v2 sections', () => {
  it('prints every section the contract declares, exactly once', () => {
    // Set equality against the CONTRACT, so a section added to `coverage` and
    // forgotten here cannot ship as a silently missing chapter.
    const ids = build(payloadV2()).sections.map((s) => s.id);
    expect(ids).toEqual([...VIN_HISTORY_V2_REPORT_SECTION_IDS]);
    expect([...ids].sort()).toEqual([...VIN_HISTORY_V2_SECTION_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks the document as contract v2', () => {
    expect(build(payloadV2()).schemaVersion).toBe(2);
  });

  it('gives every row exactly as many cells as its section has columns', () => {
    for (const locale of VIN_HISTORY_PDF_LOCALES) {
      for (const section of build(payloadV2(), locale).sections) {
        for (const row of section.rows) {
          expect(row.cells).toHaveLength(section.columns.length);
        }
      }
    }
  });

  it('never carries an empty note next to rows, or rows without a note', () => {
    for (const locale of VIN_HISTORY_PDF_LOCALES) {
      for (const section of build(payloadV2(), locale).sections) {
        expect(section.emptyNote === null).toBe(section.rows.length > 0);
      }
    }
  });

  it('keeps every section when a v2 provider returned nothing at all', () => {
    const model = build(emptyV2Payload('covered'));
    expect(model.sections).toHaveLength(VIN_HISTORY_V2_REPORT_SECTION_IDS.length);
    for (const section of model.sections) {
      expect(section.rows).toHaveLength(0);
      expect(section.emptyNote).toBeTruthy();
      expect(section.title).toBeTruthy();
      expect(section.columns.length).toBeGreaterThan(0);
    }
  });

  it('counts records, and does not count equipment or valuation rows as records', () => {
    // A colour list is not something that happened to the car. Counting it would
    // inflate the one number a buyer reads as "how much is known about this car".
    const model = build(payloadV2());
    const recordRows = model.sections
      .filter((s) => s.id !== 'equipment' && s.id !== 'marketValue')
      .reduce((n, s) => n + s.rows.length, 0);
    expect(model.counts.records).toBe(recordRows);
    expect(sectionOf(model, 'equipment').rows.length).toBeGreaterThan(0);
    expect(sectionOf(model, 'marketValue').rows.length).toBeGreaterThan(0);
  });
});

describe('VIN history report model — coverage decides what an empty section MEANS', () => {
  const s = vinHistoryPdfStrings('de');

  it('says "we checked and found none" when the source answered', () => {
    const section = sectionOf(build(emptyV2Payload('covered')), 'damages');
    expect(section.coverage).toBe('covered');
    expect(section.emptyNote).toBe(s.sections.damages.emptyCovered);
  });

  it('says the source could not be reached, and does not call the car clean', () => {
    const section = sectionOf(build(emptyV2Payload('unavailable')), 'damages');
    expect(section.coverage).toBe('unavailable');
    expect(section.emptyNote).toBe(s.coverageNotes.unavailable);
    expect(section.emptyNote).not.toBe(s.sections.damages.emptyCovered);
  });

  it('says the source does not hold this kind of record', () => {
    const section = sectionOf(build(emptyV2Payload('not_covered')), 'damages');
    expect(section.coverage).toBe('not_covered');
    expect(section.emptyNote).toBe(s.coverageNotes.not_covered);
  });

  it('gives the three states three different notes, in every locale', () => {
    for (const locale of VIN_HISTORY_PDF_LOCALES) {
      const notes = (['covered', 'unavailable', 'not_covered'] as const).map(
        (state) => sectionOf(build(emptyV2Payload(state), locale), 'damages').emptyNote,
      );
      expect(new Set(notes).size).toBe(3);
      for (const note of notes) expect(note).toBeTruthy();
    }
  });

  it('tells a buyer who paid for service history that the source does not have it', () => {
    // The whole point of the rule. A blank service table reads as "this car was
    // never serviced", which is a claim nobody made.
    const section = sectionOf(build(payloadV2()), 'service');
    expect(section.rows).toHaveLength(0);
    expect(section.coverage).toBe('not_covered');
    expect(section.emptyNote).toBe(s.coverageNotes.not_covered);
    expect(section.emptyNote).not.toBe(s.sections.service.empty);
  });

  it('carries all three meanings in ONE document', () => {
    const model = build(
      v2WithNoRecords({
        coverage: {
          ...FULL_COVERAGE,
          damages: 'covered',
          theft: 'unavailable',
          service: 'not_covered',
        },
      }),
    );
    expect(sectionOf(model, 'damages').emptyNote).toBe(s.sections.damages.emptyCovered);
    expect(sectionOf(model, 'theft').emptyNote).toBe(s.coverageNotes.unavailable);
    expect(sectionOf(model, 'service').emptyNote).toBe(s.coverageNotes.not_covered);
  });

  it('falls back to the neutral wording for a coverage state it does not know', () => {
    // A provider inventing a fourth state must not print a raw enum value into a
    // sentence, and must not have a claim invented for it either.
    const p = v2WithNoRecords({
      coverage: { ...FULL_COVERAGE, damages: 'partial' as never },
    });
    const section = sectionOf(build(p), 'damages');
    expect(section.coverage).toBeNull();
    expect(section.emptyNote).toBe(s.sections.damages.empty);
  });
});

describe('VIN history report model — title brands', () => {
  it("renders the provider's own wording verbatim, in every locale", () => {
    // We do not re-word a brand. The category beside it is ours; the label is
    // the record, and a disputed one has to match what the authority issued.
    for (const locale of VIN_HISTORY_PDF_LOCALES) {
      const rows = sectionOf(build(payloadV2(), locale), 'brands').rows;
      expect(rows.map((r) => r.cells[1])).toEqual(['Prior Taxi', 'Flood Damage']);
    }
  });

  it('translates the category without touching the label', () => {
    const de = sectionOf(build(payloadV2(), 'de'), 'brands').rows[0];
    const ru = sectionOf(build(payloadV2(), 'ru'), 'brands').rows[0];
    expect(de.cells[2]).toBe(vinHistoryPdfStrings('de').enums.brandCategory.commercial);
    expect(ru.cells[2]).toMatch(/[А-Яа-я]/);
    expect(de.cells[1]).toBe(ru.cells[1]);
  });

  it('flags every applied brand, and names commercial use in the note', () => {
    // Only brands the mapper found EVIDENCE for reach the payload — the raw
    // response carries the whole ~80-entry dictionary for every car — so a row
    // here is a finding, not a legend line.
    const rows = sectionOf(build(payloadV2()), 'brands').rows;
    expect(rows.every((r) => r.flagged)).toBe(true);
    expect(rows[0].notes.join(' ')).toContain(vinHistoryPdfStrings('de').notes.commercialUse);
    expect(rows[1].notes.join(' ')).not.toContain(vinHistoryPdfStrings('de').notes.commercialUse);
  });

  it("keeps the provider's code on the row so a disputed brand can be traced", () => {
    expect(sectionOf(build(payloadV2()), 'brands').rows[0].notes.join(' ')).toContain('PT');
  });

  it('headlines commercial use by name, and counts the brands', () => {
    const model = build(payloadV2());
    const commercial = model.highlights.find((h) => h.id === 'commercialUse')!;
    expect(commercial.tone).toBe('alert');
    // The client asked for taxi use by name, so the label says taxi.
    expect(commercial.label).toMatch(/taxi/i);
    expect(model.highlights.find((h) => h.id === 'titleBrands')!.value).toBe('2');
  });

  it('renders an unknown category as its raw text rather than throwing', () => {
    const p = payloadV2();
    p.brands[0].category = 'agricultural' as never;
    expect(sectionOf(build(p), 'brands').rows[0].cells[2]).toBe('agricultural');
  });

  it('never headlines "no salvage" above a written-off insurance row', () => {
    const p = payloadV2({
      summary: { ...V2_SUMMARY, hasSalvageOrTotalLoss: false },
      damageRecords: [],
    });
    expect(build(p).highlights.find((h) => h.id === 'salvage')!.tone).toBe('alert');
  });
});

describe('VIN history report model — insurance', () => {
  it('keeps insurance apart from damage rather than double-counting one crash', () => {
    const model = build(payloadV2());
    expect(sectionOf(model, 'insurance').rows).toHaveLength(1);
    expect(sectionOf(model, 'damages').rows).toHaveLength(1);
    expect(model.counts.insurance).toBe(1);
    expect(model.counts.damages).toBe(1);
  });

  it("prints the insurer's own wording for the loss and flags a write-off", () => {
    const row = sectionOf(build(payloadV2()), 'insurance').rows[0];
    expect(row.cells[4]).toBe('Collision — repair cost exceeds value');
    expect(row.flagged).toBe(true);
    expect(row.notes.join(' ')).toContain(vinHistoryPdfStrings('de').notes.insuranceTotalLoss);
    expect(build(payloadV2()).highlights.find((h) => h.id === 'insuranceTotalLoss')!.tone).toBe(
      'alert',
    );
  });
});

describe('VIN history report model — equipment and market value', () => {
  it('formats money from integer cents, through the shared formatter', () => {
    const rows = sectionOf(build(payloadV2()), 'equipment').rows;
    const msrp = rows.find((r) => r.cells[0] === vinHistoryPdfStrings('de').equipment.msrp)!;
    expect(msrp.cells[1]).toContain('45.123,00');
    expect(msrp.cells[1]).not.toContain('4512300');
  });

  it('omits a group the provider left empty instead of printing a dash', () => {
    const labels = sectionOf(build(payloadV2()), 'equipment').rows.map((r) => r.cells[0]);
    const s = vinHistoryPdfStrings('de');
    expect(labels).toContain(s.equipment.exteriorColors);
    expect(labels).not.toContain(s.equipment.interiorColors);
    expect(labels).not.toContain(s.equipment.invoice);
  });

  it('states a warranty in months and kilometres, reusing the existing units', () => {
    const s = vinHistoryPdfStrings('de');
    const row = sectionOf(build(payloadV2()), 'equipment').rows.find((r) =>
      r.cells[0].startsWith(s.equipment.warranty),
    )!;
    expect(row.cells[0]).toContain('Basic');
    expect(row.cells[1]).toContain(`36 ${s.units.months}`);
    expect(row.cells[1]).toContain(`60.000 ${s.units.km}`);
  });

  it('prints the valuation ladder and records the mileage it was computed at', () => {
    const s = vinHistoryPdfStrings('de');
    const rows = sectionOf(build(payloadV2()), 'marketValue').rows;
    expect(rows).toHaveLength(1); // retail only — this payload has no trade-in band
    expect(rows[0].cells[0]).toBe(s.marketValue.retail);
    expect(rows[0].cells[1]).toContain('18.500,00');
    // A price without the mileage it was computed at is not a fact about anything.
    expect(rows[0].notes.join(' ')).toContain('184.000');
    expect(rows[0].notes.join(' ')).toContain('15.01.2026');
  });

  it('renders an empty section when the provider published neither', () => {
    const p = payloadV2({ marketValue: null, equipment: null });
    expect(sectionOf(build(p), 'marketValue').rows).toHaveLength(0);
    expect(sectionOf(build(p), 'equipment').rows).toHaveLength(0);
  });

  it('survives a currency Intl refuses', () => {
    const p = payloadV2();
    p.marketValue!.currency = 'DOLLARS';
    expect(sectionOf(build(p), 'marketValue').rows[0].cells[1]).toContain('DOLLARS');
  });
});

describe('VIN history report model — the vehicle block', () => {
  it('opens the document with the decoded car and names the decoder', () => {
    const vehicle = build(payloadV2()).vehicle!;
    const byId = Object.fromEntries(vehicle.entries.map((e) => [e.id, e.value]));
    expect(byId.make).toBe('BMW');
    expect(byId.model).toBe('320d');
    expect(vehicle.sourceNote).toContain('carsxe-specs');
  });

  it('omits a field the decoder did not know rather than printing an empty row', () => {
    const ids = build(payloadV2()).vehicle!.entries.map((e) => e.id);
    expect(ids).toContain('fuelType');
    expect(ids).not.toContain('plantCountry');
  });

  it('writes the model year as a year, never as a formatted number', () => {
    // `formatNumber(2015)` is "2.015" in German — a year with a thousands
    // separator is a typo the reader blames on us.
    const byId = Object.fromEntries(
      build(payloadV2(), 'de').vehicle!.entries.map((e) => [e.id, e.value]),
    );
    expect(byId.modelYear).toBe('2015');
  });

  it('is null when the decoder answered nothing at all', () => {
    expect(build(payloadV2({ vehicle: null })).vehicle).toBeNull();
    expect(
      build(
        payloadV2({
          vehicle: {
            make: null,
            model: null,
            modelYear: null,
            bodyClass: null,
            fuelType: null,
            plantCountry: null,
            source: 'carsxe-specs',
          },
        }),
      ).vehicle,
    ).toBeNull();
  });

  it("labels the fields in the reader's language and keeps the values identical", () => {
    const de = build(payloadV2(), 'de').vehicle!;
    const ru = build(payloadV2(), 'ru').vehicle!;
    expect(de.title).toBe(vinHistoryPdfStrings('de').vehicle.title);
    expect(ru.entries[0].label).toMatch(/[А-Яа-я]/);
    expect(de.entries[0].value).toBe(ru.entries[0].value);
  });
});

describe('VIN history report model — the sources block', () => {
  it('names every dataset that was consulted, with its status', () => {
    const sources = build(payloadV2()).sources!;
    expect(sources.lines).toHaveLength(4);
    expect(sources.lines[0].dataset).toBe('NMVTIS');
    expect(sources.lines[0].statusLabel).toBe(vinHistoryPdfStrings('de').sources.status.ok);
  });

  it('tones a FAILED source as an alert and a skipped one as ordinary', () => {
    // A skipped source is a decision — a US-only registry is not asked about a
    // European VIN — and colouring it red teaches the reader to ignore red.
    const lines = build(payloadV2()).sources!.lines;
    expect(lines.find((l) => l.status === 'failed')!.tone).toBe('alert');
    expect(lines.find((l) => l.status === 'skipped')!.tone).toBe('neutral');
    expect(lines.find((l) => l.status === 'ok')!.tone).toBe('neutral');
  });

  it('resolves the wording per locale and passes an unknown id through', () => {
    for (const locale of VIN_HISTORY_PDF_LOCALES) {
      const lines = build(payloadV2(), locale).sources!.lines;
      expect(lines[0].label).toBe(vinHistoryPdfStrings(locale).enums.sourceId['carsxe.history']);
      // A source we have no wording for is named by its id — a missing line
      // would be worse than an untranslated one.
      expect(lines[3].label).toBe('some.registry.we.have.no.wording.for');
      expect(lines[3].dataset).toBe(NO_VALUE);
    }
  });

  it('prints its own empty note rather than vanishing', () => {
    const sources = build(payloadV2({ sources: [] })).sources!;
    expect(sources.lines).toHaveLength(0);
    expect(sources.emptyNote).toBe(vinHistoryPdfStrings('de').sources.empty);
  });
});

describe('VIN history report model — v2 localization', () => {
  it('produces the same structure in each locale', () => {
    const models = VIN_HISTORY_PDF_LOCALES.map((l) => build(payloadV2(), l));
    const shape = models.map((m) =>
      m.sections.map((s) => `${s.id}:${s.columns.length}:${s.rows.length}`).join('|'),
    );
    expect(new Set(shape).size).toBe(1);
  });

  it('translates every new section title, column and empty note in all three locales', () => {
    // Parity, not fallback. A missing key cannot happen — the dictionary is a
    // total Record — so the risk this guards is a copy-pasted English value
    // sitting inside the German document.
    const newIds: VinHistoryReportSectionId[] = [
      'insurance',
      'brands',
      'service',
      'equipment',
      'marketValue',
    ];
    for (const id of newIds) {
      const titles = VIN_HISTORY_PDF_LOCALES.map((l) => vinHistoryPdfStrings(l).sections[id].title);
      expect(new Set(titles).size).toBe(VIN_HISTORY_PDF_LOCALES.length);

      const covered = VIN_HISTORY_PDF_LOCALES.map(
        (l) => vinHistoryPdfStrings(l).sections[id].emptyCovered,
      );
      expect(new Set(covered).size).toBe(VIN_HISTORY_PDF_LOCALES.length);

      for (const locale of VIN_HISTORY_PDF_LOCALES) {
        const strings = vinHistoryPdfStrings(locale).sections[id];
        expect(strings.empty.trim().length).toBeGreaterThan(0);
        expect(strings.columns.every((c) => c.trim().length > 0)).toBe(true);
      }
    }

    const unavailable = VIN_HISTORY_PDF_LOCALES.map(
      (l) => vinHistoryPdfStrings(l).coverageNotes.unavailable,
    );
    const notCovered = VIN_HISTORY_PDF_LOCALES.map(
      (l) => vinHistoryPdfStrings(l).coverageNotes.not_covered,
    );
    expect(new Set(unavailable).size).toBe(VIN_HISTORY_PDF_LOCALES.length);
    expect(new Set(notCovered).size).toBe(VIN_HISTORY_PDF_LOCALES.length);
  });

  it('writes the new blocks in Cyrillic for ru', () => {
    const model = build(payloadV2(), 'ru');
    expect(model.vehicle!.title).toMatch(/[А-Яа-я]/);
    expect(model.sources!.title).toMatch(/[А-Яа-я]/);
    expect(sectionOf(model, 'brands').title).toMatch(/[А-Яа-я]/);
    expect(sectionOf(model, 'service').emptyNote).toMatch(/[А-Яа-я]/);
  });
});

describe('VIN history report model — v2 robustness', () => {
  it('does not throw on a v2 payload missing every array', () => {
    const broken = {
      schemaVersion: 2,
      vin: 'WAUZZZ8V8MA012345',
      provider: 'carsxe',
      synthetic: false,
      generatedAt: RETRIEVED_AT,
    } as unknown as VinHistoryPayloadV2;

    const model = buildVinHistoryReportModel(broken, { locale: 'en' });
    expect(model.schemaVersion).toBe(2);
    expect(model.sections).toHaveLength(VIN_HISTORY_V2_REPORT_SECTION_IDS.length);
    expect(model.counts.records).toBe(0);
    expect(model.vehicle).toBeNull();
    expect(model.sources!.lines).toHaveLength(0);
  });

  it('does not throw on nulls where objects are expected', () => {
    const broken = payloadV2({
      vehicle: null as never,
      equipment: null as never,
      marketValue: null as never,
      coverage: null as never,
      sources: null as never,
      brands: null as never,
    });
    expect(() => buildVinHistoryReportModel(broken, { locale: 'de' })).not.toThrow();
  });

  it('survives a source entry with nothing usable on it', () => {
    const p = payloadV2({ sources: [{ id: '', status: 'weird' as never, dataset: '   ' }] });
    const line = build(p).sources!.lines[0];
    expect(line.dataset).toBe(NO_VALUE);
    expect(line.statusLabel).toBe('weird');
    expect(line.tone).toBe('neutral');
  });
});
