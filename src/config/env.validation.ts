import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3000),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
    .default('info'),

  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),

  R2_ACCOUNT_ID: Joi.string().allow('').default(''),
  R2_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  R2_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  R2_BUCKET: Joi.string().default('carsalepro-reports'),
  R2_PUBLIC_URL: Joi.string().uri().allow('').default(''),

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
}).custom((envVars, helpers) => {
  if (envVars.NODE_ENV === 'production') {
    const requiredInProd = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
    for (const key of requiredInProd) {
      if (!envVars[key]) {
        return helpers.error('any.custom', { message: `${key} is required in production` });
      }
    }
  }
  return envVars;
});
