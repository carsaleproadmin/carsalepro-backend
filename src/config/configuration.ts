import { parseOriginList, resolveCorsOrigins } from './cors';

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  database: {
    url: string;
  };
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    /**
     * DEPRECATED and fatal in production — see `envValidationSchema`.
     *
     * This is a GLOBAL short-circuit inside `createPresignedDownloadUrl`: set it
     * and every private object in the reports bucket, paid inspection PDFs
     * included, resolves to an unsigned URL. Permanent listing photos are served
     * from a separate PUBLIC bucket instead (`r2Public`).
     */
    publicUrl?: string;
  };
  /**
   * Dedicated PUBLIC bucket for showroom listing photos, with its own scoped
   * token and a custom domain in front of it.
   *
   * A separate bucket rather than a public prefix, because publicity in R2 is a
   * property of the bucket: there is no way to expose `listings/` without
   * exposing the paid report PDFs sitting next to it. Blank => the code stays
   * dark and photos keep being served through signed URLs, exactly as before.
   */
  r2Public: {
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    /** Public base URL of that bucket, e.g. `https://img.carsalepro.de`. */
    baseUrl: string;
  };
  quota: {
    freeReportsLimit: number;
    /**
     * Master switch for the legacy FREE-tier report cap. Defaults to **false** —
     * FREE has been unlimited since 2026-08 (PRO sells no-ads + branding, not a
     * report count). When true, `POST /reports` again answers 402 once
     * `freeReportsUsed >= freeReportsLimit`.
     *
     * Deliberately a separate boolean rather than `FREE_REPORTS_LIMIT=0`: a `0`
     * also reads as "zero free reports" and, with `used >= limit`, would reject
     * the very first report. `FREE_REPORTS_LIMIT` is Joi-validated `>= 1` to
     * keep that foot-gun closed.
     */
    enforceFreeLimit: boolean;
    presignedUploadTtl: number;
    presignedDownloadTtl: number;
  };
  nhtsa: {
    baseUrl: string;
  };
  /**
   * Paid VIN history provenance provider (BE-S3). Only 'mock' is implemented;
   * see .env.example. Distinct from `nhtsa`, which is the free VIN decode.
   */
  vinHistory: {
    provider: string;
    apiKey: string;
    /**
     * CarAPI's key. Separate from `apiKey` on purpose: they are two accounts
     * with two balances, and a single shared field would send one provider's
     * credential to the other the moment `provider` is switched.
     */
    carapiKey: string;
    /**
     * Lets the MOCK provider sell in production. Off by default, because
     * charging for generated data without meaning to is the worst possible
     * failure here.
     *
     * A separate flag rather than flipping `MockVinHistoryProvider.configured`,
     * so `synthetic: true` keeps riding on every payload, DTO, page and PDF —
     * the buyer is told what they bought in all four places whether or not this
     * is on.
     */
    allowSyntheticSale: boolean;
  };
  iap: {
    mode: 'client-trust' | 'server';
    bundleId: string;
    /**
     * True when `IAP_BUNDLE_ID` or `GOOGLE_PLAY_PACKAGE_NAME` still holds the
     * retired `com.carsalepro.app`. The value is IGNORED (see the resolver
     * below) and reported by the startup check, so the environment can be
     * corrected without the boot depending on it.
     */
    retiredBundleIdInEnv: boolean;
    apple: {
      sharedSecret: string;
      issuerId: string;
      keyId: string;
      privateKey: string;
      useSandboxFirst: boolean;
    };
    google: {
      packageName: string;
      serviceAccountJson: string;
      subscriptionProductIds: string[];
    };
  };
  sentry: {
    dsn?: string;
    environment: string;
  };
  web: {
    /**
     * THE canonical origin — the first entry of `WEB_ORIGIN`. Absolute URLs are
     * built from it (`auth.service.ts`, `vin-history.service.ts`,
     * `listings.service.ts`, `payments.service.ts`), and those need exactly one
     * answer, which is why the allow-list is a separate field.
     */
    origin: string;
    /** Every browser origin allowed by CORS: `WEB_ORIGIN` + `CORS_ORIGINS`. */
    corsOrigins: string[];
    appEnv: 'development' | 'staging' | 'production';
  };
  redis: {
    url: string;
  };
  auth: {
    jwtSecret: string;
    jwtExpiresIn: string;
    internalApiKey: string;
  };
  signedUrlTtlMinutes: number;
  /**
   * Dedicated PRIVATE bucket for KYC identity documents (SECURITY.md H2), with
   * its own narrowly-scoped R2 API token. When any of the three is blank the
   * R2Service falls back to the main bucket so local dev / CI keep working.
   */
  r2Kyc: {
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
  /**
   * Boot-time self-check (`src/health/startup-check.service.ts`).
   *
   * `strict` false downgrades every fatal finding to an error log — the
   * emergency exit when a check is wrong and production must come up anyway.
   * `allowSharedKycBucket` acknowledges, explicitly, that identity documents are
   * sharing the reports bucket.
   */
  startupCheck: {
    strict: boolean;
    allowSharedKycBucket: boolean;
    internalKey: string;
  };
  stripe: {
    secretKey: string;
    publishableKey: string;
    webhookSecret: string;
    /**
     * The signing secret of the CONNECT endpoint, which is a different one.
     *
     * Stripe gives every webhook endpoint its own secret, and connected-account
     * events (`account.updated`) can only be delivered by a Connect endpoint.
     * Two endpoints therefore cannot share one route: whichever secret the
     * route holds, the other endpoint's events fail the signature check.
     */
    connectWebhookSecret: string;
    connectRefreshUrl: string;
    connectReturnUrl: string;
    /** ISO 3166-1 alpha-2, upper case. Where a connected account lands by default. */
    connectDefaultCountry: string;
  };
  mapbox: {
    token: string;
  };
  email: {
    resendApiKey: string;
    from: string;
    replyTo?: string;
  };
  sms: {
    twilioAccountSid: string;
    twilioAuthToken: string;
    twilioFrom: string;
  };
  push: {
    fcmServiceAccountJson: string;
  };
}

/**
 * The bundle identifier the app actually ships (see
 * `android/app/build.gradle.kts` and `codemagic.yaml`).
 */
const SHIPPED_BUNDLE_ID = 'us.designkey.carsalepro';

/**
 * A package that has never existed. It was this project's compiled default
 * until 2026-08-19 and, because `GOOGLE_PLAY_PACKAGE_NAME` falls through to
 * `IAP_BUNDLE_ID`, it pointed BOTH stores' server-side validation at nothing.
 */
const RETIRED_BUNDLE_ID = 'com.carsalepro.app';

/**
 * A bundle id from the environment, or `undefined` when it is blank or holds
 * the retired package.
 *
 * The retired value is ignored rather than obeyed or refused. It cannot ever be
 * correct — no such package exists in either store — so honouring it would
 * reject every receipt, and failing the boot over it (which is what shipped)
 * takes the whole API down for a mobile-only feature and can only be repaired
 * from a dashboard. Ignoring it resolves to the id the app really ships, and
 * the startup check reports the stale variable so it still gets cleaned up.
 */
const bundleIdFromEnv = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === RETIRED_BUNDLE_ID) return undefined;
  return trimmed;
};

const holdsRetiredBundleId = (value: string | undefined): boolean =>
  value?.trim() === RETIRED_BUNDLE_ID;

export default (): AppConfig => ({
  nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) || 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  logLevel: (process.env.LOG_LEVEL as AppConfig['logLevel']) || 'info',
  database: {
    url: process.env.DATABASE_URL ?? '',
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    bucket: process.env.R2_BUCKET ?? 'carsalepro-reports',
    publicUrl: process.env.R2_PUBLIC_URL || undefined,
  },
  r2Public: {
    accessKeyId: process.env.R2_PUBLIC_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_PUBLIC_SECRET_ACCESS_KEY ?? '',
    bucket: process.env.R2_PUBLIC_BUCKET ?? '',
    baseUrl: (process.env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
  },
  quota: {
    freeReportsLimit: parseInt(process.env.FREE_REPORTS_LIMIT ?? '3', 10),
    enforceFreeLimit: (process.env.ENFORCE_FREE_REPORT_LIMIT ?? 'false') === 'true',
    presignedUploadTtl: parseInt(process.env.PRESIGNED_UPLOAD_TTL ?? '900', 10),
    presignedDownloadTtl: parseInt(process.env.PRESIGNED_DOWNLOAD_TTL ?? '3600', 10),
  },
  nhtsa: {
    baseUrl: process.env.NHTSA_BASE_URL ?? 'https://vpic.nhtsa.dot.gov/api',
  },
  vinHistory: {
    provider: process.env.VIN_HISTORY_PROVIDER ?? 'mock',
    apiKey: process.env.VIN_HISTORY_API_KEY ?? '',
    carapiKey: process.env.CARAPI_API_KEY ?? '',
    allowSyntheticSale: (process.env.VIN_HISTORY_ALLOW_SYNTHETIC_SALE ?? 'false') === 'true',
  },
  iap: {
    mode: (process.env.IAP_VALIDATION_MODE as 'client-trust' | 'server') || 'client-trust',
    // The retired `com.carsalepro.app` is ignored wherever it comes from — see
    // `bundleIdFromEnv`. Both stores' server-side validation used to point at
    // it, because `GOOGLE_PLAY_PACKAGE_NAME` falls through to this value.
    bundleId: bundleIdFromEnv(process.env.IAP_BUNDLE_ID) ?? SHIPPED_BUNDLE_ID,
    retiredBundleIdInEnv:
      holdsRetiredBundleId(process.env.IAP_BUNDLE_ID) ||
      holdsRetiredBundleId(process.env.GOOGLE_PLAY_PACKAGE_NAME),
    apple: {
      sharedSecret: process.env.APPLE_SHARED_SECRET ?? '',
      issuerId: process.env.APPLE_ISSUER_ID ?? '',
      keyId: process.env.APPLE_KEY_ID ?? '',
      privateKey: (process.env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      useSandboxFirst: (process.env.APPLE_USE_SANDBOX_FIRST ?? 'false') === 'true',
    },
    google: {
      packageName:
        bundleIdFromEnv(process.env.GOOGLE_PLAY_PACKAGE_NAME) ??
        bundleIdFromEnv(process.env.IAP_BUNDLE_ID) ??
        SHIPPED_BUNDLE_ID,
      serviceAccountJson: process.env.GOOGLE_PLAY_SA_JSON ?? '',
      subscriptionProductIds: (process.env.GOOGLE_PLAY_SUBSCRIPTION_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
  },
  sentry: {
    dsn: process.env.SENTRY_DSN || undefined,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
  },
  web: {
    origin: parseOriginList(process.env.WEB_ORIGIN ?? '')[0] ?? 'http://localhost:3000',
    // `||`, not `??`: WEB_ORIGIN is Joi-allowed to be blank, and a blank one must
    // fall back to the same canonical origin `origin` above falls back to —
    // otherwise the allow-list would silently be empty while links still work.
    corsOrigins: resolveCorsOrigins(
      process.env.WEB_ORIGIN || 'http://localhost:3000',
      process.env.CORS_ORIGINS ?? '',
    ),
    appEnv: (process.env.APP_ENV as AppConfig['web']['appEnv']) || 'development',
  },
  redis: {
    url: process.env.REDIS_URL ?? '',
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET ?? 'dev-shared-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
    internalApiKey: process.env.INTERNAL_API_KEY ?? '',
  },
  signedUrlTtlMinutes: parseInt(process.env.SIGNED_URL_TTL_MINUTES ?? '15', 10),
  r2Kyc: {
    accessKeyId: process.env.R2_KYC_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_KYC_SECRET_ACCESS_KEY ?? '',
    bucket: process.env.R2_KYC_BUCKET ?? '',
  },
  startupCheck: {
    strict: (process.env.STARTUP_CHECK_STRICT ?? 'true') === 'true',
    allowSharedKycBucket: (process.env.ALLOW_SHARED_KYC_BUCKET ?? 'false') === 'true',
    internalKey: process.env.INTERNAL_API_KEY ?? '',
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    connectWebhookSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? '',
    connectRefreshUrl: process.env.STRIPE_CONNECT_REFRESH_URL ?? '',
    connectReturnUrl: process.env.STRIPE_CONNECT_RETURN_URL ?? '',
    /*
     * Normalised HERE and not only in Joi: `@nestjs/config` writes a validated
     * value back into `process.env` only for keys that were ABSENT, so a
     * deployment that sets `de` keeps `de` here while Joi's `.uppercase()`
     * reports success. Stripe rejects a lower-case country code.
     */
    connectDefaultCountry: (process.env.STRIPE_CONNECT_DEFAULT_COUNTRY ?? 'DE').trim().toUpperCase(),
  },
  mapbox: {
    token: process.env.MAPBOX_TOKEN ?? '',
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    /*
     * The sender domain must be VERIFIED with Resend, and the verified domain
     * is the `notifications.` subdomain — not the apex. Resend matches the
     * From domain exactly: a subdomain verification does not cover
     * carsalepro.de, and the apex is not verified. Both earlier defaults were
     * refused with "403 The <domain> domain is not verified", which made every
     * address verification and every password reset undeliverable while
     * nothing in the API answer said so.
     */
    from: process.env.EMAIL_FROM ?? 'CarSalePro <no-reply@notifications.carsalepro.de>',
    replyTo: process.env.EMAIL_REPLY_TO || undefined,
  },
  sms: {
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    twilioFrom: process.env.TWILIO_FROM ?? '',
  },
  push: {
    fcmServiceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON ?? '',
  },
});
