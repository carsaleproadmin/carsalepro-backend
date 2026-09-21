/**
 * Regional tariff resolution (DEN-108) — a pure function, deliberately free of
 * Nest and Prisma so the rule can be read and tested on its own.
 *
 * The rule is three levels deep, and it is applied FIELD BY FIELD:
 *
 *   1. the row for the country, if one exists (an exception);
 *   2. otherwise the row for the band that country belongs to;
 *   3. otherwise the global tariff from `PlatformSetting`.
 *
 * Field by field, and not row by row, is the whole design. A country that must
 * charge its own per-km rate should not have to restate the base fee and
 * the minimum fare to say so — a restated value is a copy that
 * stops tracking the original the day the original moves.
 *
 * **The global level never refuses.** It is a complete tariff, so an empty
 * database resolves to exactly what every order is priced on today. That is the
 * state this ships in: adding a band moves a price only where an operator put
 * numbers.
 */

import { PricingTariff } from './order-pricing';

/** The subset of tariff terms a region may override. */
export interface RegionalOverrides {
  baseFeeCents?: number | null;
  perKmCents?: number | null;
  ratePerMinuteCents?: number | null;
  minimumFareCents?: number | null;
  returnTripFactor?: number | null;
  /** Refuse the quote beyond this distance. */
  capKm?: number | null;
}

/**
 * What a region adds to the fare terms: two limits that the pure fare
 * arithmetic does not own, because one of them refuses a quote rather than
 * pricing it.
 */
export interface RegionalLimits {
  /** `null` means no cap — the shipped state, and never a refusal. */
  capKm: number | null;
}

export interface ResolvedTariff {
  tariff: PricingTariff;
  limits: RegionalLimits;
  /**
   * Which level answered for each overridable term. Carried so an operator
   * looking at a price can see WHY it is what it is; a resolved number with no
   * provenance is indistinguishable from a typo.
   */
  sources: Record<keyof RegionalOverrides, 'country' | 'zone' | 'global'>;
}

const OVERRIDABLE: Array<keyof RegionalOverrides> = [
  'baseFeeCents',
  'perKmCents',
  'ratePerMinuteCents',
  'minimumFareCents',
  'returnTripFactor',
  'capKm',
];

/**
 * A value counts as "said" only when it is a finite number. Null and undefined
 * both mean "this level says nothing", which is what lets a band move one term
 * and stay silent on the rest. `NaN` is treated as silence too: it can only
 * arrive from a broken row, and inheriting the next level is safer than pricing
 * an order on it.
 */
function said(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param globalTariff the complete `PlatformSetting` tariff — the level that
 *   must always answer.
 * @param zone the band row, or null when the country belongs to no band.
 * @param country the country row, or null when the country has no exception.
 */
export function resolveTariff(
  globalTariff: PricingTariff,
  zone: RegionalOverrides | null,
  country: RegionalOverrides | null,
): ResolvedTariff {
  const sources = {} as ResolvedTariff['sources'];
  const resolved = {} as Record<keyof RegionalOverrides, number | null>;

  const globals: Record<keyof RegionalOverrides, number | null> = {
    baseFeeCents: globalTariff.baseFeeCents,
    perKmCents: globalTariff.ratePerKmCents,
    ratePerMinuteCents: globalTariff.ratePerMinuteCents,
    minimumFareCents: globalTariff.minimumFareCents,
    returnTripFactor: globalTariff.returnTripFactor,
    // No global cap: a cap refuses an order, and a refusal must be something an
    // operator switched on for a region, never a default nobody chose.
    capKm: null,
  };

  for (const field of OVERRIDABLE) {
    if (said(country?.[field])) {
      resolved[field] = country[field] as number;
      sources[field] = 'country';
    } else if (said(zone?.[field])) {
      resolved[field] = zone[field] as number;
      sources[field] = 'zone';
    } else {
      resolved[field] = globals[field];
      sources[field] = 'global';
    }
  }

  return {
    tariff: {
      ...globalTariff,
      baseFeeCents: resolved.baseFeeCents as number,
      ratePerKmCents: resolved.perKmCents as number,
      ratePerMinuteCents: resolved.ratePerMinuteCents as number,
      minimumFareCents: resolved.minimumFareCents as number,
      returnTripFactor: resolved.returnTripFactor as number,
    },
    limits: {
      capKm: resolved.capKm,
    },
    sources,
  };
}

/**
 * Is this trip beyond what the region will serve?
 *
 * Answered on the MEASURED one-direction distance, not the billed return trip:
 * a cap is a statement about how far an inspector will travel, and doubling the
 * number the operator typed would halve the radius they thought they set.
 */
export function exceedsCap(distanceKm: number, capKm: number | null): boolean {
  if (capKm === null || !Number.isFinite(capKm) || capKm <= 0) return false;
  return Number.isFinite(distanceKm) && distanceKm > capKm;
}
