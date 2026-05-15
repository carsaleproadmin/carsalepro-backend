export type IapPlatform = 'ios' | 'android';

export interface IapValidationRequest {
  platform: IapPlatform;
  /** Base64 receipt (iOS) or purchase token (Android). */
  receipt: string;
  /** SKU / product id. Required for Google; optional/informational for Apple. */
  productId?: string;
  /** Hint from the client to skip prod→sandbox fallback for Apple. */
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
  provider: 'apple-verifyreceipt' | 'apple-storekit2' | 'google-play' | 'client-trust';
}

export class IapValidationError extends Error {
  public readonly reason: string;
  public readonly providerCode?: string | number;
  public readonly providerStatus?: number;

  constructor(reason: string, providerCode?: string | number, providerStatus?: number) {
    super(`IAP validation failed: ${reason}`);
    this.name = 'IapValidationError';
    this.reason = reason;
    this.providerCode = providerCode;
    this.providerStatus = providerStatus;
  }
}

export type IapValidationMode = 'client-trust' | 'server';
