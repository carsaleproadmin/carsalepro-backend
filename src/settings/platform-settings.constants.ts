/**
 * Platform settings — configurable tariffs/rules (doc 07 §4). Stored in the
 * PlatformSetting table; never hardcoded in business logic. Admin can change
 * them without a release. Money values are EUR here and converted to integer
 * cents at the single point of use (Math.round(eur * 100)).
 */
export const SETTING_KEYS = {
  orderBaseFeeEur: 'orderBaseFeeEur',
  orderRatePerKmEur: 'orderRatePerKmEur',
  platformFeePercent: 'platformFeePercent',
  payPerViewPriceEur: 'payPerViewPriceEur',
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

/** Seed defaults — doc 07 §4. All values are configurable from the admin panel. */
export const PLATFORM_SETTING_DEFAULTS: Record<SettingKey, number> = {
  orderBaseFeeEur: 50,
  orderRatePerKmEur: 1.5,
  platformFeePercent: 20,
  payPerViewPriceEur: 14.99,
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

/** Subset exposed publicly via GET /api/v1/settings/public. */
export const PUBLIC_SETTING_KEYS: SettingKey[] = [
  'orderBaseFeeEur',
  'orderRatePerKmEur',
  'payPerViewPriceEur',
  'goldPackagePriceEur',
  'standardListingPriceEur',
  'listingDurationDays',
  'expertSearchRadiusKm',
];
