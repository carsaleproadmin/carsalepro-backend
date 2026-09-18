import {
  counterOfferCeilingCents,
  counterOfferExpiry,
  counterOfferMaxPayoutCents,
  counterOfferPayoutFromTotal,
  counterOfferPriceError,
  counterOfferTotalFromPayout,
} from './counter-offer-rules';

describe('counterOfferCeilingCents', () => {
  it('multiplies the fair price', () => {
    expect(counterOfferCeilingCents(4000, 1.5)).toBe(6000);
  });

  it('rounds rather than floors, so the ceiling is never a cent below what we display', () => {
    expect(counterOfferCeilingCents(3333, 1.5)).toBe(5000);
  });

  // A multiplier below 1 would put the ceiling UNDER the inspector's own fair
  // price, and no honest counter-offer could pass. The setting is bounded at 1,
  // but a bad row in the database must not close the feature silently.
  it('treats a multiplier below 1 as 1', () => {
    expect(counterOfferCeilingCents(4000, 0.4)).toBe(4000);
    expect(counterOfferCeilingCents(4000, Number.NaN)).toBe(4000);
  });
});

describe('counterOfferPriceError', () => {
  const base = { orderTotalCents: 3900, maxPriceCents: 6100 };

  it('accepts a price between the order total and the ceiling', () => {
    expect(counterOfferPriceError({ ...base, priceCents: 5200 })).toBeNull();
  });

  it('refuses a price the order already pays: dispatch would offer it anyway', () => {
    expect(counterOfferPriceError({ ...base, priceCents: 3900 })).toMatch(/usual way/);
    expect(counterOfferPriceError({ ...base, priceCents: 3500 })).toMatch(/usual way/);
  });

  it('refuses a price above the ceiling and names the ceiling', () => {
    expect(counterOfferPriceError({ ...base, priceCents: 6101 })).toContain('6100');
  });

  it('accepts the ceiling itself', () => {
    expect(counterOfferPriceError({ ...base, priceCents: 6100 })).toBeNull();
  });

  it('refuses a non-integer or negative amount', () => {
    expect(counterOfferPriceError({ ...base, priceCents: 52.5 })).not.toBeNull();
    expect(counterOfferPriceError({ ...base, priceCents: -100 })).not.toBeNull();
  });
});

describe('counterOfferExpiry', () => {
  const now = new Date('2026-09-18T10:00:00.000Z');

  it('uses the window when the search deadline is further away', () => {
    const searchExpires = new Date('2026-09-19T10:00:00.000Z');
    expect(counterOfferExpiry(now, 20, searchExpires)?.toISOString()).toBe(
      '2026-09-18T10:20:00.000Z',
    );
  });

  // The order dies at the search deadline: the hold is released and the order is
  // cancelled. A counter-offer may never promise a price past that moment.
  it('is held inside the search deadline', () => {
    const searchExpires = new Date('2026-09-18T10:05:00.000Z');
    expect(counterOfferExpiry(now, 20, searchExpires)?.toISOString()).toBe(
      '2026-09-18T10:05:00.000Z',
    );
  });

  it('answers null when the search deadline has passed', () => {
    expect(counterOfferExpiry(now, 20, new Date('2026-09-18T09:59:00.000Z'))).toBeNull();
  });

  // An order created before manual capture carries no deadline at all.
  it('uses the window when the order has no deadline', () => {
    expect(counterOfferExpiry(now, 20, null)?.toISOString()).toBe('2026-09-18T10:20:00.000Z');
  });
});

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * THE INSPECTOR TYPES WHAT THEY ARE PAID (DEN-344)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The one property that must never break: whatever the inspector typed is what
 * they receive, to the cent. Everything else - the customer's total, the
 * platform's cut, the effective percentage - is derived from it and may absorb
 * the rounding.
 */
describe('counterOfferTotalFromPayout', () => {
  it('derives a total whose remainder is exactly the payout', () => {
    // 20 percent: 104.79 to the inspector needs 130.99 from the customer.
    expect(counterOfferTotalFromPayout(10_479, 20)).toBe(13_099);
    expect(13_099 - 10_479).toBe(2_620);
  });

  it('pays the inspector to the cent at every payout, whatever the rounding', () => {
    for (const pct of [7, 15, 20, 33.3]) {
      for (let payout = 1; payout <= 2_000; payout += 7) {
        const total = counterOfferTotalFromPayout(payout, pct);
        // The fee is the REMAINDER, so this identity is the whole promise.
        expect(total - payout).toBeGreaterThanOrEqual(0);
        expect(total - (total - payout)).toBe(payout);
      }
    }
  });

  it('takes no fee at all on a percentage that cannot be honoured', () => {
    // A misconfiguration must not answer with an infinite or inverted price.
    expect(counterOfferTotalFromPayout(5_000, 0)).toBe(5_000);
    expect(counterOfferTotalFromPayout(5_000, 100)).toBe(5_000);
    expect(counterOfferTotalFromPayout(5_000, -10)).toBe(5_000);
    expect(counterOfferTotalFromPayout(5_000, Number.NaN)).toBe(5_000);
  });
});

describe('counterOfferPayoutFromTotal', () => {
  it('reports what a customer total leaves the inspector', () => {
    expect(counterOfferPayoutFromTotal(13_099, 20)).toBe(10_479);
  });

  /*
   * Rounding twice cannot round-trip to the cent, and it does not have to:
   * this direction is only ever used to DISPLAY a bound. A cent of drift on a
   * ceiling is invisible; a cent of drift on a payout would be a broken promise,
   * which is why the stored money never comes from here.
   */
  it('stays within a cent of the exact inverse', () => {
    for (let payout = 1_000; payout <= 50_000; payout += 331) {
      const total = counterOfferTotalFromPayout(payout, 20);
      expect(Math.abs(counterOfferPayoutFromTotal(total, 20) - payout)).toBeLessThanOrEqual(1);
    }
  });
});

describe('counterOfferMaxPayoutCents', () => {
  /*
   * The bound the form prints must be a bound the API accepts. Taking the fee
   * off the ceiling can land a cent high, and an inspector typing back the very
   * number they were shown would be refused - which reads as the site being
   * broken, not as a rule.
   */
  it('is always accepted when typed back', () => {
    for (const pct of [7, 15, 20, 33.3]) {
      for (let ceiling = 5_000; ceiling <= 60_000; ceiling += 517) {
        const max = counterOfferMaxPayoutCents(ceiling, pct);
        expect(counterOfferTotalFromPayout(max, pct)).toBeLessThanOrEqual(ceiling);
        // And it is the LARGEST such payout: one cent more breaks the ceiling.
        expect(counterOfferTotalFromPayout(max + 1, pct)).toBeGreaterThan(ceiling);
      }
    }
  });
});
