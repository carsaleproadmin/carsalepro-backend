import {
  INSPECTOR_BASE_FEE_TOLERANCE_PERCENT,
  effectiveBaseFeeCents,
  inspectorBaseFeeBounds,
} from './inspector-base-fee';

/*
 * DEN-213. The one number an inspector may move, and the window it lives in.
 */

const PLATFORM = 3900; // 39.00 EUR, the platform base today.

describe('inspectorBaseFeeBounds', () => {
  it('is the platform base plus and minus the tolerance', () => {
    expect(inspectorBaseFeeBounds(PLATFORM)).toEqual({ minCents: 2730, maxCents: 5070 });
  });

  it('follows the base rather than a fixed span in euros', () => {
    // The point of a percentage: a regional tariff of 20 EUR gets a 6 EUR
    // window, not the 11.70 EUR window that fits a 39 EUR base.
    expect(inspectorBaseFeeBounds(2000)).toEqual({ minCents: 1400, maxCents: 2600 });
  });

  it('collapses to a single value when the tolerance is zero', () => {
    expect(inspectorBaseFeeBounds(PLATFORM, 0)).toEqual({
      minCents: PLATFORM,
      maxCents: PLATFORM,
    });
  });
});

describe('effectiveBaseFeeCents', () => {
  it('uses the platform base when the inspector has set none', () => {
    expect(effectiveBaseFeeCents(null, PLATFORM)).toBe(PLATFORM);
    expect(effectiveBaseFeeCents(undefined, PLATFORM)).toBe(PLATFORM);
  });

  it('uses the inspector base inside the window', () => {
    expect(effectiveBaseFeeCents(4500, PLATFORM)).toBe(4500);
    expect(effectiveBaseFeeCents(2730, PLATFORM)).toBe(2730);
    expect(effectiveBaseFeeCents(5070, PLATFORM)).toBe(5070);
  });

  it('CLAMPS a stored value that has fallen outside, rather than refusing it', () => {
    /*
     * The bound moves - a regional tariff changes, an operator edits the
     * tolerance - and a number that was legal when it was typed must not take
     * the inspector out of dispatch weeks later without a word. Refusal belongs
     * where the number is typed, with a person present to be told.
     */
    expect(effectiveBaseFeeCents(9900, PLATFORM)).toBe(5070);
    expect(effectiveBaseFeeCents(100, PLATFORM)).toBe(2730);
  });

  it('ignores a value that is not a number', () => {
    expect(effectiveBaseFeeCents(Number.NaN, PLATFORM)).toBe(PLATFORM);
  });

  it('never returns a fee outside the window it publishes', () => {
    const { minCents, maxCents } = inspectorBaseFeeBounds(PLATFORM);
    for (let cents = -5000; cents <= 20000; cents += 137) {
      const effective = effectiveBaseFeeCents(cents, PLATFORM);
      expect(effective).toBeGreaterThanOrEqual(minCents);
      expect(effective).toBeLessThanOrEqual(maxCents);
    }
  });

  it('states its own default tolerance', () => {
    expect(INSPECTOR_BASE_FEE_TOLERANCE_PERCENT).toBe(30);
  });
});
