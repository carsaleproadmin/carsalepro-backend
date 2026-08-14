/**
 * Order pricing — a pure function, deliberately free of Nest, Prisma and I/O so
 * it can be exhaustively unit-tested. `OrdersService` fetches the settings and
 * the route, then calls `computePrice`; it must not do arithmetic of its own.
 *
 * The model is ride-hailing shaped:
 *
 *   billed     = measured distance × returnTripFactor  (same for the minutes)
 *   subtotal   = base + billed km × ratePerKm + billed min × ratePerMinute
 *   multiplier = surge × (peak window ? peakMultiplier : 1)
 *   total      = max(round(subtotal × multiplier), minimumFare)
 *
 * Every amount is integer cents. Rounding happens once per component and once
 * on the surged subtotal — never on a running float.
 */

import { chargeableKm } from './tariff-resolution';

/** Tariff inputs, all integer cents except the unitless multipliers and hours. */
export interface PricingTariff {
  baseFeeCents: number;
  ratePerKmCents: number;
  ratePerMinuteCents: number;
  minimumFareCents: number;
  platformFeePercent: number;
  surgeMultiplier: number;
  peakMultiplier: number;
  /** Local hour, inclusive. */
  peakStartHour: number;
  /** Local hour, exclusive. */
  peakEndHour: number;
  /**
   * How many times the measured one-direction trip the customer pays for.
   *
   * The inspector drives to the vehicle and back, so 2 is the honest figure —
   * but it is a TARIFF field and not a constant, because it must move together
   * with `ratePerKmCents`. A rate anchored to a national tax-free mileage rate
   * (Germany: 0.30 EUR/km, §9 Abs. 1 Nr. 4a EStG) is DEFINED on the kilometres
   * driven in both directions, so it needs a factor of 2; the invented 0.60
   * this platform charges today already has the return trip folded into the
   * rate and needs 1. Ship 2 in the same change that lowers the rate, or every
   * fare doubles. See DEN-108.
   */
  returnTripFactor: number;
  /**
   * Kilometres of the one-direction trip that carry no travel charge.
   *
   * Subtracted from the distance, never used as an on/off threshold — see
   * `chargeableKm`. Below the minimum fare it is mostly invisible anyway: a
   * short trip is floored to `minimumFareCents` whether or not its kilometres
   * were charged. It earns its place by saying so out loud.
   */
  freeRadiusKm: number;
}

export interface PricingInput {
  /**
   * ONE-DIRECTION road kilometres where available, great-circle × detour factor
   * otherwise. What the routing provider measured, before `returnTripFactor`.
   */
  distanceKm: number;
  /** ONE-DIRECTION travel time in minutes. */
  durationMin: number;
  /** When the inspection is scheduled — drives the peak window. */
  scheduledAt: Date;
  tariff: PricingTariff;
}

export interface PriceBreakdown {
  baseFeeCents: number;
  /** What the provider measured, one direction. */
  distanceKm: number;
  /** The free radius that applied. 0 when every kilometre is charged. */
  freeRadiusKm: number;
  /** One direction, after the free radius: `max(0, distanceKm - freeRadiusKm)`. */
  chargeableDistanceKm: number;
  /**
   * What the fare was actually charged on:
   * `chargeableDistanceKm × returnTripFactor`.
   *
   * Both are reported because they answer different questions. The customer
   * asks how far the inspector is (`distanceKm`); the invoice and the contract
   * must state the quantity the rate multiplied (`billedDistanceKm`), or the
   * arithmetic on the page does not add up.
   */
  billedDistanceKm: number;
  returnTripFactor: number;
  distanceFeeCents: number;
  /** One direction, as measured. */
  durationMin: number;
  /** What the fare was charged on: `durationMin × returnTripFactor`. */
  billedDurationMin: number;
  timeFeeCents: number;
  /** base + distance + time, before any multiplier. */
  subtotalCents: number;
  /** surge × peak. 1 when both are off. */
  surgeMultiplier: number;
  /** The amount the multiplier added. 0 when no multiplier applies. */
  surgeFeeCents: number;
  peakApplied: boolean;
  minimumFareCents: number;
  /** What the floor added. 0 when the fare already cleared it. */
  minimumFareTopUpCents: number;
  minimumFareApplied: boolean;
  totalCents: number;
  platformFeeCents: number;
  inspectorShareCents: number;
}

/** Clamp a possibly-absent or nonsensical multiplier to something usable. */
function safeMultiplier(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

function safeNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * Is `when` inside the peak window? The window is expressed in whole local hours,
 * start inclusive and end exclusive, and may wrap past midnight (e.g. 22 → 2).
 * A start equal to the end means "no window", not "all day" — an operator who
 * wants peak pricing off should leave the multiplier at 1, and this makes a
 * mistyped window fail safe rather than surcharging everyone.
 */
export function isPeak(when: Date, startHour: number, endHour: number): boolean {
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) return false;
  const start = Math.trunc(startHour);
  const end = Math.trunc(endHour);
  if (start === end) return false;

  const hour = when.getHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function computePrice(input: PricingInput): PriceBreakdown {
  const { tariff } = input;

  const distanceKm = safeNonNegative(input.distanceKm);
  const durationMin = safeNonNegative(input.durationMin);
  const baseFeeCents = Math.max(0, Math.round(tariff.baseFeeCents));
  const minimumFareCents = Math.max(0, Math.round(tariff.minimumFareCents));

  // A factor below 1 would sell a trip shorter than the one measured, so it is
  // clamped rather than trusted; `safeMultiplier` already turns an absent or
  // nonsensical value into 1, which is the "the rate already includes the
  // return trip" case.
  const returnTripFactor = Math.max(1, safeMultiplier(tariff.returnTripFactor));
  // The free radius comes off the MEASURED one-direction trip, before the
  // return trip is applied: it is a statement about how far the vehicle is, so
  // doubling it first would halve the radius an operator thought they set.
  const freeRadiusKm = safeNonNegative(tariff.freeRadiusKm);
  const chargeableDistanceKm = chargeableKm(distanceKm, freeRadiusKm);
  // Rounded to the same 0.1 km the routing provider reports, so the number
  // printed on the invoice is the number the fee was computed from.
  const billedDistanceKm = Math.round(chargeableDistanceKm * returnTripFactor * 10) / 10;
  const billedDurationMin = Math.round(durationMin * returnTripFactor);

  const distanceFeeCents = Math.round(billedDistanceKm * safeNonNegative(tariff.ratePerKmCents));
  const timeFeeCents = Math.round(billedDurationMin * safeNonNegative(tariff.ratePerMinuteCents));
  const subtotalCents = baseFeeCents + distanceFeeCents + timeFeeCents;

  const peakApplied = isPeak(input.scheduledAt, tariff.peakStartHour, tariff.peakEndHour);
  const surgeMultiplier =
    safeMultiplier(tariff.surgeMultiplier) *
    (peakApplied ? safeMultiplier(tariff.peakMultiplier) : 1);

  const surgedCents = Math.round(subtotalCents * surgeMultiplier);
  const surgeFeeCents = surgedCents - subtotalCents;

  const totalCents = Math.max(surgedCents, minimumFareCents);
  const minimumFareTopUpCents = totalCents - surgedCents;

  // The split is derived from the FINAL total, so platformFee + inspectorShare
  // always reconciles exactly — inspectorShare is the remainder, never a second
  // rounded product.
  const platformFeePercent = Math.min(100, Math.max(0, safeNonNegative(tariff.platformFeePercent)));
  const platformFeeCents = Math.round((totalCents * platformFeePercent) / 100);
  const inspectorShareCents = totalCents - platformFeeCents;

  return {
    baseFeeCents,
    distanceKm,
    freeRadiusKm,
    chargeableDistanceKm,
    billedDistanceKm,
    returnTripFactor,
    distanceFeeCents,
    durationMin,
    billedDurationMin,
    timeFeeCents,
    subtotalCents,
    surgeMultiplier,
    surgeFeeCents,
    peakApplied,
    minimumFareCents,
    minimumFareTopUpCents,
    minimumFareApplied: minimumFareTopUpCents > 0,
    totalCents,
    platformFeeCents,
    inspectorShareCents,
  };
}

/** The quantities an `order` row stores about its trip, as read from the DB. */
export interface StoredFareRow {
  /** `order.distance_km` — the BILLED distance, both directions, after the radius. */
  billedDistanceKm: number;
  /** `order.return_trip_factor`. 1 for a row written before the return trip. */
  returnTripFactor: number;
  /** `order.free_radius_km`. */
  freeRadiusKm: number;
  /** `order.duration_min` — BILLED minutes, the same basis as the distance. */
  billedDurationMin: number | null;
}

/** What a stored order can honestly say about its trip. */
export interface StoredFare {
  /**
   * The measured one-direction trip, or **null when the row cannot answer**.
   * Never a reconstruction — see `describeStoredFare`.
   */
  distanceKm: number | null;
  /** One direction, after the free radius came off. Always recoverable. */
  chargeableDistanceKm: number;
  /** What the per-km rate multiplied. */
  billedDistanceKm: number;
  returnTripFactor: number;
  freeRadiusKm: number;
  /** The measured one-direction travel time. Null when the row has no minutes. */
  durationMin: number | null;
  /** What the per-minute rate multiplied. */
  billedDurationMin: number | null;
}

/**
 * Read a stored order's trip back out of the three columns that hold it.
 *
 * **The measured distance is not always in the row, and this function says so
 * rather than inventing one.** The column holds
 * `billed = max(0, measured - free) x factor`, and `max(0, ...)` is not
 * invertible: inside the free radius `billed` is 0 for a vehicle 1 km away and
 * for one 9 km away alike. The first version added the radius back
 * unconditionally, so every short order reported the free radius as its
 * distance — an order 1 km from the inspector was quoted at 1 km and then
 * displayed at 10 km on its own page, one minute later.
 *
 * `null` is therefore the honest answer for that case, and a caller must render
 * nothing rather than a plausible number. The BILLED quantities are always
 * exact, which is what the price rows should be reading anyway: they are the
 * quantities the rates multiplied.
 *
 * The minutes are recoverable in every case — nothing is clamped on that side —
 * so both bases exist for the time as well, and a page can present distance and
 * travel time on the SAME basis instead of one of each.
 */
export function describeStoredFare(row: StoredFareRow): StoredFare {
  // A stored 0 or a broken row must not divide the trip by zero. 1 is the
  // pre-return-trip value and makes every derivation the identity.
  const returnTripFactor = row.returnTripFactor > 0 ? row.returnTripFactor : 1;
  const freeRadiusKm = safeNonNegative(row.freeRadiusKm);
  const billedDistanceKm = safeNonNegative(row.billedDistanceKm);
  // The same 0.1 km the fare was computed and stored at, so the derived figure
  // does not print 22.4 for a trip stored as 24.8.
  const chargeableDistanceKm = Math.round((billedDistanceKm / returnTripFactor) * 10) / 10;

  return {
    distanceKm:
      chargeableDistanceKm > 0 ? Math.round((chargeableDistanceKm + freeRadiusKm) * 10) / 10 : null,
    chargeableDistanceKm,
    billedDistanceKm,
    returnTripFactor,
    freeRadiusKm,
    durationMin:
      row.billedDurationMin === null ? null : Math.round(row.billedDurationMin / returnTripFactor),
    billedDurationMin: row.billedDurationMin,
  };
}
