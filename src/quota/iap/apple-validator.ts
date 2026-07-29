import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import { IapValidationError, IapValidationRequest, IapValidationResult } from './iap.types';

/**
 * Apple App Store status codes from `verifyReceipt`.
 * https://developer.apple.com/documentation/appstorereceipts/status_for_an_in-app_purchase_receipt
 */
const APPLE_STATUS: Record<number, string> = {
  0: 'OK',
  21000: 'App Store could not read JSON',
  21002: 'receipt-data property malformed',
  21003: 'Receipt could not be authenticated',
  21004: 'Shared secret does not match the one on file',
  21005: 'Receipt server temporarily unavailable',
  21006: 'Receipt valid but the subscription has expired',
  21007: 'Sandbox receipt sent to production endpoint',
  21008: 'Production receipt sent to sandbox endpoint',
  21010: 'Receipt could not be authorized (purchase removed)',
};

interface VerifyReceiptResponse {
  status: number;
  environment?: 'Sandbox' | 'Production';
  receipt?: {
    bundle_id?: string;
    in_app?: Array<{
      product_id?: string;
      transaction_id?: string;
      original_transaction_id?: string;
      purchase_date_ms?: string;
      expires_date_ms?: string;
    }>;
  };
  latest_receipt_info?: Array<{
    product_id?: string;
    transaction_id?: string;
    original_transaction_id?: string;
    purchase_date_ms?: string;
    expires_date_ms?: string;
  }>;
}

@Injectable()
export class AppleValidator {
  private readonly logger = new Logger(AppleValidator.name);
  private readonly bundleId: string;
  private readonly sharedSecret: string;
  private readonly issuerId: string;
  private readonly keyId: string;
  private readonly privateKey: string;
  private readonly useSandboxFirst: boolean;

  constructor(
    private readonly http: HttpService,
    config: ConfigService<AppConfig, true>,
  ) {
    const iap = config.get('iap', { infer: true });
    this.bundleId = iap.bundleId;
    this.sharedSecret = iap.apple.sharedSecret;
    this.issuerId = iap.apple.issuerId;
    this.keyId = iap.apple.keyId;
    this.privateKey = iap.apple.privateKey;
    this.useSandboxFirst = iap.apple.useSandboxFirst;
  }

  /** Returns true if any Apple credential is configured (legacy or modern). */
  isConfigured(): boolean {
    return Boolean(this.sharedSecret) || Boolean(this.issuerId && this.keyId && this.privateKey);
  }

  async validate(req: IapValidationRequest): Promise<IapValidationResult> {
    if (!req.receipt || typeof req.receipt !== 'string') {
      throw new IapValidationError('empty receipt');
    }

    // If we have a StoreKit 2 transaction id (numeric) AND modern credentials,
    // use the App Store Server API for richer data.
    if (this.hasStorekit2Creds() && /^\d{6,}$/.test(req.receipt)) {
      return this.validateViaStorekit2(req);
    }

    if (this.sharedSecret) {
      return this.validateViaVerifyReceipt(req);
    }

    throw new IapValidationError(
      'No Apple credentials configured (set APPLE_SHARED_SECRET or APPLE_ISSUER_ID/KEY_ID/PRIVATE_KEY)',
    );
  }

  // ---------- Legacy verifyReceipt ----------

  private async validateViaVerifyReceipt(req: IapValidationRequest): Promise<IapValidationResult> {
    const order = this.useSandboxFirst
      ? ['sandbox' as const, 'production' as const]
      : ['production' as const, 'sandbox' as const];
    if (req.environment === 'Sandbox') order.reverse();

    let lastBody: VerifyReceiptResponse | undefined;
    for (const env of order) {
      const url =
        env === 'production'
          ? 'https://buy.itunes.apple.com/verifyReceipt'
          : 'https://sandbox.itunes.apple.com/verifyReceipt';

      const body = {
        'receipt-data': req.receipt,
        password: this.sharedSecret,
        'exclude-old-transactions': true,
      };

      try {
        const resp = await firstValueFrom(
          this.http.post<VerifyReceiptResponse>(url, body, { timeout: 10_000 }),
        );
        lastBody = resp.data;
        const { status } = resp.data;

        if (status === 0) {
          return this.toResult(req, resp.data, env === 'production' ? 'Production' : 'Sandbox');
        }
        // Receipt is from the other side — retry the opposite endpoint.
        if (status === 21007 && env === 'production') continue;
        if (status === 21008 && env === 'sandbox') continue;

        throw new IapValidationError(
          APPLE_STATUS[status] ?? `Unknown Apple status ${status}`,
          status,
        );
      } catch (err: unknown) {
        if (err instanceof IapValidationError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Apple verifyReceipt (${env}) network error: ${msg}`);
        if (env === order[order.length - 1]) {
          throw new IapValidationError(`Apple endpoint unreachable: ${msg}`);
        }
      }
    }

    throw new IapValidationError(
      `Apple rejected receipt in both endpoints (last status ${lastBody?.status})`,
      lastBody?.status,
    );
  }

  private toResult(
    req: IapValidationRequest,
    body: VerifyReceiptResponse,
    environment: 'Production' | 'Sandbox',
  ): IapValidationResult {
    const receiptBundleId = body.receipt?.bundle_id;
    if (receiptBundleId && receiptBundleId !== this.bundleId) {
      throw new IapValidationError(
        `Bundle id mismatch (expected ${this.bundleId}, got ${receiptBundleId})`,
      );
    }

    const candidates = [...(body.latest_receipt_info ?? []), ...(body.receipt?.in_app ?? [])];
    if (req.productId) {
      // Stable "requested product first": a real comparator, not a predicate.
      // The previous form ignored `b`, so ordering was implementation-defined.
      candidates.sort(
        (a, b) =>
          Number(b.product_id === req.productId) - Number(a.product_id === req.productId),
      );
    }
    const txn = candidates[0];
    if (!txn?.transaction_id) {
      throw new IapValidationError('Receipt contained no transactions');
    }

    return {
      valid: true,
      platform: 'ios',
      productId: txn.product_id,
      transactionId: txn.transaction_id,
      originalTransactionId: txn.original_transaction_id,
      purchaseDate: txn.purchase_date_ms ? new Date(Number(txn.purchase_date_ms)) : undefined,
      expiresAt: txn.expires_date_ms ? new Date(Number(txn.expires_date_ms)) : undefined,
      environment,
      bundleId: receiptBundleId,
      provider: 'apple-verifyreceipt',
    };
  }

  // ---------- Modern App Store Server API ----------

  private hasStorekit2Creds(): boolean {
    return Boolean(this.issuerId && this.keyId && this.privateKey);
  }

  private async validateViaStorekit2(req: IapValidationRequest): Promise<IapValidationResult> {
    const order = this.useSandboxFirst ? ['sandbox', 'production'] : ['production', 'sandbox'];
    if (req.environment === 'Sandbox') order.reverse();

    let lastError: unknown;
    for (const env of order) {
      const base =
        env === 'production'
          ? 'https://api.storekit.itunes.apple.com'
          : 'https://api.storekit-sandbox.itunes.apple.com';
      const url = `${base}/inApps/v1/transactions/${encodeURIComponent(req.receipt)}`;

      try {
        const token = this.buildStorekitJwt();
        const resp = await firstValueFrom(
          this.http.get<{ signedTransactionInfo: string }>(url, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10_000,
          }),
        );
        const signed = resp.data.signedTransactionInfo;
        const decoded = this.decodeJwsPayload<{
          productId?: string;
          transactionId?: string;
          originalTransactionId?: string;
          bundleId?: string;
          environment?: 'Production' | 'Sandbox';
          purchaseDate?: number;
          expiresDate?: number;
        }>(signed);

        if (decoded.bundleId && decoded.bundleId !== this.bundleId) {
          throw new IapValidationError(
            `Bundle id mismatch (expected ${this.bundleId}, got ${decoded.bundleId})`,
          );
        }
        return {
          valid: true,
          platform: 'ios',
          productId: decoded.productId,
          transactionId: decoded.transactionId,
          originalTransactionId: decoded.originalTransactionId,
          purchaseDate: decoded.purchaseDate ? new Date(decoded.purchaseDate) : undefined,
          expiresAt: decoded.expiresDate ? new Date(decoded.expiresDate) : undefined,
          environment: decoded.environment ?? (env === 'production' ? 'Production' : 'Sandbox'),
          bundleId: decoded.bundleId,
          provider: 'apple-storekit2',
        };
      } catch (err: unknown) {
        lastError = err;
        if (err instanceof IapValidationError) throw err;
        const status =
          typeof err === 'object' && err !== null && 'response' in err
            ? ((err as { response?: { status?: number } }).response?.status ?? 0)
            : 0;
        // 404 means "no such transaction in this environment" → try other env.
        if (status === 404) continue;
        throw new IapValidationError(
          `StoreKit API error: ${err instanceof Error ? err.message : String(err)}`,
          status,
        );
      }
    }
    throw new IapValidationError(
      `Transaction not found in any environment (${lastError instanceof Error ? lastError.message : 'unknown'})`,
    );
  }

  /** Build an ES256-signed JWT for App Store Server API. */
  private buildStorekitJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'ES256', kid: this.keyId, typ: 'JWT' };
    const payload = {
      iss: this.issuerId,
      iat: now,
      exp: now + 60 * 50,
      aud: 'appstoreconnect-v1',
      bid: this.bundleId,
    };
    const headerB64 = base64url(JSON.stringify(header));
    const payloadB64 = base64url(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signer = createSign('sha256');
    signer.update(signingInput);
    // P8 → PKCS#8 PEM is what Apple gives. createSign produces DER signature;
    // we must convert to JOSE (R||S) for JWT.
    const der = signer.sign({ key: this.privateKey, dsaEncoding: 'ieee-p1363' });
    const sigB64 = base64url(der);
    return `${signingInput}.${sigB64}`;
  }

  /** Base64URL-decode a JWS payload (signature is NOT verified — Apple already signed it). */
  private decodeJwsPayload<T>(jws: string): T {
    const [, payload] = jws.split('.');
    if (!payload) throw new IapValidationError('Malformed JWS from Apple');
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as T;
  }
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
