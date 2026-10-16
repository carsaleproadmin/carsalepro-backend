export type IapPlatform = 'ios' | 'android';

/**
 * The one product the mobile app sells: PRO, a one-time unlock. It is a
 * Non-Consumable on Apple and a managed in-app product on Google. A verified
 * purchase of any OTHER product id must not grant PRO.
 */
export const PRO_PRODUCT_ID = 'carsalepro_pro_lifetime';

export interface IapValidationRequest {
  platform: IapPlatform;
  /**
   * iOS: a StoreKit 2 signed transaction (JWS), a numeric transaction id, or a
   * base64 StoreKit 1 app receipt. Android: the Play purchase token.
   */
  receipt: string;
  /** SKU / product id. Required for Google; informational for Apple. */
  productId?: string;
  /** Hint from the client about the Apple environment to try first. */
  environment?: 'Sandbox' | 'Production';
}

export interface IapValidationResult {
  valid: true;
  platform: IapPlatform;
  productId?: string;
  transactionId?: string;
  originalTransactionId?: string;
  purchaseDate?: Date;
  expiresAt?: Date;
  environment: 'Sandbox' | 'Production' | 'Unknown';
  bundleId?: string;
  /**
   * The store's id for the PURCHASE, the same on every device that restores it:
   * Apple `originalTransactionId`, Google `orderId`. `IapGrant` counts devices
   * per value. Unset only in `client-trust` mode.
   */
  storeTransactionId?: string;
  provider: 'apple-verifyreceipt' | 'apple-storekit2' | 'google-play' | 'client-trust';
}

/** How many different devices one store purchase may unlock. */
export const IAP_MAX_DEVICES_PER_PURCHASE = 5;

/**
 * Machine-readable reasons for a refused upgrade. They reach the wire as
 * `code`, so they are a contract: add codes, never rename one.
 *
 * Two families. A REJECTED purchase answers 400: the store (or the request
 * itself) says this is not a valid PRO purchase. An UNAVAILABLE verdict answers
 * 503: the server could not ask the store, so it does not know. Both grant
 * nothing - server mode fails closed.
 */
export const IAP_REJECTED_CODES = [
  'iap_receipt_empty',
  'iap_receipt_malformed',
  /**
   * A bare numeric transaction id (it proves nothing: anybody who saw one can
   * send it), or a StoreKit 1 app receipt while `APPLE_SHARED_SECRET` is unset.
   */
  'iap_receipt_unsupported',
  'iap_product_id_required',
  'iap_bundle_mismatch',
  'iap_product_mismatch',
  'iap_purchase_revoked',
  /** Google `purchaseState` is not 0 (pending or cancelled). */
  'iap_purchase_not_completed',
  'iap_transaction_not_found',
  /** The store refused the receipt or token as invalid. */
  'iap_store_rejected',
  'iap_platform_unsupported',
] as const;

export const IAP_UNAVAILABLE_CODES = [
  /** Server mode is on, but the credentials for this path are not set. */
  'iap_not_configured',
  /** The store refused OUR credentials (bad key, missing Play permission). */
  'iap_store_auth_failed',
  /** Timeout, network error, 429 or 5xx from the store. */
  'iap_store_unavailable',
] as const;

export type IapRejectedCode = (typeof IAP_REJECTED_CODES)[number];
export type IapUnavailableCode = (typeof IAP_UNAVAILABLE_CODES)[number];
export type IapErrorCode = IapRejectedCode | IapUnavailableCode;

const UNAVAILABLE = new Set<string>(IAP_UNAVAILABLE_CODES);

export class IapValidationError extends Error {
  public readonly code: IapErrorCode;
  /** Secret-free, one line. Never holds a receipt, a token or a key. */
  public readonly reason: string;
  public readonly providerCode?: string | number;
  public readonly providerStatus?: number;

  constructor(
    code: IapErrorCode,
    reason: string,
    opts: { providerCode?: string | number; providerStatus?: number } = {},
  ) {
    super(`IAP validation failed (${code}): ${reason}`);
    this.name = 'IapValidationError';
    this.code = code;
    this.reason = reason;
    this.providerCode = opts.providerCode;
    this.providerStatus = opts.providerStatus;
  }

  /** True when the server could not reach a verdict (answer 503, not 400). */
  get unavailable(): boolean {
    return UNAVAILABLE.has(this.code);
  }
}

export type IapValidationMode = 'client-trust' | 'server';
