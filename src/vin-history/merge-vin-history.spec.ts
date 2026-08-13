// Category: PURE MERGE. No DB, no R2, no network, no Nest container, no clock.
/**
 * What a merged VIN history report is allowed to claim.
 *
 * Every case here is a way of over-claiming that merging makes easy: a doubled
 * count, a blended valuation, a rollback that disappears between two sources,
 * a theft register nobody searched, a generated record sold as a sourced one.
 * The merge is pure, so all of it is asserted on plain objects.
 */

import {
  VinHistoryMileageRecord,
  VinHistoryPayloadV1,
  VinHistoryRecall,
  VinHistoryTheft,
} from './vin-history-payload-v1';
import {
  VinHistoryCoverageMap,
  VinHistoryMarketValue,
  VinHistoryPayloadV2,
  VinHistorySource,
  VIN_HISTORY_V2_SECTION_IDS,
  emptyCoverageMap,
} from './vin-history-payload-v2';
import { mergeVinHistoryPayloads, VinHistoryMergeMember } from './merge-vin-history';

const VIN = 'WBAFR7C57CC811956';
const AT = '2026-08-12T10:00:00.000Z';

const NO_THEFT: VinHistoryTheft = {
  stolen: false,
  reportedAt: null,
  countryCode: null,
  recoveredAt: null,
  source: null,
};

function mileage(
  date: string,
  mileageKm: number,
  overrides: Partial<VinHistoryMileageRecord> = {},
): VinHistoryMileageRecord {
  return {
    date,
    mileageKm,
    source: 'registration',
    countryCode: 'US',
    suspicious: false,
    ...overrides,
  };
}

function recall(reference: string, open = true): VinHistoryRecall {
  return {
    reference,
    issuedAt: '2019-04-01',
    authority: 'NHTSA',
    title: `Campaign ${reference}`,
    description: null,
    open,
  };
}

function value(overrides: Partial<VinHistoryMarketValue> = {}): VinHistoryMarketValue {
  return {
    currency: 'USD',
    retail: null,
    tradeIn: null,
    msrpCents: null,
    mileageKm: null,
    asOf: null,
    ...overrides,
  };
}

/** A v2 payload with everything empty, so each test states only what it is about. */
function v2(overrides: Partial<VinHistoryPayloadV2> = {}): VinHistoryPayloadV2 {
  return {
    schemaVersion: 2,
    vin: VIN,
    provider: 'member',
    synthetic: false,
    generatedAt: '2026-08-01T00:00:00.000Z',
    summary: {
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
      serviceRecordCount: 0,
    },
    vehicle: null,
    owners: [],
    mileageRecords: [],
    damageRecords: [],
    registrations: [],
    recalls: [],
    theft: { ...NO_THEFT },
    inspections: [],
    insuranceRecords: [],
    brands: [],
    serviceRecords: [],
    equipment: null,
    marketValue: null,
    coverage: emptyCoverageMap(),
    sources: [],
    ...overrides,
  };
}

/** A v1 payload — what the mock still emits, and what every sold row holds. */
function v1(overrides: Partial<VinHistoryPayloadV1> = {}): VinHistoryPayloadV1 {
  return {
    schemaVersion: 1,
    vin: VIN,
    provider: 'legacy',
    synthetic: false,
    generatedAt: '2026-07-01T00:00:00.000Z',
    summary: {
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
    owners: [],
    mileageRecords: [],
    damageRecords: [],
    registrations: [],
    recalls: [],
    theft: { ...NO_THEFT },
    inspections: [],
    ...overrides,
  };
}

function coverage(overrides: Partial<VinHistoryCoverageMap>): VinHistoryCoverageMap {
  return { ...emptyCoverageMap(), ...overrides };
}

function ok(name: string, payload: VinHistoryPayloadV1 | VinHistoryPayloadV2): VinHistoryMergeMember {
  return { name, payload, failed: false };
}

function broken(name: string): VinHistoryMergeMember {
  return { name, payload: null, failed: true };
}

function merge(...members: VinHistoryMergeMember[]): VinHistoryPayloadV2 {
  return mergeVinHistoryPayloads({ vin: VIN, provider: 'aggregate', generatedAt: AT, members });
}

/**
 * The invariant behind `summary`: every count IS its array's length and every
 * boolean IS a predicate over the arrays beside it. Asserted on every merge,
 * because the tempting shortcut — copying or adding the members' own summaries —
 * passes any single-field test and breaks exactly this.
 */
function expectSummaryDerivable(payload: VinHistoryPayloadV2): void {
  const s = payload.summary;

  expect(s.ownersCount).toBe(payload.owners.length);
  expect(s.insuranceRecordCount).toBe(payload.insuranceRecords.length);
  expect(s.brandCount).toBe(payload.brands.length);
  expect(s.serviceRecordCount).toBe(payload.serviceRecords.length);
  expect(s.recordCount).toBe(
    payload.owners.length +
      payload.mileageRecords.length +
      payload.damageRecords.length +
      payload.registrations.length +
      payload.recalls.length +
      payload.inspections.length +
      payload.insuranceRecords.length +
      payload.brands.length +
      payload.serviceRecords.length +
      (payload.theft.stolen ? 1 : 0),
  );

  expect(s.hasAccidentRecords).toBe(payload.damageRecords.length > 0);
  expect(s.hasOdometerRollback).toBe(payload.mileageRecords.some((m) => m.suspicious));
  expect(s.hasStolenRecord).toBe(payload.theft.stolen);
  expect(s.hasOpenRecalls).toBe(payload.recalls.some((r) => r.open));
  expect(s.hasTitleBrand).toBe(payload.brands.length > 0);
  expect(s.hasCommercialUse).toBe(payload.brands.some((b) => b.category === 'commercial'));
  expect(s.hasInsuranceTotalLoss).toBe(payload.insuranceRecords.some((i) => i.totalLoss));
  expect(s.lastRecordedMileageKm).toBe(
    payload.mileageRecords.length > 0
      ? payload.mileageRecords[payload.mileageRecords.length - 1].mileageKm
      : null,
  );
}

describe('mergeVinHistoryPayloads — identity', () => {
  it('stamps the composite, not a member, and never invents a timestamp', () => {
    const merged = merge(ok('carsxe', v2({ provider: 'carsxe', generatedAt: 'ignored' })));

    expect(merged.schemaVersion).toBe(2);
    expect(merged.vin).toBe(VIN);
    // ⚠️ `provider` is half of the (vin, provider) cache key and is stamped on
    // every purchase and R2 key. It must be the composite's name, always.
    expect(merged.provider).toBe('aggregate');
    expect(merged.generatedAt).toBe(AT);
  });

  it('normalises the VIN it was handed', () => {
    const merged = mergeVinHistoryPayloads({
      vin: VIN.toLowerCase(),
      provider: 'aggregate',
      generatedAt: AT,
      members: [ok('a', v2())],
    });
    expect(merged.vin).toBe(VIN);
  });
});

describe('mergeVinHistoryPayloads — mileage', () => {
  it('interleaves two members into ONE chronological ladder', () => {
    const merged = merge(
      ok('a', v2({ mileageRecords: [mileage('2019-03-01', 40_000), mileage('2023-06-01', 120_000)] })),
      ok('b', v2({ mileageRecords: [mileage('2021-05-01', 80_000)] })),
    );

    expect(merged.mileageRecords.map((m) => m.date)).toEqual([
      '2019-03-01',
      '2021-05-01',
      '2023-06-01',
    ]);
    expect(merged.summary.lastRecordedMileageKm).toBe(120_000);
    expectSummaryDerivable(merged);
  });

  it('drops a reading only when the date AND the value both repeat', () => {
    /*
     * Two sources routinely relay the same registration reading; that is one
     * fact, not two, and counting it twice inflates `recordCount`. Two DIFFERENT
     * readings on one day is the opposite — it is the evidence of tampering, and
     * collapsing on the date alone would delete the finding.
     */
    const merged = merge(
      ok('a', v2({ mileageRecords: [mileage('2021-05-01', 80_000)] })),
      ok('b', v2({
        mileageRecords: [mileage('2021-05-01', 80_000), mileage('2021-05-01', 60_000)],
      })),
    );

    expect(merged.mileageRecords).toHaveLength(2);
    expect(merged.mileageRecords.map((m) => m.mileageKm)).toEqual([80_000, 60_000]);
    expectSummaryDerivable(merged);
  });

  it('finds the rollback that is invisible to either source alone', () => {
    /*
     * ⚠️ THE LOAD-BEARING CASE. Source A holds one reading, source B holds one
     * reading, and neither has anything to compare against — both say
     * `suspicious: false` and both are right about their own series. Interleaved,
     * the September reading is 30 000 km below the March one. Carrying the
     * members' flags across instead of recomputing hands the buyer a clean
     * odometer on a rolled-back car.
     */
    const merged = merge(
      ok('a', v2({ mileageRecords: [mileage('2022-03-01', 120_000)] })),
      ok('b', v2({ mileageRecords: [mileage('2022-09-01', 90_000)] })),
    );

    expect(merged.mileageRecords.map((m) => m.suspicious)).toEqual([false, true]);
    expect(merged.summary.hasOdometerRollback).toBe(true);
    expectSummaryDerivable(merged);
  });

  it('CLEARS a member flag the merged order disproves', () => {
    // The other direction, and it matters just as much: member B saw 90 000 after
    // its own 110 000 and flagged it. Merged, an earlier 80 000 reading from A
    // makes the two later readings an ordinary rising ladder… except the 90 000
    // still follows 110 000, so only a reading the merged series exonerates is
    // cleared. Here A's single low-then-high pair is flagged by nothing.
    const merged = merge(
      ok('a', v2({ mileageRecords: [mileage('2020-01-01', 50_000, { suspicious: true })] })),
      ok('b', v2({ mileageRecords: [mileage('2021-01-01', 60_000, { suspicious: true })] })),
    );

    expect(merged.mileageRecords.map((m) => m.suspicious)).toEqual([false, false]);
    expect(merged.summary.hasOdometerRollback).toBe(false);
  });

  it('keeps each reading’s own source and country', () => {
    const merged = merge(
      ok('a', v2({ mileageRecords: [mileage('2019-03-01', 40_000, { source: 'auction', countryCode: 'US' })] })),
      ok('b', v2({ mileageRecords: [mileage('2021-05-01', 80_000, { source: 'inspection', countryCode: 'DE' })] })),
    );

    expect(merged.mileageRecords.map((m) => [m.source, m.countryCode])).toEqual([
      ['auction', 'US'],
      ['inspection', 'DE'],
    ]);
  });
});

describe('mergeVinHistoryPayloads — recalls', () => {
  it('takes the FIRST member that has any, and does not concatenate', () => {
    /*
     * Both sources relay the same authority, so the same campaign arriving twice
     * is one recall reported twice — with no reliable key to match on. Merging
     * them shows "4 open recalls" on a car with two, on the section a buyer acts
     * on most directly.
     */
    const merged = merge(
      ok('a', v2({ recalls: [recall('19V-001'), recall('19V-002')], coverage: coverage({ recalls: 'covered' }) })),
      ok('b', v2({ recalls: [recall('19V-001-B'), recall('19V-002-B')], coverage: coverage({ recalls: 'covered' }) })),
    );

    expect(merged.recalls.map((r) => r.reference)).toEqual(['19V-001', '19V-002']);
    expect(merged.coverage.recalls).toBe('covered');
    expectSummaryDerivable(merged);
  });

  it('takes the coverage of the member whose recalls it took', () => {
    // Member A never queried recalls and holds none; member B did and holds two.
    // The section describes B's query, because the list is B's.
    const merged = merge(
      ok('a', v2({ coverage: coverage({ recalls: 'not_covered' }) })),
      ok('b', v2({ recalls: [recall('19V-100')], coverage: coverage({ recalls: 'covered' }) })),
    );

    expect(merged.recalls).toHaveLength(1);
    expect(merged.coverage.recalls).toBe('covered');
  });

  it('keeps "checked and clean" when nobody supplied a recall', () => {
    // No member to take coverage from, so best evidence decides — and a member
    // that searched the recall database and found nothing must not be downgraded
    // to "nobody searched".
    const merged = merge(
      ok('a', v2({ coverage: coverage({ recalls: 'not_covered' }) })),
      ok('b', v2({ coverage: coverage({ recalls: 'covered' }) })),
    );

    expect(merged.recalls).toEqual([]);
    expect(merged.coverage.recalls).toBe('covered');
  });
});

describe('mergeVinHistoryPayloads — valuations', () => {
  it('lists every valuation and blends none of them', () => {
    const a = value({ currency: 'USD', msrpCents: 4_500_000 });
    const b = value({ currency: 'EUR', msrpCents: 3_900_000 });

    const merged = merge(ok('a', v2({ marketValue: a })), ok('b', v2({ marketValue: b })));

    expect(merged.marketValues).toEqual([a, b]);
    // The older field keeps the FIRST valuation verbatim, for every reader
    // written before `marketValues[]` existed.
    expect(merged.marketValue).toEqual(a);
    // No average anywhere: both currencies survive, untouched.
    expect(merged.marketValues?.map((v) => v.currency)).toEqual(['USD', 'EUR']);
  });

  it('does not list one member’s valuation twice when it carries both fields', () => {
    const only = value({ msrpCents: 1 });
    const merged = merge(ok('a', v2({ marketValue: only, marketValues: [only] })));
    expect(merged.marketValues).toHaveLength(1);
  });

  it('is an empty list, not a null, when nobody priced the car', () => {
    const merged = merge(ok('a', v2()));
    expect(merged.marketValues).toEqual([]);
    expect(merged.marketValue).toBeNull();
  });
});

describe('mergeVinHistoryPayloads — coverage', () => {
  it('takes the best evidence: covered > unavailable > not_covered', () => {
    const merged = merge(
      ok('a', v2({ coverage: coverage({ owners: 'covered', mileage: 'unavailable', service: 'not_covered' }) })),
      ok('b', v2({ coverage: coverage({ owners: 'not_covered', mileage: 'not_covered', service: 'not_covered' }) })),
    );

    // One source answering a section IS the section being answered; the other's
    // silence about it is not a finding.
    expect(merged.coverage.owners).toBe('covered');
    expect(merged.coverage.mileage).toBe('unavailable');
    expect(merged.coverage.service).toBe('not_covered');
  });

  it('lets the second source cover what the first never held', () => {
    const merged = merge(
      ok('a', v2({ coverage: coverage({ inspections: 'not_covered', inspectionValidity: 'not_covered' }) })),
      ok('b', v2({ coverage: coverage({ inspections: 'covered', inspectionValidity: 'covered' }) })),
    );

    expect(merged.coverage.inspections).toBe('covered');
    expect(merged.coverage.inspectionValidity).toBe('covered');
  });

  it('carries every section id and never an undefined', () => {
    const merged = merge(ok('a', v2()), broken('b'));
    for (const id of VIN_HISTORY_V2_SECTION_IDS) {
      expect(['covered', 'unavailable', 'not_covered']).toContain(merged.coverage[id]);
    }
  });

  it('does not let a failed member promote a permanently absent section', () => {
    /*
     * A failed member contributes no coverage at all. Marking every section
     * `unavailable` because one source never answered would turn "no source has
     * ever held service history" into "temporarily broken, come back later" —
     * inviting a buyer to wait for data that will never exist. The failure is
     * visible where failures belong: in `sources[]`.
     */
    const merged = merge(ok('a', v2({ coverage: coverage({ service: 'not_covered' }) })), broken('b'));

    expect(merged.coverage.service).toBe('not_covered');
    expect(merged.sources).toContainEqual({ id: 'b', status: 'failed', dataset: null });
  });
});

describe('mergeVinHistoryPayloads — sources', () => {
  it('concatenates every entry and preserves each status', () => {
    const aSources: VinHistorySource[] = [
      { id: 'carsxe.history', status: 'ok', dataset: 'NMVTIS' },
      { id: 'carsxe.recalls', status: 'skipped', dataset: null },
      { id: 'carsxe.lienTheft', status: 'failed', dataset: null },
    ];
    const merged = merge(
      ok('carsxe', v2({ sources: aSources })),
      ok('other', v2({ sources: [{ id: 'other.registry', status: 'ok', dataset: 'EU' }] })),
    );

    expect(merged.sources).toEqual([...aSources, { id: 'other.registry', status: 'ok', dataset: 'EU' }]);
  });

  it('gives a member that named no dataset one entry of its own', () => {
    // Otherwise a successful source is invisible on the report it helped produce.
    const merged = merge(ok('a', v2()));
    expect(merged.sources).toEqual([{ id: 'a', status: 'ok', dataset: null }]);
  });

  it('shows a failed member as failed and takes nothing else from it', () => {
    const merged = merge(
      ok('a', v2({ mileageRecords: [mileage('2020-01-01', 10_000)], sources: [{ id: 'a.history', status: 'ok', dataset: null }] })),
      broken('b'),
    );

    expect(merged.sources).toEqual([
      { id: 'a.history', status: 'ok', dataset: null },
      { id: 'b', status: 'failed', dataset: null },
    ]);
    // The survivor's data is intact — one source down is a partial report, not a
    // lost one.
    expect(merged.mileageRecords).toHaveLength(1);
    expectSummaryDerivable(merged);
  });
});

describe('mergeVinHistoryPayloads — theft', () => {
  it('ORs the stolen flag and keeps the reporting source’s details', () => {
    const merged = merge(
      ok('a', v2({ theft: { ...NO_THEFT } })),
      ok('b', v2({
        theft: { stolen: true, reportedAt: '2018-02-03', countryCode: 'PL', recoveredAt: null, source: 'registry' },
      })),
    );

    expect(merged.theft.stolen).toBe(true);
    expect(merged.theft.countryCode).toBe('PL');
    expect(merged.summary.hasStolenRecord).toBe(true);
    expectSummaryDerivable(merged);
  });

  it('UNIONS the registers that were searched', () => {
    /*
     * ⚠️ The load-bearing field of the section. `stolen: false` is not
     * publishable on its own — a source covering five registers answers "not
     * stolen" for a car registered in a sixth having searched nothing that would
     * know. Almost all the value of a second source here is the countries it
     * adds, so none may be dropped.
     */
    const merged = merge(
      ok('a', v2({ theftCoverage: { countryCodes: ['US', 'CA'] } })),
      ok('b', v2({ theftCoverage: { countryCodes: ['ca', 'PL', 'DE'] } })),
    );

    expect(merged.theftCoverage?.countryCodes.sort()).toEqual(['CA', 'DE', 'PL', 'US']);
  });

  it('is null — not an empty list — when nobody said which registers they searched', () => {
    // "We cannot say which registers were searched" and "none were searched" are
    // different statements, and neither may be invented from the other.
    const merged = merge(ok('a', v2()), ok('b', v2()));
    expect(merged.theftCoverage).toBeNull();
  });
});

describe('mergeVinHistoryPayloads — v1 beside v2', () => {
  it('reads a v1 member through the version field and keeps its records', () => {
    const legacy = v1({
      mileageRecords: [mileage('2018-01-01', 30_000)],
      recalls: [recall('LEGACY-1')],
      theft: { stolen: false, reportedAt: null, countryCode: null, recoveredAt: null, source: null },
    });

    const merged = merge(
      ok('legacy', legacy),
      ok('modern', v2({ mileageRecords: [mileage('2022-01-01', 90_000)], brands: [] })),
    );

    expect(merged.schemaVersion).toBe(2);
    expect(merged.mileageRecords.map((m) => m.date)).toEqual(['2018-01-01', '2022-01-01']);
    expect(merged.recalls.map((r) => r.reference)).toEqual(['LEGACY-1']);
    expectSummaryDerivable(merged);
  });

  it('marks the seven sections a v1 payload answers as covered, and no others', () => {
    // v1 predates `coverage` and is not silent about these: it carries exactly
    // those seven arrays because the provider looked.
    const merged = merge(ok('legacy', v1()));

    expect(merged.coverage.owners).toBe('covered');
    expect(merged.coverage.mileage).toBe('covered');
    expect(merged.coverage.damages).toBe('covered');
    expect(merged.coverage.registrations).toBe('covered');
    expect(merged.coverage.recalls).toBe('covered');
    expect(merged.coverage.theft).toBe('covered');
    expect(merged.coverage.inspections).toBe('covered');
    // Everything v1 has no field for stays a statement of absence, not a claim.
    expect(merged.coverage.insurance).toBe('not_covered');
    expect(merged.coverage.brands).toBe('not_covered');
    expect(merged.coverage.marketValue).toBe('not_covered');
    expect(merged.coverage.timeToSell).toBe('not_covered');
  });
});

describe('mergeVinHistoryPayloads — synthetic', () => {
  it('is true only when EVERY contributing member is synthetic', () => {
    const generated = v2({ synthetic: true });
    expect(merge(ok('mock', generated), ok('mock2', v2({ synthetic: true }))).synthetic).toBe(true);
  });

  it('is FALSE when one real source stands beside a generated one', () => {
    /*
     * `synthetic` is one flag for the whole report, carried onto the page and the
     * PDF. Marking a report that contains real records as generated is the same
     * lie as the reverse — it tells a buyer the records they are acting on were
     * invented.
     */
    expect(merge(ok('mock', v2({ synthetic: true })), ok('real', v2())).synthetic).toBe(false);
  });

  it('is false with no contributing member at all', () => {
    // Not the vacuous truth of `[].every(...)`: an empty report holds no
    // generated data either.
    expect(merge(broken('a'), broken('b')).synthetic).toBe(false);
  });

  it('ignores a FAILED synthetic member', () => {
    expect(merge(ok('real', v2()), { name: 'mock', payload: v2({ synthetic: true }), failed: true }).synthetic).toBe(
      false,
    );
  });
});

describe('mergeVinHistoryPayloads — summary', () => {
  it('recomputes rather than adding the members’ own summaries', () => {
    /*
     * Both members claim 99 records in their own summary blocks. The merged
     * number is what the merged arrays actually hold — copying or adding would
     * put "198 records" on a report carrying three.
     */
    const inflated = { recordCount: 99, ownersCount: 42 };
    const merged = merge(
      ok('a', v2({
        mileageRecords: [mileage('2020-01-01', 10_000)],
        summary: { ...v2().summary, ...inflated },
      })),
      ok('b', v2({
        registrations: [
          { countryCode: 'DE', region: null, firstRegistration: '2014-05-02', lastRegistration: null, plateMasked: null, status: 'active' },
          { countryCode: 'US', region: 'CA', firstRegistration: '2018-01-09', lastRegistration: null, plateMasked: null, status: 'active' },
        ],
        summary: { ...v2().summary, ...inflated },
      })),
    );

    expect(merged.summary.recordCount).toBe(3);
    expect(merged.summary.ownersCount).toBe(0);
    expect(merged.summary.countriesSeen).toEqual(['DE', 'US']);
    // The earliest first registration across both sources — the merged fact.
    expect(merged.summary.firstRegistration).toBe('2014-05-02');
    expectSummaryDerivable(merged);
  });

  it('counts a stolen record and the v2 categories', () => {
    const merged = merge(
      ok('a', v2({
        brands: [{ code: 'SALV', category: 'salvage', label: 'Salvage', reportedAt: null, authority: 'CA DMV', countryCode: 'US' }],
        insuranceRecords: [{ date: '2019-06-01', insurer: null, countryCode: 'US', totalLoss: true, reason: null, source: null }],
        theft: { stolen: true, reportedAt: '2020-01-01', countryCode: 'US', recoveredAt: null, source: null },
      })),
    );

    expect(merged.summary.recordCount).toBe(3);
    expect(merged.summary.hasSalvageOrTotalLoss).toBe(true);
    expect(merged.summary.hasTitleBrand).toBe(true);
    expect(merged.summary.hasInsuranceTotalLoss).toBe(true);
    expectSummaryDerivable(merged);
  });

  it('reports nothing at all for a report nobody could contribute to', () => {
    // What `MIN_SELLABLE_RECORD_COUNT` reads to refund quietly, one layer up.
    const merged = merge(broken('a'));
    expect(merged.summary.recordCount).toBe(0);
    expectSummaryDerivable(merged);
  });
});

describe('mergeVinHistoryPayloads — never throws', () => {
  it('survives no members at all', () => {
    const merged = mergeVinHistoryPayloads({ vin: VIN, provider: 'aggregate', generatedAt: AT, members: [] });
    expect(merged.summary.recordCount).toBe(0);
    expect(merged.sources).toEqual([]);
  });

  it('survives a payload whose arrays are not arrays', () => {
    /*
     * The payloads reach this function from a JSON column, so their shape is a
     * compile-time fact and not a runtime one. A merge that throws here runs
     * AFTER the money was taken and the sources were paid: it would refund a
     * customer whose data we are holding in memory, and page every admin.
     */
    const mangled = {
      ...v2(),
      mileageRecords: null,
      registrations: 'nope',
      recalls: undefined,
      coverage: null,
      sources: 7,
      theft: null,
    } as unknown as VinHistoryPayloadV2;

    const merged = merge(ok('a', mangled), ok('b', v2({ mileageRecords: [mileage('2020-01-01', 1_000)] })));

    expect(merged.mileageRecords).toHaveLength(1);
    expect(merged.theft.stolen).toBe(false);
    expectSummaryDerivable(merged);
  });

  it('survives nulls inside the arrays', () => {
    const withHoles = v2({
      mileageRecords: [null as unknown as VinHistoryMileageRecord, mileage('2020-01-01', 5_000)],
      recalls: [null as unknown as VinHistoryRecall],
    });

    const merged = merge(ok('a', withHoles));
    expect(merged.mileageRecords).toHaveLength(1);
    expect(merged.recalls).toEqual([]);
  });
});
