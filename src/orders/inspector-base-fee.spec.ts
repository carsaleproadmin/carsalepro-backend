import {
  INSPECTOR_BASE_FEE_MAX_CENTS,
  INSPECTOR_BASE_FEE_MIN_CENTS,
  effectiveBaseFeeCents,
  inspectorBaseFeeBounds,
} from './inspector-base-fee';

/*
 * DEN-213. The one number an inspector may move, and the window it lives in.
 */

const PLATFORM = 3900; // 39.00 EUR, the platform base today.

describe('inspectorBaseFeeBounds', () => {
  it('is the flat window the owner set: 5 to 500 EUR', () => {
    expect(inspectorBaseFeeBounds()).toEqual({ minCents: 500, maxCents: 50_000 });
  });

  it('does not follow the platform base', () => {
    /*
     * It did until 2026-08-28, as +/-30 % around it. Stated as its own test
     * because the two models are indistinguishable from a single passing case
     * at the default base, and this is what tells the next reader which one is
     * in force.
     */
    expect(inspectorBaseFeeBounds()).toEqual(inspectorBaseFeeBounds());
    expect(INSPECTOR_BASE_FEE_MIN_CENTS).toBe(500);
    expect(INSPECTOR_BASE_FEE_MAX_CENTS).toBe(50_000);
  });

  it('does not start at zero', () => {
    // A zero base is not a discount - it is an inspector working the travel fee
    // alone, which is how somebody buys the queue at a loss.
    expect(inspectorBaseFeeBounds().minCents).toBeGreaterThan(0);
  });
});

describe('effectiveBaseFeeCents', () => {
  it('uses the platform base when the inspector has set none', () => {
    expect(effectiveBaseFeeCents(null, PLATFORM)).toBe(PLATFORM);
    expect(effectiveBaseFeeCents(undefined, PLATFORM)).toBe(PLATFORM);
  });

  it('uses the inspector base inside the window', () => {
    expect(effectiveBaseFeeCents(500, PLATFORM)).toBe(500);
    expect(effectiveBaseFeeCents(4500, PLATFORM)).toBe(4500);
    expect(effectiveBaseFeeCents(50_000, PLATFORM)).toBe(50_000);
  });

  it('CLAMPS a stored value that has fallen outside, rather than refusing it', () => {
    /*
     * The bound moves - an operator edits it, a region gets its own - and a
     * number that was legal when it was typed must not take the inspector out
     * of dispatch weeks later without a word. Refusal belongs where the number
     * is typed, with a person present to be told.
     */
    expect(effectiveBaseFeeCents(90_000, PLATFORM)).toBe(50_000);
    expect(effectiveBaseFeeCents(100, PLATFORM)).toBe(500);
    expect(effectiveBaseFeeCents(0, PLATFORM)).toBe(500);
  });

  it('ignores a value that is not a number', () => {
    expect(effectiveBaseFeeCents(Number.NaN, PLATFORM)).toBe(PLATFORM);
  });

  it('never returns a fee outside the window it publishes', () => {
    const { minCents, maxCents } = inspectorBaseFeeBounds();
    for (let cents = -5000; cents <= 120_000; cents += 977) {
      const effective = effectiveBaseFeeCents(cents, PLATFORM);
      expect(effective).toBeGreaterThanOrEqual(minCents);
      expect(effective).toBeLessThanOrEqual(maxCents);
    }
  });
});
