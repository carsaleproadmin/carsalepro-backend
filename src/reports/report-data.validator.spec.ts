import { normalizeReportData } from './report-data.validator';

describe('normalizeReportData (DEN-434)', () => {
  it('rounds the engine volume to one decimal', () => {
    expect(normalizeReportData({ vehicle: { engineVolumeL: 1.968 } })).toEqual({
      vehicle: { engineVolumeL: 2 },
    });
    expect(normalizeReportData({ vehicle: { engineVolumeL: 1.64 } })).toEqual({
      vehicle: { engineVolumeL: 1.6 },
    });
  });

  it('keeps every other key', () => {
    const data = { vehicle: { make: 'VW', engineVolumeL: 1.42 }, damages: [] };
    expect(normalizeReportData(data)).toEqual({
      vehicle: { make: 'VW', engineVolumeL: 1.4 },
      damages: [],
    });
  });

  it('does not change the input object', () => {
    const data = { vehicle: { engineVolumeL: 1.968 } };
    normalizeReportData(data);
    expect(data.vehicle.engineVolumeL).toBe(1.968);
  });

  it('returns a payload without a numeric engine volume unchanged', () => {
    for (const data of [
      undefined,
      null,
      [],
      {},
      { vehicle: null },
      { vehicle: [] },
      { vehicle: { engineVolumeL: '2.0' } },
      { vehicle: { make: 'VW' } },
    ]) {
      expect(normalizeReportData(data)).toBe(data);
    }
  });
});
