// Category: MONEY MATHS. Pure arithmetic, no DB, no network, no Nest container.
import { PricingTariff, computePrice, describeStoredFare, isPeak } from './order-pricing';

/** The shipped defaults, in cents — see platform-settings.constants.ts. */
const TARIFF: PricingTariff = {
  baseFeeCents: 3900,
  ratePerKmCents: 30,
  ratePerMinuteCents: 35,
  minimumFareCents: 4900,
  platformFeePercent: 20,
  surgeMultiplier: 1,
  peakMultiplier: 1,
  peakStartHour: 16,
  peakEndHour: 19,
  returnTripFactor: 2,
  freeRadiusKm: 10,
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
    // Each distance is one direction. The 10 km free radius comes off first,
    // and what remains is charged both ways — which is why the first example
    // carries no travel charge at all and the second bills 20 km.
    it('5 km / 10 min is inside the free radius and is raised to the minimum fare', () => {
      const p = price(5, 10);
      expect(p.chargeableDistanceKm).toBe(0);
      expect(p.distanceFeeCents).toBe(0);
      expect(p.timeFeeCents).toBe(700);
      expect(p.subtotalCents).toBe(4600);
      expect(p.minimumFareApplied).toBe(true);
      expect(p.minimumFareTopUpCents).toBe(300);
      expect(p.totalCents).toBe(4900);
    });

    it('20 km / 25 min clears the floor, billing 10 chargeable km both ways', () => {
      const p = price(20, 25);
      expect(p.chargeableDistanceKm).toBe(10);
      expect(p.billedDistanceKm).toBe(20);
      expect(p.subtotalCents).toBe(3900 + 600 + 1750);
      expect(p.totalCents).toBe(6250);
      expect(p.minimumFareApplied).toBe(false);
      expect(p.minimumFareTopUpCents).toBe(0);
    });

    it('50 km / 45 min bills 40 chargeable km both ways', () => {
      expect(price(50, 45).totalCents).toBe(9450);
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
      expect(p.subtotalCents).toBe(6250);
      expect(p.totalCents).toBe(Math.round(6250 * 1.5));
      expect(p.surgeFeeCents).toBe(p.totalCents - 6250);
    });

    it('compounds surge with peak inside the window', () => {
      const inPeak = new Date(2026, 6, 1, 17, 30, 0);
      const p = price(20, 25, { surgeMultiplier: 1.2, peakMultiplier: 1.5 }, inPeak);
      expect(p.peakApplied).toBe(true);
      expect(p.surgeMultiplier).toBeCloseTo(1.8, 10);
      expect(p.totalCents).toBe(Math.round(6250 * 1.8));
    });

    it('ignores the peak multiplier outside the window', () => {
      const p = price(20, 25, { peakMultiplier: 2 }, OFF_PEAK);
      expect(p.peakApplied).toBe(false);
      expect(p.totalCents).toBe(6250);
    });

    it('treats a nonsensical multiplier as off rather than free', () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const p = price(20, 25, { surgeMultiplier: bad });
        expect(p.totalCents).toBe(6250);
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

  describe('the return trip', () => {
    // The free radius is switched off in this block so the assertions are about
    // the factor alone.
    it('charges both directions at the shipped factor of 2, reporting both distances', () => {
      const p = price(20, 25, { freeRadiusKm: 0 });
      expect(p.returnTripFactor).toBe(2);
      expect(p.distanceKm).toBe(20); // still what the provider measured
      expect(p.billedDistanceKm).toBe(40);
      expect(p.billedDurationMin).toBe(50);
      expect(p.distanceFeeCents).toBe(1200);
      expect(p.timeFeeCents).toBe(1750);
    });

    it('charges one direction at a factor of 1, the legacy shape', () => {
      const p = price(20, 25, { returnTripFactor: 1, ratePerKmCents: 60, freeRadiusKm: 0 });
      expect(p.billedDistanceKm).toBe(20);
      expect(p.billedDurationMin).toBe(25);
      expect(p.distanceFeeCents).toBe(1200);
    });

    // The whole point of the pairing: halving the rate and doubling the trip
    // leave the customer paying the same. Either half alone moves the fare by
    // two, which is why the tariff carries the factor instead of the code.
    it('bills the same kilometre charge as the old one-direction tariff did', () => {
      const legacy = price(30, 40, { ratePerKmCents: 60, returnTripFactor: 1, freeRadiusKm: 0 });
      const shipped = price(30, 40, { freeRadiusKm: 0 });
      expect(shipped.distanceFeeCents).toBe(legacy.distanceFeeCents);
    });

    it('refuses a factor below 1 rather than selling a shorter trip', () => {
      for (const bad of [0, 0.5, -2, Number.NaN]) {
        const p = price(20, 25, { returnTripFactor: bad, freeRadiusKm: 0 });
        expect(p.returnTripFactor).toBe(1);
        expect(p.billedDistanceKm).toBe(20);
      }
    });

    // The billed distance is quoted on the invoice, so it must be a number that
    // can be printed: 12.35 × 2 = 24.7, never 24.700000000000003.
    // Both distances are printed on the invoice, so both must be printable:
    // never 24.700000000000003. The chargeable distance is rounded where it is
    // quoted — before the factor — and the factor then multiplies a clean
    // figure, so 12.35 reads as 12.4 charged one way and 24.8 charged both.
    it('keeps both distances at the 0.1 km the provider reports', () => {
      const p = price(12.35, 1, { returnTripFactor: 2, freeRadiusKm: 0 });
      expect(p.chargeableDistanceKm).toBe(12.4);
      expect(p.billedDistanceKm).toBe(24.8);
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
      // 3.3 km × 61 c/km = 201.3 → 201, not 202 and not a fractional cent.
      //
      // The distance carries ONE decimal because that is all a distance can
      // carry now: the billed distance is rounded to the 0.1 km both routing
      // paths report, and the fee is computed from that rounded figure so the
      // quantity on the invoice is the quantity the rate multiplied. The
      // fractional cent therefore has to come from the rate.
      // The factor is switched off too, so the fractional cent is not doubled
      // away before it can be observed.
      const p = price(3.3, 0, {
        baseFeeCents: 0,
        minimumFareCents: 0,
        ratePerKmCents: 61,
        freeRadiusKm: 0,
        returnTripFactor: 1,
      });
      expect(p.distanceFeeCents).toBe(201);
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

/*
 * Reading a stored order back. Every case here is a ROUND TRIP through
 * `computePrice`: the quote and the order page describe one inspection, and a
 * customer who compares the two is the only reader that matters.
 */
describe('describeStoredFare', () => {
  /** Store a priced quote the way `insertOrder` does, then read it back. */
  const roundTrip = (distanceKm: number, durationMin: number, tariff: Partial<PricingTariff> = {}) => {
    const p = price(distanceKm, durationMin, tariff);
    return {
      quote: p,
      stored: describeStoredFare({
        billedDistanceKm: p.billedDistanceKm,
        returnTripFactor: p.returnTripFactor,
        freeRadiusKm: p.freeRadiusKm,
        billedDurationMin: p.billedDurationMin,
      }),
    };
  };

  it('gives the order page the same trip the quote showed', () => {
    const { quote, stored } = roundTrip(38, 57);

    expect(stored.distanceKm).toBe(quote.distanceKm);
    expect(stored.durationMin).toBe(quote.durationMin);
    expect(stored.billedDistanceKm).toBe(quote.billedDistanceKm);
    expect(stored.billedDurationMin).toBe(quote.billedDurationMin);
  });

  /*
   * The defect this function exists for. Inside the free radius the row bills
   * zero kilometres, so the measurement is GONE — 1 km and 9 km store the same
   * thing. The old derivation added the radius back regardless and answered
   * "10 km" for a car one kilometre away, on the page the customer opens right
   * after paying for a quote that said 1 km.
   */
  it('says nothing rather than the free radius when the trip was inside it', () => {
    const { quote, stored } = roundTrip(1, 3);

    expect(quote.billedDistanceKm).toBe(0);
    expect(stored.distanceKm).toBeNull();
    expect(stored.chargeableDistanceKm).toBe(0);
  });

  it('still reports the minutes of a trip inside the free radius', () => {
    // Only the DISTANCE is clamped. Reporting no travel time for an order that
    // was charged for travel time would trade one silence for another.
    const { stored } = roundTrip(1, 3);

    expect(stored.durationMin).toBe(3);
    expect(stored.billedDurationMin).toBe(6);
  });

  it('keeps the derived distance at the 0.1 km the fare was computed on', () => {
    const { quote, stored } = roundTrip(24.8, 30);

    expect(stored.distanceKm).toBe(24.8);
    expect(stored.chargeableDistanceKm).toBe(quote.chargeableDistanceKm);
  });

  /*
   * A row written before the return trip: factor 1, no radius, minutes stored
   * one-way. Every derivation must be the identity, or the whole back catalogue
   * of orders halves its distance the day this ships.
   */
  it('leaves a pre-return-trip order exactly as it was stored', () => {
    const stored = describeStoredFare({
      billedDistanceKm: 42,
      returnTripFactor: 1,
      freeRadiusKm: 0,
      billedDurationMin: 55,
    });

    expect(stored).toEqual({
      distanceKm: 42,
      chargeableDistanceKm: 42,
      billedDistanceKm: 42,
      returnTripFactor: 1,
      freeRadiusKm: 0,
      durationMin: 55,
      billedDurationMin: 55,
    });
  });

  it('survives a broken row without dividing by zero', () => {
    const stored = describeStoredFare({
      billedDistanceKm: 20,
      returnTripFactor: 0,
      freeRadiusKm: -5,
      billedDurationMin: null,
    });

    expect(stored.chargeableDistanceKm).toBe(20);
    expect(stored.freeRadiusKm).toBe(0);
    expect(stored.durationMin).toBeNull();
  });
});
