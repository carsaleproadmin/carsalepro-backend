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
  sentry: {
    dsn: process.env.SENTRY_DSN || undefined,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
  },
});
