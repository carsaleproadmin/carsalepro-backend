// Category: PROVIDER CONTRACT. Pure — no DB, no R2, no network, no Nest container.
/**
 * The CarsXE provider: which calls it makes, which it refuses to make, and what
 * it does when one of them fails.
 *
 * The client is faked outright. ⚠️ NOTHING HERE TOUCHES THE NETWORK — the
 * account holds one lifetime `/history` call and it must not be spent by a test
 * run. The fixtures are the same hand-authored, unverified kind as in
 * `carsxe.mapper.spec.ts`.
 */

import { Logger } from '@nestjs/common';
import {
  CarsxeCallResult,
  CarsxeClient,
  CarsxeHistoryResponse,
  CarsxeLienTheftResponse,
  CarsxeMarketValueResponse,
  CarsxeRecallsResponse,
  CarsxeSpecsResponse,
} from './carsxe.client';
import {
  CarsxeHistoryUnavailableError,
  CarsxeVinHistoryProvider,
} from './carsxe-vin-history.provider';

/** Well-formed, check digit computes → a US-market VIN. */
const US_VIN = 'WBAFR7C57CC811956';
/** Well-formed, check digit does not compute → European domestic. */
const EU_VIN = 'WAUZZZ8V8MA012345';

interface FakeClientOptions {
  history?: CarsxeCallResult<CarsxeHistoryResponse>;
  specs?: CarsxeCallResult<CarsxeSpecsResponse>;
  marketValue?: CarsxeCallResult<CarsxeMarketValueResponse>;
  recalls?: CarsxeCallResult<CarsxeRecallsResponse>;
  lienTheft?: CarsxeCallResult<CarsxeLienTheftResponse>;
  configured?: boolean;
  /** Simulate a bug in our own code rather than a provider outage. */
  throwFrom?: keyof FakeClientOptions;
}

class FakeCarsxeClient {
  readonly calls: string[] = [];
  constructor(private readonly options: FakeClientOptions = {}) {}

  get configured(): boolean {
    return this.options.configured ?? true;
  }

  private answer<T>(name: keyof FakeClientOptions, fallback: CarsxeCallResult<T>): Promise<T extends never ? never : CarsxeCallResult<T>> {
    this.calls.push(name);
    if (this.options.throwFrom === name) {
      return Promise.reject(new Error('client bug')) as never;
    }
    return Promise.resolve(
      (this.options[name] as CarsxeCallResult<T> | undefined) ?? fallback,
    ) as never;
  }

  history(): Promise<CarsxeCallResult<CarsxeHistoryResponse>> {
    return this.answer('history', {
      status: 'ok',
      body: {
        success: true,
        currentTitleInformation: {
          state: 'CA',
          titleIssueDate: '08/14/2021',
          odometer: 96500,
          odometerUnitOfMeasure: 'MI',
        },
      },
    });
  }

  specs(): Promise<CarsxeCallResult<CarsxeSpecsResponse>> {
    return this.answer('specs', {
      status: 'ok',
      body: { success: true, attributes: { make: 'BMW', model: '328i', year: 2012 } },
    });
  }

  marketValue(): Promise<CarsxeCallResult<CarsxeMarketValueResponse>> {
    return this.answer('marketValue', { status: 'ok', body: { success: true } });
  }

  recalls(): Promise<CarsxeCallResult<CarsxeRecallsResponse>> {
    return this.answer('recalls', { status: 'ok', body: { success: true, recalls: [] } });
  }

  lienTheft(): Promise<CarsxeCallResult<CarsxeLienTheftResponse>> {
    return this.answer('lienTheft', { status: 'ok', body: { success: true, events: [] } });
  }
}

function provider(options: FakeClientOptions = {}): {
  provider: CarsxeVinHistoryProvider;
  client: FakeCarsxeClient;
} {
  const client = new FakeCarsxeClient(options);
  return {
    provider: new CarsxeVinHistoryProvider(client as unknown as CarsxeClient),
    client,
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterAll(() => jest.restoreAllMocks());

describe('CarsxeVinHistoryProvider — identity', () => {
  it('is named carsxe and never claims to be synthetic', () => {
    /*
     * ⚠️ `name` is a frozen literal. It is half of the `vin_provider` unique key
     * on every cached report, it is stamped on every purchase, and it is baked
     * into the R2 key of every archived payload and rendered PDF. Changing it
     * orphans all of them silently — nothing errors, the cache simply stops
     * hitting. This assertion exists to make that a deliberate act.
     */
    const { provider: p } = provider();
    expect(p.name).toBe('carsxe');
    expect(p.synthetic).toBe(false);
  });

  it('is configured exactly when the client holds a key', () => {
    expect(provider({ configured: true }).provider.configured).toBe(true);
    expect(provider({ configured: false }).provider.configured).toBe(false);
  });

  it('answers coverage offline, from the check digit', () => {
    const { provider: p, client } = provider();
    expect(p.covers(US_VIN)).toBe('supported');
    expect(p.covers(EU_VIN)).toBe('not_covered');
    expect(p.covers('NOT-A-VIN')).toBe('invalid_vin');
    // Free means free: not one call was made to decide any of that.
    expect(client.calls).toEqual([]);
  });
});

describe('CarsxeVinHistoryProvider — preview', () => {
  it('returns null and makes NO call whatsoever', async () => {
    /*
     * THE LOAD-BEARING ONE. `GET /api/v1/vin-history/:vin/preview` is `@Public()`
     * and anonymous at twenty requests a minute, and CarsXE has no free
     * endpoint — `/specs` is cheap, not free. A single call from here lets a
     * crawler spend our money twenty times a minute. `null` means "this provider
     * has no free probe", which the caller must render as no counters at all,
     * never as zeros.
     */
    const { provider: p, client } = provider();

    await expect(p.preview(US_VIN)).resolves.toBeNull();
    await expect(p.preview(EU_VIN)).resolves.toBeNull();
    expect(client.calls).toEqual([]);
  });
});

describe('CarsxeVinHistoryProvider — fetch', () => {
  it('queries all five datasets for a US-market VIN', async () => {
    const { provider: p, client } = provider();
    const payload = await p.fetch(US_VIN);

    expect(client.calls.sort()).toEqual([
      'history',
      'lienTheft',
      'marketValue',
      'recalls',
      'specs',
    ]);
    expect(payload.schemaVersion).toBe(2);
    expect(payload.synthetic).toBe(false);
    expect(payload.provider).toBe('carsxe');
    expect(payload.vin).toBe(US_VIN);
    expect(payload.coverage.recalls).toBe('covered');
    expect(payload.coverage.theft).toBe('covered');
  });

  it('normalises the VIN it was handed', async () => {
    const { provider: p } = provider();
    const payload = await p.fetch(US_VIN.toLowerCase());
    expect(payload.vin).toBe(US_VIN);
  });

  it('SKIPS recalls and lien/theft for a non-US-market VIN', async () => {
    /*
     * ⚠️ Both endpoints answer `success: true` with zero events for a European
     * VIN, from a database that was never searched. Rendering that as "no theft
     * record found" and "no open recalls" is a false clean bill of health on a
     * document someone paid for. A skipped section is `not_covered` — never
     * `covered`, which would mean we looked.
     */
    const { provider: p, client } = provider();
    const payload = await p.fetch(EU_VIN);

    expect(client.calls).not.toContain('recalls');
    expect(client.calls).not.toContain('lienTheft');
    expect(client.calls.sort()).toEqual(['history', 'marketValue', 'specs']);

    expect(payload.coverage.recalls).toBe('not_covered');
    expect(payload.coverage.theft).toBe('not_covered');
    expect(payload.recalls).toEqual([]);
    expect(payload.theft.stolen).toBe(false);
    expect(payload.summary.hasStolenRecord).toBe(false);
    expect(payload.summary.hasOpenRecalls).toBe(false);

    const skipped = payload.sources.filter((s) => s.status === 'skipped').map((s) => s.id);
    expect(skipped).toEqual(['carsxe.recalls', 'carsxe.lienTheft']);
  });

  it('returns a well-formed EMPTY payload when the history holds nothing', async () => {
    /*
     * Deliberately not a throw. NMVTIS holding no record for a VIN is a normal
     * outcome — the commonest one for this class of provider. `VinHistoryService`
     * reads the zero through `MIN_SELLABLE_RECORD_COUNT` and refunds quietly. A
     * throw produces the same refund PLUS an admin alert, which for a routine
     * outcome trains operators to ignore the channel that also carries "the
     * refund did not go through".
     */
    const { provider: p } = provider({
      history: { status: 'empty', reason: 'report_not_found' },
    });
    const payload = await p.fetch(US_VIN);

    expect(payload.summary.recordCount).toBe(0);
    expect(payload.schemaVersion).toBe(2);
    expect(payload.owners).toEqual([]);
    expect(payload.registrations).toEqual([]);
    expect(payload.coverage.owners).toBe('covered');
    // The other four still ran and their answers are still here.
    expect(payload.vehicle?.make).toBe('BMW');
  });

  it('throws only when the history endpoint gave no answer at all', async () => {
    // A transport failure means we have nothing to sell. That IS an incident:
    // the service refunds and alerts, and an operator learns the integration is
    // down rather than watching every purchase quietly refund itself.
    const { provider: p } = provider({
      history: { status: 'failed', reason: 'transport:ECONNABORTED' },
    });

    await expect(p.fetch(US_VIN)).rejects.toBeInstanceOf(CarsxeHistoryUnavailableError);
    await expect(p.fetch(US_VIN)).rejects.toThrow(/ECONNABORTED/);
  });

  it('does not fail the purchase when a SECONDARY endpoint fails', async () => {
    const { provider: p } = provider({
      specs: { status: 'failed', reason: 'http_502' },
      marketValue: { status: 'failed', reason: 'http_500' },
      recalls: { status: 'failed', reason: 'transport:ECONNRESET' },
      lienTheft: { status: 'failed', reason: 'http_503' },
    });
    const payload = await p.fetch(US_VIN);

    // The buyer keeps everything that did work…
    expect(payload.registrations).toHaveLength(1);
    expect(payload.summary.recordCount).toBeGreaterThan(0);
    // …and every broken section says it is broken rather than reading empty.
    expect(payload.coverage.equipment).toBe('unavailable');
    expect(payload.coverage.marketValue).toBe('unavailable');
    expect(payload.coverage.recalls).toBe('unavailable');
    expect(payload.coverage.theft).toBe('unavailable');
    expect(payload.sources.filter((s) => s.status === 'failed')).toHaveLength(4);
    // No vehicle without specs — and that is a null, not an object of nulls.
    expect(payload.vehicle).toBeNull();
  });

  it('survives the client itself throwing on a secondary call', async () => {
    // The client never rejects, so this is a bug in our own code. It still must
    // not cost a paying customer the other four sections.
    const { provider: p } = provider({ throwFrom: 'marketValue' });
    const payload = await p.fetch(US_VIN);

    expect(payload.coverage.marketValue).toBe('unavailable');
    expect(payload.summary.recordCount).toBeGreaterThan(0);
  });

  it('stamps generatedAt as an ISO timestamp', async () => {
    const { provider: p } = provider();
    const payload = await p.fetch(US_VIN);
    expect(payload.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
