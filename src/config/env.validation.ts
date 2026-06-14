import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3000),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
    .default('info'),

  WEB_ORIGIN: Joi.string().uri().allow('').default('http://localhost:3000'),
  APP_ENV: Joi.string().valid('development', 'staging', 'production').default('development'),

  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),

  REDIS_URL: Joi.string().allow('').default(''),

  R2_ACCOUNT_ID: Joi.string().allow('').default(''),
  R2_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  R2_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  R2_BUCKET: Joi.string().default('carsalepro-reports'),
  R2_PUBLIC_URL: Joi.string().uri().allow('').default(''),
  R2_KYC_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  R2_KYC_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  SIGNED_URL_TTL_MINUTES: Joi.number().integer().min(1).max(1440).default(15),

  // Auth (shared HS256 secret with the website NextAuth)
  JWT_SECRET: Joi.string().allow('').default('dev-shared-secret-change-me'),
  JWT_EXPIRES_IN: Joi.string().default('30d'),

  // Stripe
  STRIPE_SECRET_KEY: Joi.string().allow('').default(''),
  STRIPE_PUBLISHABLE_KEY: Joi.string().allow('').default(''),
  STRIPE_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  STRIPE_CONNECT_REFRESH_URL: Joi.string().uri().allow('').default(''),
  STRIPE_CONNECT_RETURN_URL: Joi.string().uri().allow('').default(''),

  // Mapbox (server-side geocoding)
  MAPBOX_TOKEN: Joi.string().allow('').default(''),

  // Notifications
  SENDGRID_API_KEY: Joi.string().allow('').default(''),
  EMAIL_FROM: Joi.string().allow('').default('no-reply@carsalepro.com'),
  TWILIO_ACCOUNT_SID: Joi.string().allow('').default(''),
  TWILIO_AUTH_TOKEN: Joi.string().allow('').default(''),
  TWILIO_FROM: Joi.string().allow('').default(''),
  FCM_SERVICE_ACCOUNT_JSON: Joi.string().allow('').default(''),

  // Scheduler (E11) — 'false' disables the in-process cron jobs.
  SCHEDULER_ENABLED: Joi.string().valid('true', 'false').default('true'),

  FREE_REPORTS_LIMIT: Joi.number().integer().min(0).default(3),
  PRESIGNED_UPLOAD_TTL: Joi.number().integer().min(60).max(86400).default(900),
  PRESIGNED_DOWNLOAD_TTL: Joi.number().integer().min(60).max(86400).default(3600),

  NHTSA_BASE_URL: Joi.string().uri().default('https://vpic.nhtsa.dot.gov/api'),

  IAP_VALIDATION_MODE: Joi.string().valid('client-trust', 'server').default('client-trust'),
  IAP_BUNDLE_ID: Joi.string().default('com.carsalepro.app'),
  APPLE_SHARED_SECRET: Joi.string().allow('').default(''),
  APPLE_ISSUER_ID: Joi.string().allow('').default(''),
  APPLE_KEY_ID: Joi.string().allow('').default(''),
  APPLE_PRIVATE_KEY: Joi.string().allow('').default(''),
  APPLE_USE_SANDBOX_FIRST: Joi.string().valid('true', 'false').default('false'),
  GOOGLE_PLAY_PACKAGE_NAME: Joi.string().allow('').default(''),
  GOOGLE_PLAY_SA_JSON: Joi.string().allow('').default(''),
  GOOGLE_PLAY_SUBSCRIPTION_IDS: Joi.string().allow('').default(''),

  SENTRY_DSN: Joi.string().allow('').default(''),
  SENTRY_ENVIRONMENT: Joi.string().default('development'),
  SENTRY_TEST_ENABLED: Joi.string().valid('true', 'false').default('false'),
}).custom((envVars, helpers) => {
  if (envVars.NODE_ENV === 'production') {
    const requiredInProd = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
    for (const key of requiredInProd) {
      if (!envVars[key]) {
        return helpers.error('any.custom', { message: `${key} is required in production` });
      }
    }
    // The HS256 signing secret (shared with the website NextAuth) must be strong
    // and never the development default in production.
    const secret = envVars.JWT_SECRET;
    if (!secret || secret === 'dev-shared-secret-change-me' || secret.length < 32) {
      return helpers.error('any.custom', {
        message: 'JWT_SECRET must be set to a strong value (>= 32 chars, not the default) in production',
      });
    }
  }
  return envVars;
});
