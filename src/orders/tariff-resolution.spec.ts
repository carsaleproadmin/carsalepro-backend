// Category: MONEY MATHS. Pure resolution, no DB, no network, no Nest container.
import { PricingTariff } from './order-pricing';
import { exceedsCap, resolveTariff } from './tariff-resolution';

/** The shipped global tariff, in cents — see platform-settings.constants.ts. */
const GLOBAL: PricingTariff = {
  baseFeeCents: 3900,
  ratePerKmCents: 60,
  ratePerMinuteCents: 35,
  minimumFareCents: 4900,
  platformFeePercent: 20,
  surgeMultiplier: 1,
  returnTripFactor: 1,
};

const resolve = (
  zone: Parameters<typeof resolveTariff>[1] = null,
  country: Parameters<typeof resolveTariff>[2] = null,
) => resolveTariff(GLOBAL, zone, country);

describe('resolveTariff', () => {
  // The state this ships in. An empty database must price exactly as today.
  it('falls through to the global tariff when nothing is configured', () => {
    const r = resolve();

    expect(r.tariff).toEqual(GLOBAL);
    expect(r.limits).toEqual({ capKm: null });
    expect(new Set(Object.values(r.sources))).toEqual(new Set(['global']));
  });

  it('takes a band value over the global one', () => {
    const r = resolve({ perKmCents: 30, returnTripFactor: 2 });

    expect(r.tariff.ratePerKmCents).toBe(30);
    expect(r.tariff.returnTripFactor).toBe(2);
    expect(r.sources.perKmCents).toBe('zone');
    // Untouched terms still come from the global tariff, not from a copy.
    expect(r.tariff.baseFeeCents).toBe(3900);
    expect(r.sources.baseFeeCents).toBe('global');
  });

  it('takes a country value over its band', () => {
    const r = resolve({ perKmCents: 30, baseFeeCents: 2900 }, { perKmCents: 50 });

    expect(r.tariff.ratePerKmCents).toBe(50);
    expect(r.sources.perKmCents).toBe('country');
    // The band still answers for what the country did not mention.
    expect(r.tariff.baseFeeCents).toBe(2900);
    expect(r.sources.baseFeeCents).toBe('zone');
  });

  // Field by field is the design: a country overriding one term must not have
  // to restate the rest, because a restated value stops tracking the original.
  it('mixes all three levels in one resolution', () => {
    const r = resolve(
      { perKmCents: 30, minimumFareCents: 3900 },
      { baseFeeCents: 1900 },
    );

    expect(r.sources.baseFeeCents).toBe('country');
    expect(r.sources.perKmCents).toBe('zone');
    expect(r.sources.ratePerMinuteCents).toBe('global');
    expect(r.tariff.baseFeeCents).toBe(1900);
    expect(r.tariff.ratePerKmCents).toBe(30);
    expect(r.tariff.ratePerMinuteCents).toBe(35);
    expect(r.tariff.minimumFareCents).toBe(3900);
  });

  it('reads null as silence, not as zero', () => {
    const r = resolve({ perKmCents: null, baseFeeCents: undefined });

    expect(r.tariff.ratePerKmCents).toBe(60);
    expect(r.sources.perKmCents).toBe('global');
  });

  // A zero IS a decision — a band may genuinely charge nothing for travel — so
  // it must not be confused with an absent value.
  it('honours an explicit zero', () => {
    const r = resolve({ perKmCents: 0 });

    expect(r.tariff.ratePerKmCents).toBe(0);
    expect(r.sources.perKmCents).toBe('zone');
  });

  // A broken row must not price an order. Inheriting is the safe answer.
  it('ignores a non-finite override', () => {
    const r = resolve({ perKmCents: Number.NaN }, { baseFeeCents: Number.POSITIVE_INFINITY });

    expect(r.tariff.ratePerKmCents).toBe(60);
    expect(r.tariff.baseFeeCents).toBe(3900);
  });

  it('leaves terms a region cannot override alone', () => {
    const r = resolve({ perKmCents: 30 });

    expect(r.tariff.platformFeePercent).toBe(GLOBAL.platformFeePercent);
    expect(r.tariff.surgeMultiplier).toBe(GLOBAL.surgeMultiplier);
  });

  it('carries the cap out as a limit', () => {
    const r = resolve(null, { capKm: 150 });

    expect(r.limits).toEqual({ capKm: 150 });
  });
});

describe('exceedsCap', () => {
  it('never refuses when no cap is set', () => {
    expect(exceedsCap(400, null)).toBe(false);
    expect(exceedsCap(400, 0)).toBe(false);
  });

  it('refuses beyond the cap and allows the cap itself', () => {
    expect(exceedsCap(150.1, 150)).toBe(true);
    expect(exceedsCap(150, 150)).toBe(false);
  });
});
