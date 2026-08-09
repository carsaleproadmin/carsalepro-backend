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
  orderSearchWindowMinutes: 'orderSearchWindowMinutes',
  autoApproveAfterDays: 'autoApproveAfterDays',
  minReportQualityScore: 'minReportQualityScore',
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
  /**
   * How long we keep looking for an inspector before releasing the customer's
   * authorization hold and cancelling (six hours).
   *
   * The ceiling is Stripe's: an uncaptured authorization expires after 7 days,
   * and letting a hold sit anywhere near that strands real money. The floor is
   * coverage — too short and orders in thin regions fail that could have been
   * filled. A product number, meant to be tuned from the admin panel once real
   * fill times exist.
   */
  orderSearchWindowMinutes: 360,
  autoApproveAfterDays: 7,
  /**
   * Completeness gate: an order may only be closed with a report scoring at
   * least this. **`0` disables the gate** — that is the operational lever, and
   * the reason this is a setting rather than a constant: an inspector on an
   * older mobile build may file a report with no score at all, and discovering
   * that in production must be fixable from the admin panel in a minute.
   *
   * 90 -> 85 on 2026-08-10, because the required walk-around grew from 8
   * exterior angles to 17 and the mobile score prorates a fixed 25 points over
   * the required count (`quality_score_service.dart`: identity 20, exterior 25,
   * wheels 10, mileage 5, calibration 6+4, thickness 15, signature 15). The
   * same inspection therefore scores less than it did, and the window is
   * bounded on BOTH sides:
   *
   *   17/17, everything filled ................................. 100  pass
   *   12/17, engine bay + open bonnet skipped (no lift, hot
   *     engine — the case the client asked to keep passing) ...   93  pass
   *    8/17, a report shot before the expansion and re-synced
   *     from a newer build .....................................   87  pass  <- upper bound
   *   17/17 with no inspector signature ........................   85  pass
   *   17/17 with no make/model/VIN .............................   80  FAIL  <- lower bound
   *   12/17 with no paint gauge at all .........................   78  FAIL
   *
   * So it must sit in [81, 87]. 85 keeps a legacy report closable with two
   * points to spare and still refuses a report that does not identify the
   * vehicle, which is the thing this gate exists to refuse. Note the one
   * deliberate trade: at 85 a complete-but-unsigned report passes the SERVER
   * gate. The signature is enforced separately, by the mobile Finish flow; this
   * gate is about coverage.
   *
   * Changing it here only affects fresh installs — production is moved by
   * `prisma/migrations/20260810120000_lower_min_report_quality_score`, because
   * `prisma/seed.ts` upserts settings with `update: {}` and Render never runs
   * the seed anyway.
   */
  minReportQualityScore: 85,
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
  // How long the customer's hold is held while we look for an inspector. The
  // website shows it on the order page as "we are searching until …", so it has
  // to be public: a countdown the client invents from a hardcoded constant
  // silently lies the day an operator retunes the window.
  'orderSearchWindowMinutes',
];

