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
  orderReturnTripFactor: 'orderReturnTripFactor',
  orderFreeRadiusKm: 'orderFreeRadiusKm',
  orderCapKm: 'orderCapKm',
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
 * scaled by surge/peak, floored at a minimum fare. Two things shape the
 * distance before the rate touches it: the first 10 km carry no travel charge
 * (`orderFreeRadiusKm`), and what remains is charged BOTH WAYS
 * (`orderReturnTripFactor`). Worked examples, distances one direction:
 *   5 km / 10 min  → 39 + 0.00 + 7.00  = 46.00 → floored to 49.00
 *   20 km / 25 min → 39 + 6.00 + 17.50 = 62.50
 *   50 km / 45 min → 39 + 24.00 + 31.50 = 94.50
 * The kilometre charge is unchanged from the previous 0.60-one-way tariff; the
 * minutes are what rose, because travel time is now paid in both directions.
 */
export const PLATFORM_SETTING_DEFAULTS: Record<SettingKey, number> = {
  orderBaseFeeEur: 39,
  /**
   * Per kilometre of the BILLED trip, which is the return trip (see
   * `orderReturnTripFactor`). 0.30 is Germany's `Kilometerpauschale`, §9 Abs. 1
   * Nr. 4a EStG — a rate defined on the kilometres driven in both directions,
   * which is exactly what it is now applied to.
   *
   * It replaced an invented 0.60 charged on a one-direction trip. 0.30 x 2 is
   * 0.60: the travel charge per kilometre TO the vehicle is unchanged. The two
   * had to move together, and a later change to either must ask what the other
   * is doing.
   */
  orderRatePerKmEur: 0.3,
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
  /**
   * How many times the measured one-direction trip the customer pays for.
   *
   * 2: the inspector drives to the vehicle and back, and the customer pays for
   * both legs.
   *
   * **It shipped together with `orderRatePerKmEur` moving 0.60 -> 0.30, and the
   * two must keep moving together.** The old pair charged an invented 0.60 on a
   * one-direction trip; the new pair charges a published 0.30 on the real
   * distance driven. The product is the same, so the kilometre charge did not
   * move — what changed is that it can now be checked against the tax code
   * instead of being an internal figure. Either half alone changes every fare
   * by two.
   *
   * The MINUTES follow the same factor, and `orderRatePerMinuteEur` was NOT
   * halved to compensate (owner's decision, 2026-08-13): travel time really is
   * spent in both directions, and the old rate paid for half of it. That is the
   * one part of the fare that genuinely rises — about 13 % on a 20 km job and
   * 27 % on a 100 km one. See DEN-108.
   */
  orderReturnTripFactor: 2,
  /**
   * Kilometres of the trip to the vehicle that carry no travel charge.
   *
   * Ten costs almost no revenue: the 49 EUR minimum fare already floors every
   * trip under roughly ten kilometres, so below that a customer pays 49 EUR
   * whether or not the kilometres were charged. What it buys is a sentence a
   * customer understands — travel inside the city is included — instead of a
   * 1.80 EUR line that reads as noise.
   *
   * Subtracted, never a threshold: at a threshold, km 10.1 would cost ten times
   * km 10.0 and two neighbours would be quoted prices an order of magnitude
   * apart.
   */
  orderFreeRadiusKm: 10,
  /**
   * Refuse to quote beyond this one-direction distance.
   *
   * Past 100 km the travel charge alone passes 60 EUR, no inspector accepts,
   * and the order sits for the whole six-hour search window before the cron
   * cancels it — with the customer's money held the entire time. Refusing at
   * the quote turns that into a waitlist entry, which is a lead rather than a
   * dead hold. 0 disables the cap.
   */
  orderCapKm: 100,
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
  // Public because `orderRatePerKmEur` is public and the two are meaningless
  // apart: a visitor who multiplies the published rate by the distance we show
  // must arrive at the price we charge. It is a published tariff term, not an
  // operator lever.
  'orderReturnTripFactor',
  // Both are published tariff terms: a visitor must be able to tell why a
  // nearby inspection has no travel line, and how far we serve at all.
  'orderFreeRadiusKm',
  'orderCapKm',
];

