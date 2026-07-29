/**
 * Platform settings — configurable tariffs/rules (doc 07 §4). Stored in the
 * PlatformSetting table; never hardcoded in business logic. Admin can change
 * them without a release. Money values are EUR here and converted to integer
 * cents at the single point of use (Math.round(eur * 100)).
 */
export const SETTING_KEYS = {
  orderBaseFeeEur: 'orderBaseFeeEur',
  orderRatePerKmEur: 'orderRatePerKmEur',
  orderRatePerMinuteEur: 'orderRatePerMinuteEur',
  orderMinimumFareEur: 'orderMinimumFareEur',
  orderSurgeMultiplier: 'orderSurgeMultiplier',
  orderPeakMultiplier: 'orderPeakMultiplier',
  orderPeakStartHour: 'orderPeakStartHour',
  orderPeakEndHour: 'orderPeakEndHour',
  orderDetourFactor: 'orderDetourFactor',
  orderRoutingCacheHours: 'orderRoutingCacheHours',
  platformFeePercent: 'platformFeePercent',
  payPerViewPriceEur: 'payPerViewPriceEur',
  vinHistoryPriceEur: 'vinHistoryPriceEur',
  vinHistoryCacheDays: 'vinHistoryCacheDays',
  goldPackagePriceEur: 'goldPackagePriceEur',
  standardListingPriceEur: 'standardListingPriceEur',
  listingDurationDays: 'listingDurationDays',
  expertSearchRadiusKm: 'expertSearchRadiusKm',
  offerTimeoutMinutes: 'offerTimeoutMinutes',
  autoApproveAfterDays: 'autoApproveAfterDays',
  refundBeforeAssignPercent: 'refundBeforeAssignPercent',
  refundAfterAssignPercent: 'refundAfterAssignPercent',
  signedUrlTtlMinutes: 'signedUrlTtlMinutes',
} as const;

export type SettingKey = keyof typeof SETTING_KEYS;

/**
 * Seed defaults — doc 07 §4. All values are configurable from the admin panel.
 *
 * The order tariff is a ride-hailing-style model: base + per-km + per-minute,
 * scaled by surge/peak, floored at a minimum fare. Worked examples with the
 * defaults below:
 *   5 km / 10 min  → 39 + 3.00 + 3.50  = 45.50 → floored to 49.00
 *   20 km / 25 min → 39 + 12.00 + 8.75 = 59.75
 *   50 km / 45 min → 39 + 30.00 + 15.75 = 84.75
 * The previous flat model (50 + 1.50/km, straight-line) charged 57.50 / 80.00 /
 * 125.00 for the same trips, so this is cheaper across the board.
 */
export const PLATFORM_SETTING_DEFAULTS: Record<SettingKey, number> = {
  orderBaseFeeEur: 39,
  orderRatePerKmEur: 0.6,
  orderRatePerMinuteEur: 0.35,
  orderMinimumFareEur: 49,
  /** Manual admin lever. 1 = off. Applied on top of the peak multiplier. */
  orderSurgeMultiplier: 1,
  /** 1 = off. Set above 1 to charge more inside the peak window below. */
  orderPeakMultiplier: 1,
  /** Local hour, inclusive. */
  orderPeakStartHour: 16,
  /** Local hour, exclusive. */
  orderPeakEndHour: 19,
  /** Great-circle → road estimate when the routing provider is unavailable. */
  orderDetourFactor: 1.3,
  orderRoutingCacheHours: 24,
  platformFeePercent: 20,
  payPerViewPriceEur: 14.99,
  vinHistoryPriceEur: 19.99,
  /** How long a purchased VIN history stays reusable before a refetch. */
  vinHistoryCacheDays: 30,
  goldPackagePriceEur: 9.99,
  standardListingPriceEur: 0,
  listingDurationDays: 30,
  expertSearchRadiusKm: 50,
  offerTimeoutMinutes: 60,
  autoApproveAfterDays: 7,
  refundBeforeAssignPercent: 100,
  refundAfterAssignPercent: 80,
  signedUrlTtlMinutes: 15,
};

/**
 * Subset exposed publicly via GET /api/v1/settings/public.
 *
 * The first seven are a frozen shape — `test/auth.e2e-spec.ts` asserts both that
 * `payPerViewPriceEur` is present and that `platformFeePercent` is absent, and
 * the website reads them today. Additions are fine; removals are not.
 * `orderSurgeMultiplier`, `orderPeakMultiplier` and the peak window stay private:
 * they are operator levers, not a published tariff.
 */
export const PUBLIC_SETTING_KEYS: SettingKey[] = [
  'orderBaseFeeEur',
  'orderRatePerKmEur',
  'payPerViewPriceEur',
  'goldPackagePriceEur',
  'standardListingPriceEur',
  'listingDurationDays',
  'expertSearchRadiusKm',
  'orderRatePerMinuteEur',
  'orderMinimumFareEur',
  'vinHistoryPriceEur',
];

/**
 * Pricing keys the seeder force-updates rather than leaving alone.
 *
 * `prisma/seed.ts` upserts with `update: {}` so an operator's admin edits are
 * never clobbered. That is right for most keys, but the order tariff changed
 * shape in this release: an existing deployment would keep base 50 / 1.50 per km
 * AND gain a per-minute charge, i.e. a silent price rise nobody asked for.
 * These keys are therefore reset to the defaults above exactly once, when the
 * per-minute key is first introduced.
 */
export const REPRICED_SETTING_KEYS: SettingKey[] = [
  'orderBaseFeeEur',
  'orderRatePerKmEur',
];
