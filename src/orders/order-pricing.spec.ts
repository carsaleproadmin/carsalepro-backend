// Category: MONEY MATHS. Pure arithmetic, no DB, no network, no Nest container.
import { PricingTariff, computePrice, isPeak } from './order-pricing';

/** The shipped defaults, in cents — see platform-settings.constants.ts. */
const TARIFF: PricingTariff = {
  baseFeeCents: 3900,
  ratePerKmCents: 60,
  ratePerMinuteCents: 35,
  minimumFareCents: 4900,
  platformFeePercent: 20,
  surgeMultiplier: 1,
  peakMultiplier: 1,
  peakStartHour: 16,
  peakEndHour: 19,
};

/** Noon on a Wednesday — comfortably outside the default peak window. */
const OFF_PEAK = new Date(2026, 6, 1, 12, 0, 0);

function price(distanceKm: number, durationMin: number, tariff: Partial<PricingTariff> = {}, when = OFF_PEAK) {
  return computePrice({
    distanceKm,
    durationMin,
    scheduledAt: when,
    tariff: { ...TARIFF, ...tariff },
  });
}

describe('computePrice', () => {
  describe('the documented worked examples', () => {
    it('5 km / 10 min lands under the floor and is raised to the minimum fare', () => {
      const p = price(5, 10);
      expect(p.distanceFeeCents).toBe(300);
      expect(p.timeFeeCents).toBe(350);
      expect(p.subtotalCents).toBe(4550);
      expect(p.minimumFareApplied).toBe(true);
      expect(p.minimumFareTopUpCents).toBe(350);
      expect(p.totalCents).toBe(4900);
    });

    it('20 km / 25 min clears the floor', () => {
      const p = price(20, 25);
      expect(p.subtotalCents).toBe(3900 + 1200 + 875);
      expect(p.totalCents).toBe(5975);
      expect(p.minimumFareApplied).toBe(false);
      expect(p.minimumFareTopUpCents).toBe(0);
    });

    it('50 km / 45 min', () => {
      expect(price(50, 45).totalCents).toBe(8475);
    });

    it('undercuts the previous flat tariff (50 EUR + 1.50/km) on all three', () => {
      const oldFare = (km: number) => 5000 + Math.round(km * 150);
      expect(price(5, 10).totalCents).toBeLessThan(oldFare(5));
      expect(price(20, 25).totalCents).toBeLessThan(oldFare(20));
      expect(price(50, 45).totalCents).toBeLessThan(oldFare(50));
    });
  });

  describe('the minimum fare', () => {
    it('does not engage when the fare exactly equals the floor', () => {
      // base 4900, no distance, no time → exactly the floor.
      const p = price(0, 0, { baseFeeCents: 4900 });
      expect(p.totalCents).toBe(4900);
      expect(p.minimumFareApplied).toBe(false);
      expect(p.minimumFareTopUpCents).toBe(0);
    });

    it('engages one cent below the floor', () => {
      const p = price(0, 0, { baseFeeCents: 4899 });
      expect(p.minimumFareApplied).toBe(true);
      expect(p.minimumFareTopUpCents).toBe(1);
      expect(p.totalCents).toBe(4900);
    });

    it('is reported as its own line, never folded into another', () => {
      const p = price(1, 1);
      expect(p.subtotalCents + p.surgeFeeCents + p.minimumFareTopUpCents).toBe(p.totalCents);
    });
  });

  describe('surge and peak', () => {
    it('is inert at 1.0 and reports a zero surge line', () => {
      const p = price(20, 25);
      expect(p.surgeMultiplier).toBe(1);
      expect(p.surgeFeeCents).toBe(0);
      expect(p.peakApplied).toBe(false);
    });

    it('applies the manual surge lever', () => {
      const p = price(20, 25, { surgeMultiplier: 1.5 });
      expect(p.subtotalCents).toBe(5975);
      expect(p.totalCents).toBe(Math.round(5975 * 1.5));
      expect(p.surgeFeeCents).toBe(p.totalCents - 5975);
    });

    it('compounds surge with peak inside the window', () => {
      const inPeak = new Date(2026, 6, 1, 17, 30, 0);
      const p = price(20, 25, { surgeMultiplier: 1.2, peakMultiplier: 1.5 }, inPeak);
      expect(p.peakApplied).toBe(true);
      expect(p.surgeMultiplier).toBeCloseTo(1.8, 10);
      expect(p.totalCents).toBe(Math.round(5975 * 1.8));
    });

    it('ignores the peak multiplier outside the window', () => {
      const p = price(20, 25, { peakMultiplier: 2 }, OFF_PEAK);
      expect(p.peakApplied).toBe(false);
      expect(p.totalCents).toBe(5975);
    });

    it('treats a nonsensical multiplier as off rather than free', () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const p = price(20, 25, { surgeMultiplier: bad });
        expect(p.totalCents).toBe(5975);
      }
    });
  });

  describe('the platform split', () => {
    it('always reconciles: platformFee + inspectorShare === total', () => {
      // Fuzz across the whole plausible input space; the split is derived from
      // the final total precisely so this can never drift by a cent.
      let seed = 1;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let i = 0; i < 2000; i++) {
        const p = price(rnd() * 200, rnd() * 180, {
          platformFeePercent: Math.round(rnd() * 100),
          surgeMultiplier: 1 + rnd(),
          baseFeeCents: Math.round(rnd() * 10000),
        });
        expect(p.platformFeeCents + p.inspectorShareCents).toBe(p.totalCents);
        expect(p.platformFeeCents).toBeGreaterThanOrEqual(0);
        expect(p.inspectorShareCents).toBeGreaterThanOrEqual(0);
      }
    });

    it('clamps a percentage outside 0–100', () => {
      expect(price(20, 25, { platformFeePercent: 250 }).inspectorShareCents).toBe(0);
      expect(price(20, 25, { platformFeePercent: -5 }).platformFeeCents).toBe(0);
    });
  });

  describe('degenerate inputs', () => {
    it('never produces NaN or a negative total', () => {
      for (const [km, min] of [
        [0, 0],
        [-5, -5],
        [Number.NaN, Number.NaN],
        [Number.POSITIVE_INFINITY, 0],
      ] as Array<[number, number]>) {
        const p = price(km, min);
        expect(Number.isFinite(p.totalCents)).toBe(true);
        expect(p.totalCents).toBeGreaterThanOrEqual(0);
      }
    });

    it('rounds each component once, at the cents boundary', () => {
      // 3.33 km × 60 c/km = 199.8 → 200, not 199 and not a fractional cent.
      const p = price(3.33, 0, { baseFeeCents: 0, minimumFareCents: 0 });
      expect(p.distanceFeeCents).toBe(200);
      expect(Number.isInteger(p.totalCents)).toBe(true);
    });
  });
});

describe('isPeak', () => {
  const at = (hour: number) => new Date(2026, 6, 1, hour, 0, 0);

  it('is inclusive of the start hour and exclusive of the end hour', () => {
    expect(isPeak(at(15), 16, 19)).toBe(false);
    expect(isPeak(at(16), 16, 19)).toBe(true);
    expect(isPeak(at(18), 16, 19)).toBe(true);
    expect(isPeak(at(19), 16, 19)).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(isPeak(at(23), 22, 2)).toBe(true);
    expect(isPeak(at(1), 22, 2)).toBe(true);
    expect(isPeak(at(2), 22, 2)).toBe(false);
    expect(isPeak(at(12), 22, 2)).toBe(false);
  });

  it('treats an empty window as "no peak", not "all day"', () => {
    // A mistyped window must fail safe rather than surcharge every booking.
    for (let h = 0; h < 24; h++) expect(isPeak(at(h), 16, 16)).toBe(false);
  });

  it('is false for non-finite bounds', () => {
    expect(isPeak(at(17), Number.NaN, 19)).toBe(false);
  });
});
