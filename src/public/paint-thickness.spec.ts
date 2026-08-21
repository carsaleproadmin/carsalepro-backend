import { averagePaintThicknessUm } from './public.service';

/*
 * The number the free preview publishes. Every case here is a shape the
 * database actually holds: `reportData` is free-form JSON on rows written by
 * older mobile builds, so the function has to answer "no number" rather than
 * throw on anything it does not recognise.
 */
describe('averagePaintThicknessUm', () => {
  it('averages the stations that were measured', () => {
    expect(
      averagePaintThicknessUm({
        thickness: { panels: [{ um: 100 }, { um: 150 }, { um: 200 }] },
      }),
    ).toBe(150);
  });

  it('rounds to a whole micrometre', () => {
    expect(
      averagePaintThicknessUm({ thickness: { panels: [{ um: 100 }, { um: 101 }] } }),
    ).toBe(101);
  });

  it('ignores a station that was skipped', () => {
    // No reading is not a reading of zero. Counting it would drag the mean
    // towards a number nobody measured.
    expect(
      averagePaintThicknessUm({
        thickness: { panels: [{ um: 120 }, { panelId: 'roof' }, { um: 140 }] },
      }),
    ).toBe(130);
  });

  it('answers null when nothing was measured', () => {
    expect(averagePaintThicknessUm({ thickness: { panels: [] } })).toBeNull();
    expect(averagePaintThicknessUm({ thickness: {} })).toBeNull();
    expect(averagePaintThicknessUm({})).toBeNull();
  });

  it('survives a payload of the wrong shape', () => {
    expect(averagePaintThicknessUm({ thickness: 'none' as unknown as object })).toBeNull();
    expect(averagePaintThicknessUm({ thickness: { panels: 'none' } })).toBeNull();
    expect(averagePaintThicknessUm({ thickness: { panels: [null, 7] } })).toBeNull();
    expect(
      averagePaintThicknessUm({ thickness: { panels: [{ um: 'thick' }, { um: NaN }] } }),
    ).toBeNull();
  });
});
