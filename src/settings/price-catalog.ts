/**
 * Every price the platform charges, in one place, in integer cents.
 *
 * The website previously hardcoded `REPORT_PRICE_CENTS = 1499` in two page
 * components; a displayed price that disagrees with the price actually charged
 * at checkout is a legal and trust problem, not a style one. Any surface that
 * shows a price must read it from here.
 *
 * `GET /api/v1/settings/public` keeps emitting the historical EUR-float keys
 * alongside this block — they are a published contract that existing clients
 * read, and an asserted-absent `platformFeePercent` is part of that shape.
 */
export interface PriceCatalog {
  currency: 'EUR';

  /** One-off unlock of a full inspection report. */
  payPerViewCents: number;
  /** Gold listing package. */
  goldPackageCents: number;
  /** Standard listing package — 0 today, but read it rather than assume. */
  standardListingCents: number;
  /** Paid VIN history check. */
  vinHistoryCents: number;

  /** Order tariff, itemised so the UI can explain the fare before geocoding. */
  orderBaseFeeCents: number;
  orderRatePerKmCents: number;
  orderRatePerMinuteCents: number;
  orderMinimumFareCents: number;

  /** Non-money, but they belong to the same "what does this cost me" answer. */
  listingDurationDays: number;
  expertSearchRadiusKm: number;
}
