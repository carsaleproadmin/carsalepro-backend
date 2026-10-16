import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createPrivateKey, createSign } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import { base64url, httpBodyOf, httpStatusOf, printable } from './iap-encoding';
import {
  IapValidationError,
  IapValidationRequest,
  IapValidationResult,
  PRO_PRODUCT_ID,
} from './iap.types';

export interface ServiceAccountKey {
  type: 'service_account';
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

interface ProductPurchase {
  kind?: string;
  productId?: string;
  purchaseState?: number; // 0 purchased, 1 cancelled, 2 pending
  consumptionState?: number;
  purchaseTimeMillis?: string;
  orderId?: string;
  acknowledgementState?: number; // 0 yet to be acknowledged, 1 acknowledged
}

/** Play `products.get`: 0 means "purchased"; 1 cancelled, 2 pending. */
const PURCHASED = 0;
/** Play `products.get`: 0 means "yet to be acknowledged". */
const NOT_ACKNOWLEDGED = 0;

const HTTP_TIMEOUT_MS = 10_000;

@Injectable()
export class GoogleValidator {
  private readonly logger = new Logger(GoogleValidator.name);
  private readonly packageName: string;
  private readonly serviceAccount?: ServiceAccountKey;

  // Cached OAuth2 access token
  private cachedToken?: { token: string; expiresAt: number };

  constructor(
    private readonly http: HttpService,
    config: ConfigService<AppConfig, true>,
  ) {
    const iap = config.get('iap', { infer: true });
    this.packageName = iap.google.packageName;
    this.serviceAccount = parseServiceAccount(iap.google.serviceAccountJson, this.logger);
  }

  isConfigured(): boolean {
    return Boolean(this.serviceAccount);
  }

  async validate(req: IapValidationRequest): Promise<IapValidationResult> {
    if (!this.serviceAccount) {
      throw new IapValidationError(
        'iap_not_configured',
        'GOOGLE_PLAY_SA_JSON is not configured - cannot validate Android purchases server-side',
      );
    }
    if (!req.productId) {
      throw new IapValidationError(
        'iap_product_id_required',
        'Android purchases require productId',
      );
    }
    if (!req.receipt) {
      throw new IapValidationError('iap_receipt_empty', 'empty purchaseToken');
    }
    // The product id is part of the URL, so Play answers only for the product
    // the CLIENT names. A token of any other product must not buy PRO.
    //
    // There is no subscription path: PRO is a one-time managed product, and a
    // subscription route would grant a lifetime unlock for a renewable charge.
    // `GOOGLE_PLAY_SUBSCRIPTION_IDS` is ignored (the startup check says so).
    if (req.productId !== PRO_PRODUCT_ID) {
      throw new IapValidationError(
        'iap_product_mismatch',
        `Product mismatch (expected ${PRO_PRODUCT_ID}, got ${printable(req.productId)})`,
      );
    }

    const token = await this.getAccessToken();
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      this.packageName,
    )}/purchases/products/${encodeURIComponent(req.productId)}/tokens/${encodeURIComponent(
      req.receipt,
    )}`;

    let data: ProductPurchase;
    try {
      const resp = await firstValueFrom(
        this.http.get<ProductPurchase>(url, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: HTTP_TIMEOUT_MS,
        }),
      );
      data = resp.data ?? {};
    } catch (err: unknown) {
      throw this.playApiError(err);
    }

    const product = data;
    // Strict: a body WITHOUT purchaseState is not a purchase either.
    if (product.purchaseState !== PURCHASED) {
      throw new IapValidationError(
        'iap_purchase_not_completed',
        `Product purchase state ${product.purchaseState ?? 'missing'} is not "purchased"`,
        { providerCode: product.purchaseState },
      );
    }
    if (product.productId !== undefined && product.productId !== req.productId) {
      throw new IapValidationError(
        'iap_product_mismatch',
        `Product mismatch (expected ${req.productId}, got ${printable(product.productId)})`,
      );
    }
    if (product.acknowledgementState === NOT_ACKNOWLEDGED) {
      await this.acknowledge(url, token);
    }
    return {
      valid: true,
      platform: 'android',
      productId: req.productId,
      transactionId: product.orderId,
      originalTransactionId: product.orderId,
      // A license-test purchase can come without an orderId; the token then
      // identifies the purchase. Only its digest is stored.
      storeTransactionId:
        product.orderId || `token-sha256:${createHash('sha256').update(req.receipt).digest('hex')}`,
      purchaseDate: product.purchaseTimeMillis
        ? new Date(Number(product.purchaseTimeMillis))
        : undefined,
      environment: 'Production',
      bundleId: this.packageName,
      provider: 'google-play',
    };
  }

  /**
   * Play refunds a purchase that nobody acknowledges within three days. The app
   * acknowledges it too (`completePurchase`), so a failure here is logged and
   * does NOT refuse a purchase that Play has just confirmed.
   */
  private async acknowledge(purchaseUrl: string, token: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post(
          `${purchaseUrl}:acknowledge`,
          {},
          { headers: { Authorization: `Bearer ${token}` }, timeout: HTTP_TIMEOUT_MS },
        ),
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Google Play acknowledge failed (${httpStatusOf(err) || 'no response'}); ` +
          'the app acknowledges the purchase too',
      );
    }
  }

  private playApiError(err: unknown): IapValidationError {
    const status = httpStatusOf(err);
    const apiMessage = httpBodyOf<{ error?: { message?: string } }>(err)?.error?.message ?? '';
    const msg = apiMessage || (err instanceof Error ? err.message : 'unknown error');
    const opts = { providerCode: status, providerStatus: status };
    if (status === 400 || status === 404 || status === 410) {
      return new IapValidationError(
        'iap_store_rejected',
        `Google Play rejected token: ${msg}`,
        opts,
      );
    }
    if (status === 401 || status === 403) {
      this.logger.error(
        `Google Play API refused the service account (${status}): ${msg}. Give it ` +
          'access to the app in Play Console (financial data + orders).',
      );
      return new IapValidationError(
        'iap_store_auth_failed',
        `Google Play API refused the service account (${status})`,
        opts,
      );
    }
    this.logger.warn(`Google Play API unavailable (${status || 'no response'}): ${msg}`);
    return new IapValidationError(
      'iap_store_unavailable',
      `Google Play API unavailable (${status || 'no response'})`,
      opts,
    );
  }

  /** OAuth2 access token via JWT bearer flow (service account). */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) {
      return this.cachedToken.token;
    }
    if (!this.serviceAccount) {
      throw new IapValidationError('iap_not_configured', 'service account not configured');
    }

    const iat = Math.floor(now / 1000);
    const exp = iat + 3600;
    const tokenUri = this.serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: tokenUri,
      iat,
      exp,
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

    let assertion: string;
    try {
      const signer = createSign('RSA-SHA256');
      signer.update(signingInput);
      assertion = `${signingInput}.${base64url(signer.sign(this.serviceAccount.private_key))}`;
    } catch {
      throw new IapValidationError(
        'iap_not_configured',
        'GOOGLE_PLAY_SA_JSON private_key cannot sign (not a valid RSA key)',
      );
    }

    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    let data: { access_token?: string; expires_in?: number };
    try {
      const resp = await firstValueFrom(
        this.http.post<{ access_token: string; expires_in: number; token_type: string }>(
          tokenUri,
          params.toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: HTTP_TIMEOUT_MS,
          },
        ),
      );
      data = resp.data ?? {};
    } catch (err: unknown) {
      const status = httpStatusOf(err);
      if (status === 400 || status === 401) {
        this.logger.error(`Google OAuth refused the service account (${status})`);
        throw new IapValidationError(
          'iap_store_auth_failed',
          `Google OAuth refused the service account (${status})`,
          { providerStatus: status },
        );
      }
      throw new IapValidationError(
        'iap_store_unavailable',
        `Google OAuth unavailable (${status || 'no response'})`,
        { providerStatus: status },
      );
    }
    if (!data.access_token) {
      throw new IapValidationError('iap_store_unavailable', 'Google OAuth answered with no token');
    }

    this.cachedToken = {
      token: data.access_token,
      expiresAt: now + (data.expires_in ?? 3600) * 1000,
    };
    return data.access_token;
  }
}

/** The service account from `GOOGLE_PLAY_SA_JSON` (raw or base64 JSON), or undefined. */
export function parseServiceAccount(raw: string, logger?: Logger): ServiceAccountKey | undefined {
  if (!raw) return undefined;
  try {
    const trimmed = raw.trim();
    // Allow base64-wrapped JSON for env-var safety
    const json = trimmed.startsWith('{')
      ? trimmed
      : Buffer.from(trimmed, 'base64').toString('utf8');
    const sa = JSON.parse(json) as ServiceAccountKey;
    if (sa.type !== 'service_account' || !sa.client_email || !sa.private_key) {
      logger?.warn('GOOGLE_PLAY_SA_JSON missing required fields - Google validation disabled');
      return undefined;
    }
    // The PEM in env vars often has literal \n — normalize.
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return sa;
  } catch (err) {
    // The parser message can quote the input, and the input holds a private key.
    logger?.warn(`Failed to parse GOOGLE_PLAY_SA_JSON (${(err as Error).name})`);
    return undefined;
  }
}

/** Usability of `GOOGLE_PLAY_SA_JSON`. Secret-free: the startup check prints it. */
export type GoogleCredentialStatus = 'ok' | 'missing' | 'unparseable' | 'invalid_key';

export function googleCredentialStatus(raw: string): GoogleCredentialStatus {
  if (!raw) return 'missing';
  const sa = parseServiceAccount(raw);
  if (!sa) return 'unparseable';
  try {
    return createPrivateKey(sa.private_key).asymmetricKeyType === 'rsa' ? 'ok' : 'invalid_key';
  } catch {
    return 'invalid_key';
  }
}
