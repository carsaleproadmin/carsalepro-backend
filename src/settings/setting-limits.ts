import { PLATFORM_SETTING_DEFAULTS, SettingKey } from './platform-settings.constants';

/**
 * The values an admin may set for each platform setting (DEN-297).
 *
 * Before this the only checks were "a finite number >= 0" and "a percent is at
 * most 100". A typing error went to production at once: `orderBaseFeeEur`
 * = 3900 instead of 39 priced every new order a hundred times higher, and
 * `offerTimeoutMinutes` = 0 expired every offer the moment it was sent.
 *
 * These are GUARD RAILS, not product decisions. Each range is wide enough for
 * any value the business could want and narrow enough to refuse a typing error
 * (an extra digit, a missing decimal point). A change of range is a code change
 * on purpose: the point is that one field in a form cannot move a price by a
 * factor of ten. Every default must sit inside its range - the spec asserts it.
 *
 * `0` stays allowed wherever it is a documented lever: `orderCapKm` (no cap),
 * `minReportQualityScore` (gate off), `orderMinimumFareEur` (no floor), a free
 * listing price, and the refund percents.
 */
export interface SettingLimit {
  min: number;
  max: number;
}

export const SETTING_LIMITS: Record<SettingKey, SettingLimit> = {
  orderBaseFeeEur: { min: 5, max: 200 },
  orderRatePerKmEur: { min: 0.05, max: 3 },
  orderRatePerMinuteEur: { min: 0.05, max: 3 },
  orderMinimumFareEur: { min: 0, max: 200 },
  orderSurgeMultiplier: { min: 0.5, max: 5 },
  orderDetourFactor: { min: 1, max: 3 },
  orderReturnTripFactor: { min: 1, max: 3 },
  orderFreeRadiusKm: { min: 0, max: 100 },
  orderCapKm: { min: 0, max: 1000 },
  orderRoutingCacheHours: { min: 0, max: 720 },
  platformFeePercent: { min: 0, max: 50 },
  payPerViewPriceEur: { min: 0, max: 100 },
  goldPackagePriceEur: { min: 0, max: 200 },
  standardListingPriceEur: { min: 0, max: 200 },
  expertSearchRadiusKm: { min: 10, max: 1000 },
  offerTimeoutMinutes: { min: 5, max: 1440 },
  // The ceiling stays far below Stripe's 7-day authorization expiry: a hold
  // that sits near it strands real money (see the default's comment).
  orderSearchWindowMinutes: { min: 30, max: 4320 },
  autoApproveAfterDays: { min: 1, max: 30 },
  inspectionStartDeadlineDays: { min: 1, max: 30 },
  minReportQualityScore: { min: 0, max: 100 },
  refundBeforeAssignPercent: { min: 0, max: 100 },
  refundAfterAssignPercent: { min: 0, max: 100 },
};

/**
 * Why `value` cannot be stored for `key`, or null when it can. The message
 * names the range, so the admin who typed it knows what to type instead.
 */
export function settingValueError(key: SettingKey, value: number): string | null {
  const { min, max } = SETTING_LIMITS[key];
  if (!Number.isFinite(value)) return `${key} must be a finite number`;
  if (value < min || value > max) {
    return `${key} must be from ${min} to ${max} (default ${PLATFORM_SETTING_DEFAULTS[key]})`;
  }
  return null;
}
