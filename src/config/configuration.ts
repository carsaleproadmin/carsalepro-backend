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
    publicUrl?: string;
  };
  quota: {
    freeReportsLimit: number;
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
  };
  iap: {
    mode: 'client-trust' | 'server';
    bundleId: string;
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
    origin: string;
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
  stripe: {
    secretKey: string;
    publishableKey: string;
    webhookSecret: string;
    connectRefreshUrl: string;
    connectReturnUrl: string;
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
  quota: {
    freeReportsLimit: parseInt(process.env.FREE_REPORTS_LIMIT ?? '3', 10),
    presignedUploadTtl: parseInt(process.env.PRESIGNED_UPLOAD_TTL ?? '900', 10),
    presignedDownloadTtl: parseInt(process.env.PRESIGNED_DOWNLOAD_TTL ?? '3600', 10),
  },
  nhtsa: {
    baseUrl: process.env.NHTSA_BASE_URL ?? 'https://vpic.nhtsa.dot.gov/api',
  },
  vinHistory: {
    provider: process.env.VIN_HISTORY_PROVIDER ?? 'mock',
    apiKey: process.env.VIN_HISTORY_API_KEY ?? '',
  },
  iap: {
    mode: (process.env.IAP_VALIDATION_MODE as 'client-trust' | 'server') || 'client-trust',
    bundleId: process.env.IAP_BUNDLE_ID ?? 'com.carsalepro.app',
    apple: {
      sharedSecret: process.env.APPLE_SHARED_SECRET ?? '',
      issuerId: process.env.APPLE_ISSUER_ID ?? '',
      keyId: process.env.APPLE_KEY_ID ?? '',
      privateKey: (process.env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      useSandboxFirst: (process.env.APPLE_USE_SANDBOX_FIRST ?? 'false') === 'true',
    },
    google: {
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME ?? process.env.IAP_BUNDLE_ID ?? 'com.carsalepro.app',
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
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
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
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    connectRefreshUrl: process.env.STRIPE_CONNECT_REFRESH_URL ?? '',
    connectReturnUrl: process.env.STRIPE_CONNECT_RETURN_URL ?? '',
  },
  mapbox: {
    token: process.env.MAPBOX_TOKEN ?? '',
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    from: process.env.EMAIL_FROM ?? 'no-reply@carsalepro.com',
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
