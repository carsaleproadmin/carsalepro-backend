import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { AppConfig } from '../../config/configuration';
import { IapValidationError, IapValidationRequest, IapValidationResult } from './iap.types';

interface ServiceAccountKey {
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
  acknowledgementState?: number;
}

interface SubscriptionPurchase {
  kind?: string;
  startTimeMillis?: string;
  expiryTimeMillis?: string;
  autoRenewing?: boolean;
  paymentState?: number; // 0 pending, 1 received, 2 free trial, 3 deferred
  orderId?: string;
}

@Injectable()
export class GoogleValidator {
  private readonly logger = new Logger(GoogleValidator.name);
  private readonly packageName: string;
  private readonly subscriptionProductIds: Set<string>;
  private readonly serviceAccount?: ServiceAccountKey;

  // Cached OAuth2 access token
  private cachedToken?: { token: string; expiresAt: number };

  constructor(
    private readonly http: HttpService,
    config: ConfigService<AppConfig, true>,
  ) {
    const iap = config.get('iap', { infer: true });
    this.packageName = iap.google.packageName;
    this.subscriptionProductIds = new Set(iap.google.subscriptionProductIds);
    this.serviceAccount = parseServiceAccount(iap.google.serviceAccountJson, this.logger);
  }

  isConfigured(): boolean {
    return Boolean(this.serviceAccount);
  }

  async validate(req: IapValidationRequest): Promise<IapValidationResult> {
    if (!this.serviceAccount) {
      throw new IapValidationError(
        'GOOGLE_PLAY_SA_JSON is not configured — cannot validate Android receipts server-side',
      );
    }
    if (!req.productId) {
      throw new IapValidationError('Android receipts require productId');
    }
    if (!req.receipt) {
      throw new IapValidationError('empty purchaseToken');
    }

    const token = await this.getAccessToken();
    const isSubscription = this.subscriptionProductIds.has(req.productId);
    const apiPath = isSubscription ? 'subscriptions' : 'products';
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
        this.packageName,
      )}/purchases/${apiPath}/${encodeURIComponent(req.productId)}/tokens/${encodeURIComponent(
        req.receipt,
      )}`;

    try {
      const resp = await firstValueFrom(
        this.http.get<ProductPurchase | SubscriptionPurchase>(url, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10_000,
        }),
      );
      const data = resp.data;

      if (isSubscription) {
        const sub = data as SubscriptionPurchase;
        if (sub.paymentState !== undefined && ![1, 2].includes(sub.paymentState)) {
          throw new IapValidationError(
            `Subscription payment state ${sub.paymentState} is not active`,
            sub.paymentState,
          );
        }
        return {
          valid: true,
          platform: 'android',
          productId: req.productId,
          transactionId: sub.orderId,
          originalTransactionId: sub.orderId,
          purchaseDate: sub.startTimeMillis ? new Date(Number(sub.startTimeMillis)) : undefined,
          expiresAt: sub.expiryTimeMillis ? new Date(Number(sub.expiryTimeMillis)) : undefined,
          environment: 'Production', // Play Developer API does not expose env on response
          bundleId: this.packageName,
          provider: 'google-play',
        };
      }

      const product = data as ProductPurchase;
      if (product.purchaseState !== undefined && product.purchaseState !== 0) {
        throw new IapValidationError(
          `Product purchase state ${product.purchaseState} is not "purchased"`,
          product.purchaseState,
        );
      }
      return {
        valid: true,
        platform: 'android',
        productId: req.productId,
        transactionId: product.orderId,
        originalTransactionId: product.orderId,
        purchaseDate: product.purchaseTimeMillis
          ? new Date(Number(product.purchaseTimeMillis))
          : undefined,
        environment: 'Production',
        bundleId: this.packageName,
        provider: 'google-play',
      };
    } catch (err: unknown) {
      if (err instanceof IapValidationError) throw err;
      const status =
        typeof err === 'object' && err !== null && 'response' in err
          ? ((err as { response?: { status?: number; data?: { error?: { message?: string } } } })
              .response?.status ?? 0)
          : 0;
      const apiMessage =
        typeof err === 'object' && err !== null && 'response' in err
          ? ((err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error
              ?.message ?? '')
          : '';
      const msg = apiMessage || (err instanceof Error ? err.message : String(err));
      if (status === 404 || status === 400) {
        throw new IapValidationError(`Google Play rejected token: ${msg}`, status);
      }
      throw new IapValidationError(`Google Play API error (${status || 'no status'}): ${msg}`, status);
    }
  }

  /** OAuth2 access token via JWT bearer flow (service account). */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) {
      return this.cachedToken.token;
    }
    if (!this.serviceAccount) throw new IapValidationError('service account not configured');

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
    const headerB64 = base64url(JSON.stringify(header));
    const payloadB64 = base64url(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    const signature = signer.sign(this.serviceAccount.private_key);
    const sigB64 = base64url(signature);
    const assertion = `${signingInput}.${sigB64}`;

    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const resp = await firstValueFrom(
      this.http.post<{ access_token: string; expires_in: number; token_type: string }>(
        tokenUri,
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10_000,
        },
      ),
    );

    const token = resp.data.access_token;
    this.cachedToken = {
      token,
      expiresAt: now + resp.data.expires_in * 1000,
    };
    return token;
  }
}

function parseServiceAccount(raw: string, logger: Logger): ServiceAccountKey | undefined {
  if (!raw) return undefined;
  try {
    const trimmed = raw.trim();
    // Allow base64-wrapped JSON for env-var safety
    const json =
      trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
    const sa = JSON.parse(json) as ServiceAccountKey;
    if (sa.type !== 'service_account' || !sa.client_email || !sa.private_key) {
      logger.warn('GOOGLE_PLAY_SA_JSON missing required fields — Google validation disabled');
      return undefined;
    }
    // The PEM in env vars often has literal \n — normalize.
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return sa;
  } catch (err) {
    logger.warn(`Failed to parse GOOGLE_PLAY_SA_JSON: ${(err as Error).message}`);
    return undefined;
  }
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
