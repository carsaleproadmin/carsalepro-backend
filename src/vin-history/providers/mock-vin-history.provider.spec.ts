// Category: PROVIDER CONTRACT. Pure — no DB, no R2, no Nest container.
import { Logger } from '@nestjs/common';
import { MockVinHistoryProvider } from './mock-vin-history.provider';

const VIN = 'WAUZZZ8V8MA012345';

function provider(nodeEnv = 'test', allowSyntheticSale = false): MockVinHistoryProvider {
  return new MockVinHistoryProvider(nodeEnv, allowSyntheticSale);
}

describe('MockVinHistoryProvider — preview counts', () => {
  it('answers with the length of every array it just built', async () => {
    /*
     * The root cause of five hardcoded zeros on the free preview page.
     *
     * `preview()` used to return `payload.summary` and throw the arrays away,
     * and the summary type has no per-array counters — so the service had
     * nothing to answer with and filled in 0. The fix is this assertion: the
     * counts ARE the array lengths, checked against the very payload the paid
     * report is built from.
     */
    const p = provider();
    const [preview, payload] = await Promise.all([p.preview(VIN), p.fetch(VIN)]);

    expect(preview.mileageRecordCount).toBe(payload.mileageRecords.length);
    expect(preview.damageRecordCount).toBe(payload.damageRecords.length);
    expect(preview.registrationCount).toBe(payload.registrations.length);
    expect(preview.recallCount).toBe(payload.recalls.length);
    expect(preview.inspectionCount).toBe(payload.inspections.length);
  });

  it('still carries the whole summary', async () => {
    const p = provider();
    const [preview, payload] = await Promise.all([p.preview(VIN), p.fetch(VIN)]);
    expect(preview.recordCount).toBe(payload.summary.recordCount);
    expect(preview.ownersCount).toBe(payload.owners.length);
    expect(preview.countriesSeen).toEqual(payload.summary.countriesSeen);
    expect(preview.hasOdometerRollback).toBe(payload.summary.hasOdometerRollback);
  });

  it('does not confuse the registration count with the country count', async () => {
    /*
     * The service used to substitute `countriesSeen.length` for the
     * registration count whenever the cache was cold. It coincided in the mock
     * — one registration per country — and is simply wrong for a car
     * registered twice in one country, which is the common case after a move.
     */
    const p = provider();
    const vins = Array.from({ length: 40 }, (_, i) => `WAUZZZ8V8MA0123${String(i).padStart(2, '0')}`);
    const results = await Promise.all(
      vins.map(async (vin) => {
        const payload = await p.fetch(vin);
        return {
          registrations: payload.registrations.length,
          countries: payload.summary.countriesSeen.length,
        };
      }),
    );
    // Every VIN must have at least one registration…
    expect(results.every((r) => r.registrations >= 1)).toBe(true);
    // …and the two numbers are not the same fact, whatever the mock happens to
    // generate today.
    expect(results.every((r) => r.registrations >= r.countries)).toBe(true);
  });

  it('is deterministic — two previews of one VIN agree exactly', async () => {
    const p = provider();
    expect(await p.preview(VIN)).toEqual(await p.preview(VIN));
  });

  it('never returns null counts — it holds the arrays, so it knows', async () => {
    // `null` is reserved for a provider that does not publish a number. The
    // mock has no such excuse.
    const preview = await provider().preview(VIN);
    for (const value of [
      preview.mileageRecordCount,
      preview.damageRecordCount,
      preview.registrationCount,
      preview.recallCount,
      preview.inspectionCount,
    ]) {
      expect(typeof value).toBe('number');
    }
  });
});

describe('MockVinHistoryProvider — selling generated data', () => {
  it('is sellable outside production', () => {
    expect(provider('development').configured).toBe(true);
    expect(provider('test').configured).toBe(true);
  });

  it('refuses to back a paid unlock in production by default', () => {
    // 19.99 EUR for invented history about someone's car.
    expect(provider('production').configured).toBe(false);
  });

  it('sells in production only when an operator opted in explicitly', () => {
    expect(provider('production', true).configured).toBe(true);
  });

  it('keeps the synthetic mark on regardless of the flag', async () => {
    // The flag decides whether the data may be SOLD. It never decides whether
    // the buyer is told what they bought.
    for (const p of [provider('production'), provider('production', true), provider('test')]) {
      expect(p.synthetic).toBe(true);
      expect((await p.fetch(VIN)).synthetic).toBe(true);
      expect((await p.fetch(VIN)).provider).toBe('mock');
    }
  });

  it('warns loudly at startup when the flag is on in production', () => {
    // The one line an operator gets to notice that real money is being taken
    // for generated data. Silence here is how it stays on by accident.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      provider('production', true);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/VIN_HISTORY_ALLOW_SYNTHETIC_SALE/);

      warn.mockClear();
      provider('production');
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/VIN_HISTORY_ALLOW_SYNTHETIC_SALE/);
    } finally {
      warn.mockRestore();
    }
  });
});
