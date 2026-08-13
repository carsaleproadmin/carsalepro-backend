// Category: PROVIDER CONTRACT. Pure — no DB, no R2, no network, no Nest container.
/**
 * The composite: who it calls, what a member's failure costs, and the two
 * answers it gives away for free.
 *
 * The cache is faked to a pass-through, because WHAT is cached is pinned in
 * `provider-response.cache.spec.ts` and what matters here is that every member
 * goes through it.
 */

import { Logger } from '@nestjs/common';
import { ProviderResponseCache } from '../provider-response.cache';
import { VinHistoryPayload, VinHistoryPayloadV2 } from '../vin-history-payload-v2';
import { VinHistoryPreviewSummary, VinHistoryProvider } from '../vin-history.provider';
import {
  AllVinHistorySourcesFailedError,
  CompositeVinHistoryProvider,
} from './composite-vin-history.provider';

/** Well-formed, check digit computes. */
const US_VIN = 'WBAFR7C57CC811956';
/** Well-formed, check digit does NOT compute — a European domestic VIN. */
const EU_VIN = 'WAUZZZ8V8MA012345';

function payload(provider: string, recordCount = 1): VinHistoryPayloadV2 {
  return {
    schemaVersion: 2,
    vin: US_VIN,
    provider,
    synthetic: false,
    generatedAt: '2026-08-01T00:00:00.000Z',
    summary: {
      recordCount,
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
    mileageRecords: [
      { date: '2020-01-01', mileageKm: 10_000, source: 'registration', countryCode: 'US', suspicious: false },
    ],
    damageRecords: [],
    registrations: [],
    recalls: [],
    theft: { stolen: false, reportedAt: null, countryCode: null, recoveredAt: null, source: null },
    inspections: [],
    insuranceRecords: [],
    brands: [],
    serviceRecords: [],
    equipment: null,
    marketValue: null,
    coverage: {} as VinHistoryPayloadV2['coverage'],
    sources: [{ id: `${provider}.main`, status: 'ok', dataset: null }],
  };
}

class FakeMember implements VinHistoryProvider {
  readonly synthetic = false;
  calls = 0;

  constructor(
    readonly name: string,
    private readonly options: { configured?: boolean; error?: Error } = {},
  ) {}

  get configured(): boolean {
    return this.options.configured ?? true;
  }
  async preview(): Promise<VinHistoryPreviewSummary | null> {
    return null;
  }
  async fetch(): Promise<VinHistoryPayload> {
    this.calls += 1;
    if (this.options.error) throw this.options.error;
    return payload(this.name);
  }
}

/** Straight through: caching is somebody else's spec. */
const passThrough = {
  through: (member: VinHistoryProvider, vin: string) => member.fetch(vin),
} as unknown as ProviderResponseCache;

function composite(...members: VinHistoryProvider[]): CompositeVinHistoryProvider {
  return new CompositeVinHistoryProvider(members, passThrough);
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

describe('CompositeVinHistoryProvider — identity', () => {
  it('is named aggregate and never claims to be synthetic', () => {
    /*
     * ⚠️ `name` is a frozen literal: half of the `vin_provider` unique key, the
     * provenance stamped on every purchase, and part of the R2 key of every
     * archived payload and rendered PDF. Changing it orphans all of them
     * silently. This assertion makes that a deliberate act.
     */
    const p = composite(new FakeMember('a'));
    expect(p.name).toBe('aggregate');
    expect(p.synthetic).toBe(false);
  });

  it('is configured when ANY member is', () => {
    expect(composite(new FakeMember('a', { configured: false })).configured).toBe(false);
    expect(
      composite(new FakeMember('a', { configured: false }), new FakeMember('b')).configured,
    ).toBe(true);
    // No member at all: nothing may be charged for, so /unlock answers 503.
    expect(composite().configured).toBe(false);
  });
});

describe('CompositeVinHistoryProvider — covers', () => {
  it('accepts a VIN the check digit would refuse', () => {
    /*
     * ⚠️ THE DELIBERATE CHANGE. The check digit was the selling gate for a
     * US-only source and refused exactly the European domestic VINs a European
     * source can describe in full. It keeps its job one level down — deciding
     * whether the US-only member calls its US-only endpoints — see
     * `vinHistoryCoverage` in `src/vin/vin.util.ts`.
     */
    const p = composite(new FakeMember('a'));
    expect(p.covers(EU_VIN)).toBe('supported');
    expect(p.covers(US_VIN)).toBe('supported');
    expect(p.covers(US_VIN.toLowerCase())).toBe('supported');
  });

  it('refuses only a string that is not a VIN, and never says not_covered', () => {
    const p = composite(new FakeMember('a'));
    expect(p.covers('NOT-A-VIN')).toBe('invalid_vin');
    expect(p.covers('WBAFR7C57CC81195')).toBe('invalid_vin');
    // I, O and Q are not in the VIN alphabet.
    expect(p.covers('WBAFR7C57CC8I1956')).toBe('invalid_vin');
  });
});

describe('CompositeVinHistoryProvider — preview', () => {
  it('returns null and calls nobody', async () => {
    // The route is @Public(), anonymous and crawlable; no member has a free
    // probe. `null` means "no counters at all", never zeros.
    const a = new FakeMember('a');
    const b = new FakeMember('b');

    await expect(composite(a, b).preview(US_VIN)).resolves.toBeNull();
    expect(a.calls + b.calls).toBe(0);
  });
});

describe('CompositeVinHistoryProvider — fetch', () => {
  it('calls every configured member and merges the answers', async () => {
    const a = new FakeMember('a');
    const b = new FakeMember('b');
    const merged = await composite(a, b).fetch(US_VIN);

    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(merged.provider).toBe('aggregate');
    expect(merged.vin).toBe(US_VIN);
    expect(merged.sources.map((s) => s.id)).toEqual(['a.main', 'b.main']);
    // One chronological ladder, deduped: both members sent the same reading.
    expect(merged.mileageRecords).toHaveLength(1);
  });

  it('never calls an unconfigured member', async () => {
    // An operator's missing API key is not a source that broke, and must not
    // appear on a customer's report as one.
    const off = new FakeMember('off', { configured: false });
    const on = new FakeMember('on');
    const merged = await composite(off, on).fetch(US_VIN);

    expect(off.calls).toBe(0);
    expect(merged.sources.map((s) => s.id)).toEqual(['on.main']);
  });

  it('produces a report when ONE member fails', async () => {
    const broken = new FakeMember('broken', { error: new Error('http_503') });
    const merged = await composite(broken, new FakeMember('working')).fetch(US_VIN);

    expect(merged.summary.recordCount).toBeGreaterThan(0);
    expect(merged.sources).toContainEqual({ id: 'broken', status: 'failed', dataset: null });
    expect(merged.sources).toContainEqual({ id: 'working.main', status: 'ok', dataset: null });
  });

  it('throws ONLY when every member failed', async () => {
    /*
     * That is a real outage rather than a car with no records, so it refunds AND
     * alerts. A single survivor is not this: a partial report is a real report,
     * and it says what is missing.
     */
    const p = composite(
      new FakeMember('a', { error: new Error('http_500') }),
      new FakeMember('b', { error: new Error('timeout') }),
    );

    await expect(p.fetch(US_VIN)).rejects.toBeInstanceOf(AllVinHistorySourcesFailedError);
    await expect(p.fetch(US_VIN)).rejects.toThrow(/http_500.*timeout/s);
  });

  it('throws when no member is configured at all', async () => {
    // The buyer paid and there is nothing to give them — the same treatment as an
    // outage, because to them it is one.
    await expect(composite(new FakeMember('a', { configured: false })).fetch(US_VIN)).rejects.toBeInstanceOf(
      AllVinHistorySourcesFailedError,
    );
  });

  it('normalises the VIN once, for every member and the payload', async () => {
    const merged = await composite(new FakeMember('a')).fetch(US_VIN.toLowerCase());
    expect(merged.vin).toBe(US_VIN);
  });

  it('stamps generatedAt as an ISO timestamp', async () => {
    const merged = await composite(new FakeMember('a')).fetch(US_VIN);
    expect(merged.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
