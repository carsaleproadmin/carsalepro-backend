// Category: CACHE SEMANTICS. Prisma and settings are faked — no DB, no network.
/**
 * Per-member caching: which row a member's answer lands in, how long it lives,
 * and what happens when the cache itself misbehaves.
 *
 * The money is the point. Every member here is billable, so a rule that looks
 * like an optimisation ("read the row first") is really a rule about not paying
 * twice, and a rule that looks like paranoia ("never throw on write") is really
 * a rule about not refunding a lookup that succeeded.
 */

import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { ProviderResponseCache } from './provider-response.cache';
import { VinHistoryPayload, VinHistoryPayloadV2 } from './vin-history-payload-v2';
import { VinHistoryPreviewSummary, VinHistoryProvider } from './vin-history.provider';

const VIN = 'WBAFR7C57CC811956';
const DAY_MS = 86_400_000;

function payload(recordCount: number, provider = 'member'): VinHistoryPayloadV2 {
  return {
    schemaVersion: 2,
    vin: VIN,
    provider,
    synthetic: false,
    generatedAt: '2026-08-12T10:00:00.000Z',
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
    mileageRecords: [],
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
    sources: [],
  };
}

/** A member that counts its calls, so "did we pay again?" is an assertion. */
class FakeMember implements VinHistoryProvider {
  calls = 0;

  constructor(
    readonly name: string,
    private readonly answer: VinHistoryPayload | Error = payload(3),
  ) {}

  readonly synthetic = false;
  get configured(): boolean {
    return true;
  }
  async preview(): Promise<VinHistoryPreviewSummary | null> {
    return null;
  }
  async fetch(): Promise<VinHistoryPayload> {
    this.calls += 1;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

interface Harness {
  cache: ProviderResponseCache;
  findUnique: jest.Mock;
  upsert: jest.Mock;
  getNumber: jest.Mock;
}

function harness(options: { row?: unknown; settings?: Record<string, number> } = {}): Harness {
  const findUnique = jest.fn().mockResolvedValue(options.row ?? null);
  const upsert = jest.fn().mockResolvedValue(undefined);
  const values: Record<string, number> = {
    vinHistoryCacheDays: 30,
    vinHistoryEmptyCacheDays: 7,
    ...options.settings,
  };
  const getNumber = jest.fn().mockImplementation((key: string) => Promise.resolve(values[key]));

  const prisma = { vinHistoryReport: { findUnique, upsert } } as unknown as PrismaService;
  const settings = { getNumber } as unknown as SettingsService;

  return { cache: new ProviderResponseCache(prisma, settings), findUnique, upsert, getNumber };
}

/** A cached row as Prisma returns it. */
function row(body: VinHistoryPayload | unknown, expiresInDays: number): Record<string, unknown> {
  return {
    vin: VIN,
    provider: 'member',
    payload: body,
    recordCount: 3,
    fetchedAt: new Date(),
    expiresAt: new Date(Date.now() + expiresInDays * DAY_MS),
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

describe('ProviderResponseCache — hits', () => {
  it('serves a fresh row WITHOUT calling the member', async () => {
    // The whole reason this class exists: a hit on one source must not cost a
    // lookup at that source.
    const cached = payload(9);
    const h = harness({ row: row(cached, 5) });
    const member = new FakeMember('carsxe');

    await expect(h.cache.through(member, VIN)).resolves.toEqual(cached);
    expect(member.calls).toBe(0);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('keys the row on the MEMBER’s name, never the composite’s', async () => {
    /*
     * ⚠️ THE POINT OF THE WHOLE FILE. The merged report is cached under
     * ('vin','aggregate'); each member is cached under its own name. Sharing one
     * key would mean a miss re-pays every source behind the report.
     */
    const h = harness();
    await h.cache.through(new FakeMember('carsxe'), VIN);
    await h.cache.through(new FakeMember('other'), VIN);

    expect(h.findUnique.mock.calls.map((c) => c[0].where.vin_provider)).toEqual([
      { vin: VIN, provider: 'carsxe' },
      { vin: VIN, provider: 'other' },
    ]);
    expect(h.upsert.mock.calls.map((c) => c[0].where.vin_provider.provider)).toEqual([
      'carsxe',
      'other',
    ]);
  });

  it('normalises the VIN before it becomes half of a unique key', async () => {
    const h = harness();
    await h.cache.through(new FakeMember('carsxe'), VIN.toLowerCase());
    expect(h.findUnique.mock.calls[0][0].where.vin_provider.vin).toBe(VIN);
    expect(h.upsert.mock.calls[0][0].where.vin_provider.vin).toBe(VIN);
  });

  it('treats an EXPIRED row as a miss', async () => {
    const h = harness({ row: row(payload(4), -1) });
    const member = new FakeMember('carsxe');

    await h.cache.through(member, VIN);
    expect(member.calls).toBe(1);
    expect(h.upsert).toHaveBeenCalled();
  });

  it('treats an unrecognisable stored payload as a miss', async () => {
    // A row written by an older shape must be refetched and overwritten, never
    // handed to a reader that will trip over it.
    const h = harness({ row: row({ nonsense: true }, 5) });
    const member = new FakeMember('carsxe');

    await h.cache.through(member, VIN);
    expect(member.calls).toBe(1);
  });
});

describe('ProviderResponseCache — writes', () => {
  it('writes a real answer with the LONG expiry', async () => {
    const h = harness();
    const answer = payload(6);
    await h.cache.through(new FakeMember('carsxe', answer), VIN);

    expect(h.getNumber).toHaveBeenCalledWith('vinHistoryCacheDays');
    const args = h.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({ vin: VIN, provider: 'carsxe', recordCount: 6 });
    expect(daysFromNow(args.create.expiresAt)).toBeCloseTo(30, 1);
    expect(args.update.payload).toEqual(answer);
    // The clock restarts: the member was asked again and answered again.
    expect(args.update.fetchedAt).toBeInstanceOf(Date);
  });

  it('writes an EMPTY answer with the short expiry, and still returns it', async () => {
    /*
     * A source holding nothing for a VIN today holds nothing for it tomorrow, so
     * re-paying to learn that is an unbounded cost with no upside — but the
     * window is short, so a VIN that gains its first record becomes sellable
     * again within the week. Mirrors `VinHistoryService.rememberEmptyAnswer`.
     *
     * It is RETURNED rather than thrown, unlike the single-source path: the other
     * member may hold plenty, and whether the MERGED report is sellable is
     * decided one layer up.
     */
    const h = harness();
    const empty = payload(0);
    await expect(h.cache.through(new FakeMember('carsxe', empty), VIN)).resolves.toEqual(empty);

    expect(h.getNumber).toHaveBeenCalledWith('vinHistoryEmptyCacheDays');
    const args = h.upsert.mock.calls[0][0];
    expect(args.create.recordCount).toBe(0);
    expect(daysFromNow(args.create.expiresAt)).toBeCloseTo(7, 1);
  });

  it('remembers nothing when the empty window is disabled', async () => {
    // `vinHistoryEmptyCacheDays: 0` is the documented escape: every attempt asks
    // the source again.
    const h = harness({ settings: { vinHistoryEmptyCacheDays: 0 } });
    await h.cache.through(new FakeMember('carsxe', payload(0)), VIN);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe('ProviderResponseCache — the cache never breaks a lookup', () => {
  it('returns the payload when the WRITE fails', async () => {
    /*
     * ⚠️ The member has already been called and, on a billable source, already
     * been paid for. Letting a write failure escape costs the lookup we just
     * bought, the customer's report, and an admin alert for a fetch that
     * succeeded.
     */
    const h = harness();
    h.upsert.mockRejectedValue(new Error('deadlock detected'));
    const answer = payload(2);

    await expect(h.cache.through(new FakeMember('carsxe', answer), VIN)).resolves.toEqual(answer);
  });

  it('falls through to the member when the READ fails', async () => {
    // A database hiccup on the optimisation in front of a lookup must not fail
    // the lookup. The cost is one extra call, which is the lesser price.
    const h = harness();
    h.findUnique.mockRejectedValue(new Error('connection reset'));
    const member = new FakeMember('carsxe');

    await expect(h.cache.through(member, VIN)).resolves.toBeDefined();
    expect(member.calls).toBe(1);
  });

  it('returns the payload when the settings lookup fails', async () => {
    const h = harness();
    h.getNumber.mockRejectedValue(new Error('settings unavailable'));
    const answer = payload(2);

    await expect(h.cache.through(new FakeMember('carsxe', answer), VIN)).resolves.toEqual(answer);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('propagates a member failure unchanged and caches nothing', async () => {
    // A cache is not allowed to invent a failure — and it is not allowed to
    // remember one either, or one bad minute at a source would be served for
    // thirty days.
    const h = harness();
    const boom = new Error('provider down');

    await expect(h.cache.through(new FakeMember('carsxe', boom), VIN)).rejects.toBe(boom);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

function daysFromNow(date: Date): number {
  return (date.getTime() - Date.now()) / DAY_MS;
}
