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
});
