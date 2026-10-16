import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KeyObject, createPrivateKey, createSign } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import {
  base64url,
  decodeJwsPayload,
  httpBodyOf,
  httpStatusOf,
  isCompactJws,
  isTransientStatus,
  printable,
} from './iap-encoding';
import {
  IapValidationError,
  IapValidationRequest,
  IapValidationResult,
  PRO_PRODUCT_ID,
} from './iap.types';

/**
 * What the iOS app can send as `receipt`.
 *
 * The app uses `in_app_purchase_storekit` 0.4.8+1, where StoreKit 2 is the
 * default, so `serverVerificationData` is the transaction's `jwsRepresentation`
 * - a JWS. A bare numeric transaction id is RECOGNISED only to refuse it: it is
 * not a secret, so accepting it would sell PRO to anybody who saw one. A base64
 * StoreKit 1 app receipt is accepted only with `APPLE_SHARED_SECRET`.
 */
export type AppleReceiptKind = 'jws' | 'transaction-id' | 'app-receipt';

export function classifyAppleReceipt(receipt: string): AppleReceiptKind {
  if (isCompactJws(receipt)) return 'jws';
  if (/^\d{6,32}$/.test(receipt)) return 'transaction-id';
  return 'app-receipt';
}

/** Which Apple credentials are usable. Secret-free: the startup check prints it. */
export interface AppleCredentialStatus {
  /** `APPLE_ISSUER_ID` + `APPLE_KEY_ID` + `APPLE_PRIVATE_KEY`, for the App Store Server API. */
  serverApi: 'ok' | 'missing' | 'partial' | 'invalid_key';
  /** `APPLE_SHARED_SECRET`, for the legacy `verifyReceipt` fallback only. */
  sharedSecret: boolean;
}

export function appleCredentialStatus(apple: {
  issuerId: string;
  keyId: string;
  privateKey: string;
  sharedSecret: string;
}): AppleCredentialStatus {
  const present = [apple.issuerId, apple.keyId, apple.privateKey].filter(Boolean).length;
  let serverApi: AppleCredentialStatus['serverApi'] =
    present === 3 ? 'ok' : present === 0 ? 'missing' : 'partial';
  if (serverApi === 'ok' && !parseAppleKey(apple.privateKey)) serverApi = 'invalid_key';
  return { serverApi, sharedSecret: Boolean(apple.sharedSecret) };
}

/** The `.p8` key as a P-256 key object, or null. Never throws, never logs. */
function parseAppleKey(pem: string): KeyObject | null {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec') return null;
    return key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch {
    return null;
  }
}

/** `verifyReceipt` status codes. Apple has deprecated this endpoint. */
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
  21009: 'Internal data access error',
  21010: 'Receipt could not be authorized (purchase removed)',
};

/** App Store Server API: "no such transaction in this environment". */
const TRANSACTION_ID_NOT_FOUND = 4040010;

/**
 * App Store Server API 404s that Apple documents as RETRYABLE: the account,
 * the app or the original transaction is not found YET. The answer is "try
 * again later", not "no such purchase", so they are 503 and never a fallback.
 */
const RETRYABLE_NOT_FOUND = new Set([4040002, 4040004, 4040006]);

interface ReceiptTransaction {
  product_id?: string;
  transaction_id?: string;
  original_transaction_id?: string;
  purchase_date_ms?: string;
  expires_date_ms?: string;
  cancellation_date_ms?: string;
}

interface VerifyReceiptResponse {
  status: number;
  environment?: 'Sandbox' | 'Production';
  receipt?: { bundle_id?: string; in_app?: ReceiptTransaction[] };
  latest_receipt_info?: ReceiptTransaction[];
}

/** The decoded payload of a `JWSTransaction`. */
interface JwsTransactionPayload {
  transactionId?: string;
  originalTransactionId?: string;
  bundleId?: string;
  productId?: string;
  environment?: string;
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  revocationReason?: number;
}

type AppleEnv = 'production' | 'sandbox';

const SERVER_API_BASE: Record<AppleEnv, string> = {
  production: 'https://api.storekit.itunes.apple.com',
  sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
};

const VERIFY_RECEIPT_URL: Record<AppleEnv, string> = {
  production: 'https://buy.itunes.apple.com/verifyReceipt',
  sandbox: 'https://sandbox.itunes.apple.com/verifyReceipt',
};

const HTTP_TIMEOUT_MS = 10_000;
/** Apple refuses a token that lives longer than 60 minutes. */
const TOKEN_TTL_S = 50 * 60;

@Injectable()
export class AppleValidator {
  private readonly logger = new Logger(AppleValidator.name);
  private readonly bundleId: string;
  private readonly sharedSecret: string;
  private readonly issuerId: string;
  private readonly keyId: string;
  private readonly signingKey: KeyObject | null;
  private readonly credentials: AppleCredentialStatus;
  private readonly useSandboxFirst: boolean;
  private cachedToken?: { token: string; expiresAt: number };

  constructor(
    private readonly http: HttpService,
    config: ConfigService<AppConfig, true>,
  ) {
    const iap = config.get('iap', { infer: true });
    this.bundleId = iap.bundleId;
    this.sharedSecret = iap.apple.sharedSecret;
    this.issuerId = iap.apple.issuerId;
    this.keyId = iap.apple.keyId;
    this.useSandboxFirst = iap.apple.useSandboxFirst;
    this.credentials = appleCredentialStatus(iap.apple);
    this.signingKey =
      this.credentials.serverApi === 'ok' ? parseAppleKey(iap.apple.privateKey) : null;
    if (this.credentials.serverApi === 'invalid_key') {
      this.logger.warn(
        'APPLE_PRIVATE_KEY is not a P-256 private key - App Store Server API disabled',
      );
    }
  }

  /** True if any Apple path can run: the App Store Server API or `verifyReceipt`. */
  isConfigured(): boolean {
    return this.credentials.serverApi === 'ok' || this.credentials.sharedSecret;
  }

  async validate(req: IapValidationRequest): Promise<IapValidationResult> {
    const receipt = typeof req.receipt === 'string' ? req.receipt.trim() : '';
    if (!receipt) throw new IapValidationError('iap_receipt_empty', 'empty receipt');

    switch (classifyAppleReceipt(receipt)) {
      case 'jws':
        return this.validateSignedTransaction(receipt, req);
      case 'transaction-id':
        throw new IapValidationError(
          'iap_receipt_unsupported',
          'A bare transaction id is not accepted; send the StoreKit 2 signed transaction',
        );
      case 'app-receipt':
        return this.validateAppReceipt(receipt, req);
    }
  }

  // ---------- StoreKit 2: the JWS the app sends ----------

  /**
   * The JWS from the device is NOT trusted. Its payload only names the
   * transaction; the verdict comes from Apple's own copy of it. A forged JWS
   * names a transaction Apple does not have, or one of another app or product.
   */
  private async validateSignedTransaction(
    jws: string,
    req: IapValidationRequest,
  ): Promise<IapValidationResult> {
    const payload = decodeJwsPayload<JwsTransactionPayload>(jws);
    const transactionId = payload?.transactionId === undefined ? '' : String(payload.transactionId);
    if (!payload || !/^\d{1,32}$/.test(transactionId)) {
      throw new IapValidationError(
        'iap_receipt_malformed',
        'StoreKit 2 JWS payload has no numeric transactionId',
      );
    }
    // Refuse early, without a network call. Never grant on this payload.
    if (payload.bundleId !== undefined && payload.bundleId !== this.bundleId) {
      throw new IapValidationError(
        'iap_bundle_mismatch',
        `Bundle id mismatch (expected ${this.bundleId}, got ${printable(payload.bundleId)})`,
      );
    }
    const hint = req.environment ?? (payload.environment === 'Sandbox' ? 'Sandbox' : undefined);
    return this.lookupTransaction(transactionId, hint);
  }

  // ---------- App Store Server API: Get Transaction Info ----------

  private async lookupTransaction(
    transactionId: string,
    hint: IapValidationRequest['environment'],
  ): Promise<IapValidationResult> {
    this.requireServerApi();

    for (const env of this.environmentOrder(hint)) {
      const url = `${SERVER_API_BASE[env]}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`;
      let signed: unknown;
      try {
        const resp = await firstValueFrom(
          this.http.get<{ signedTransactionInfo?: string }>(url, {
            headers: { Authorization: `Bearer ${this.serverApiToken()}` },
            timeout: HTTP_TIMEOUT_MS,
          }),
        );
        signed = resp.data?.signedTransactionInfo;
      } catch (err: unknown) {
        const status = httpStatusOf(err);
        const body = httpBodyOf<{ errorCode?: number; errorMessage?: string }>(err);
        if (body?.errorCode !== undefined && RETRYABLE_NOT_FOUND.has(body.errorCode)) {
          this.logger.warn(`App Store Server API (${env}) retryable error ${body.errorCode}`);
          throw new IapValidationError(
            'iap_store_unavailable',
            `App Store Server API asks to retry later (error ${body.errorCode})`,
            { providerCode: body.errorCode, providerStatus: status },
          );
        }
        // Not in this environment: a TestFlight or App Review purchase lives
        // in the sandbox. Try the other one.
        if (status === 404 || body?.errorCode === TRANSACTION_ID_NOT_FOUND) continue;
        throw this.serverApiError(env, status, body?.errorCode, err);
      }
      return this.verifyTransaction(signed, env);
    }

    throw new IapValidationError(
      'iap_transaction_not_found',
      'Transaction not found in the production or the sandbox App Store',
      { providerCode: TRANSACTION_ID_NOT_FOUND, providerStatus: 404 },
    );
  }

  /**
   * `signedTransactionInfo` arrived over TLS from Apple, in answer to a request
   * signed with our key, so its payload is read without checking the x5c chain.
   */
  private verifyTransaction(signed: unknown, env: AppleEnv): IapValidationResult {
    const tx = typeof signed === 'string' ? decodeJwsPayload<JwsTransactionPayload>(signed) : null;
    if (!tx) {
      throw new IapValidationError(
        'iap_store_unavailable',
        'App Store Server API answered without a readable signedTransactionInfo',
      );
    }
    if (tx.bundleId !== this.bundleId) {
      throw new IapValidationError(
        'iap_bundle_mismatch',
        `Bundle id mismatch (expected ${this.bundleId}, got ${printable(tx.bundleId)})`,
      );
    }
    if (tx.productId !== PRO_PRODUCT_ID) {
      throw new IapValidationError(
        'iap_product_mismatch',
        `Product mismatch (expected ${PRO_PRODUCT_ID}, got ${printable(tx.productId)})`,
      );
    }
    if (tx.revocationDate) {
      throw new IapValidationError('iap_purchase_revoked', 'Purchase was revoked by Apple', {
        providerCode: tx.revocationReason,
      });
    }
    const transactionId = tx.transactionId === undefined ? undefined : String(tx.transactionId);
    const originalTransactionId =
      tx.originalTransactionId === undefined ? undefined : String(tx.originalTransactionId);
    if (!originalTransactionId && !transactionId) {
      throw new IapValidationError(
        'iap_store_unavailable',
        'App Store Server API answered with a transaction that has no id',
      );
    }
    return {
      valid: true,
      platform: 'ios',
      productId: tx.productId,
      transactionId,
      originalTransactionId,
      // The same on every device that restores this purchase.
      storeTransactionId: originalTransactionId ?? transactionId,
      purchaseDate: tx.purchaseDate ? new Date(tx.purchaseDate) : undefined,
      expiresAt: tx.expiresDate ? new Date(tx.expiresDate) : undefined,
      environment:
        tx.environment === 'Sandbox' || tx.environment === 'Production'
          ? tx.environment
          : env === 'production'
            ? 'Production'
            : 'Sandbox',
      bundleId: tx.bundleId,
      provider: 'apple-storekit2',
    };
  }

  private serverApiError(
    env: AppleEnv,
    status: number,
    errorCode: number | undefined,
    err: unknown,
  ): IapValidationError {
    const opts = { providerCode: errorCode ?? status, providerStatus: status };
    if (status === 401) {
      this.logger.error(
        `App Store Server API (${env}) refused our token (401). Check APPLE_ISSUER_ID, ` +
          'APPLE_KEY_ID, APPLE_PRIVATE_KEY and the bundle id.',
      );
      return new IapValidationError(
        'iap_store_auth_failed',
        'App Store Server API refused the server credentials',
        opts,
      );
    }
    if (status === 400) {
      return new IapValidationError(
        'iap_store_rejected',
        `App Store Server API rejected the transaction id (error ${errorCode ?? 'unknown'})`,
        opts,
      );
    }
    const detail = isTransientStatus(status) ? errorText(err) : `HTTP ${status}`;
    this.logger.warn(`App Store Server API (${env}) unavailable: ${detail}`);
    return new IapValidationError(
      'iap_store_unavailable',
      `App Store Server API unavailable (${status || 'no response'})`,
      opts,
    );
  }

  private requireServerApi(): void {
    if (this.credentials.serverApi === 'ok' && this.signingKey) return;
    throw new IapValidationError(
      'iap_not_configured',
      this.credentials.serverApi === 'invalid_key'
        ? 'APPLE_PRIVATE_KEY is not a valid P-256 private key (.p8)'
        : 'App Store Server API credentials are not set (APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY)',
    );
  }

  private environmentOrder(hint: IapValidationRequest['environment']): AppleEnv[] {
    const sandboxFirst = hint ? hint === 'Sandbox' : this.useSandboxFirst;
    return sandboxFirst ? ['sandbox', 'production'] : ['production', 'sandbox'];
  }

  /** ES256 JWT for the App Store Server API, reused until 5 minutes before expiry. */
  private serverApiToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.cachedToken.expiresAt - 300 > now) return this.cachedToken.token;

    const header = { alg: 'ES256', kid: this.keyId, typ: 'JWT' };
    const payload = {
      iss: this.issuerId,
      iat: now,
      exp: now + TOKEN_TTL_S,
      aud: 'appstoreconnect-v1',
      bid: this.bundleId,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signer = createSign('sha256');
    signer.update(signingInput);
    // JOSE wants the raw R||S signature, not DER.
    const signature = signer.sign({ key: this.signingKey!, dsaEncoding: 'ieee-p1363' });
    const token = `${signingInput}.${base64url(signature)}`;
    this.cachedToken = { token, expiresAt: now + TOKEN_TTL_S };
    return token;
  }

  // ---------- StoreKit 1 app receipt: legacy verifyReceipt ----------

  private async validateAppReceipt(
    receipt: string,
    req: IapValidationRequest,
  ): Promise<IapValidationResult> {
    if (!this.sharedSecret) {
      throw new IapValidationError(
        'iap_receipt_unsupported',
        'StoreKit 1 app receipts are not accepted (APPLE_SHARED_SECRET is not set); ' +
          'send the StoreKit 2 signed transaction',
      );
    }

    for (const env of this.environmentOrder(req.environment)) {
      let body: VerifyReceiptResponse;
      try {
        const resp = await firstValueFrom(
          this.http.post<VerifyReceiptResponse>(
            VERIFY_RECEIPT_URL[env],
            {
              'receipt-data': receipt,
              password: this.sharedSecret,
              'exclude-old-transactions': true,
            },
            { timeout: HTTP_TIMEOUT_MS },
          ),
        );
        body = resp.data;
      } catch (err: unknown) {
        const status = httpStatusOf(err);
        this.logger.warn(`Apple verifyReceipt (${env}) unavailable: ${errorText(err)}`);
        throw new IapValidationError(
          'iap_store_unavailable',
          `Apple verifyReceipt unavailable (${status || 'no response'})`,
          { providerStatus: status },
        );
      }

      const status = body?.status;
      if (status === 0) return this.toReceiptResult(body, env);
      // The receipt belongs to the other environment.
      if (status === 21007 && env === 'production') continue;
      if (status === 21008 && env === 'sandbox') continue;

      const reason = APPLE_STATUS[status] ?? `Unknown Apple status ${status}`;
      if (status === 21004) {
        this.logger.error('Apple verifyReceipt refused APPLE_SHARED_SECRET (21004)');
        throw new IapValidationError('iap_store_auth_failed', reason, { providerCode: status });
      }
      if (status === 21005 || status === 21009 || (status >= 21100 && status <= 21199)) {
        throw new IapValidationError('iap_store_unavailable', reason, { providerCode: status });
      }
      throw new IapValidationError('iap_store_rejected', reason, { providerCode: status });
    }

    throw new IapValidationError(
      'iap_store_rejected',
      'Apple rejected the receipt in both environments',
    );
  }

  private toReceiptResult(body: VerifyReceiptResponse, env: AppleEnv): IapValidationResult {
    const receiptBundleId = body.receipt?.bundle_id;
    if (receiptBundleId !== this.bundleId) {
      throw new IapValidationError(
        'iap_bundle_mismatch',
        `Bundle id mismatch (expected ${this.bundleId}, got ${printable(receiptBundleId)})`,
      );
    }

    const pro = [...(body.latest_receipt_info ?? []), ...(body.receipt?.in_app ?? [])].filter(
      (txn) => txn.product_id === PRO_PRODUCT_ID && txn.transaction_id,
    );
    if (pro.length === 0) {
      throw new IapValidationError(
        'iap_product_mismatch',
        `Receipt holds no ${PRO_PRODUCT_ID} transaction`,
      );
    }
    const txn = pro.find((t) => !t.cancellation_date_ms);
    if (!txn) {
      throw new IapValidationError('iap_purchase_revoked', 'Every PRO transaction was refunded');
    }

    return {
      valid: true,
      platform: 'ios',
      productId: txn.product_id,
      transactionId: txn.transaction_id,
      originalTransactionId: txn.original_transaction_id,
      storeTransactionId: txn.original_transaction_id ?? txn.transaction_id,
      purchaseDate: txn.purchase_date_ms ? new Date(Number(txn.purchase_date_ms)) : undefined,
      expiresAt: txn.expires_date_ms ? new Date(Number(txn.expires_date_ms)) : undefined,
      environment: body.environment ?? (env === 'production' ? 'Production' : 'Sandbox'),
      bundleId: receiptBundleId,
      provider: 'apple-verifyreceipt',
    };
  }
}

/** An axios message names the failure, never the request body. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
