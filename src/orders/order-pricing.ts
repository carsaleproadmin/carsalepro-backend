/**
 * Order pricing — a pure function, deliberately free of Nest, Prisma and I/O so
 * it can be exhaustively unit-tested. `OrdersService` fetches the settings and
 * the route, then calls `computePrice`; it must not do arithmetic of its own.
 *
 * The model is ride-hailing shaped:
 *
 *   subtotal   = base + distance × ratePerKm + duration × ratePerMinute
 *   multiplier = surge × (peak window ? peakMultiplier : 1)
 *   total      = max(round(subtotal × multiplier), minimumFare)
 *
 * Every amount is integer cents. Rounding happens once per component and once
 * on the surged subtotal — never on a running float.
 */

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
}

export interface PricingInput {
  /** Road kilometres where available, great-circle × detour factor otherwise. */
  distanceKm: number;
  /** Travel time in minutes. */
  durationMin: number;
  /** When the inspection is scheduled — drives the peak window. */
  scheduledAt: Date;
  tariff: PricingTariff;
}

export interface PriceBreakdown {
  baseFeeCents: number;
  distanceKm: number;
  distanceFeeCents: number;
  durationMin: number;
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

  const distanceFeeCents = Math.round(distanceKm * safeNonNegative(tariff.ratePerKmCents));
  const timeFeeCents = Math.round(durationMin * safeNonNegative(tariff.ratePerMinuteCents));
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
    distanceFeeCents,
    durationMin,
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
