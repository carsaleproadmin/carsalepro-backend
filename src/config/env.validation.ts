import * as Joi from 'joi';
import { parseOriginList } from './cors';

/**
 * `WEB_ORIGIN` is primarily ONE canonical origin (it builds absolute links in
 * emails, Stripe return URLs and listing/VIN-history URLs, all of which need
 * exactly one answer). For backward compatibility it may also hold a
 * comma-separated list — the first entry is canonical, every entry is
 * CORS-allowed — so the old `.uri()` rule, which rejects a list outright, is
 * replaced by a per-item check.
 */
const originList = (label: string) =>
  Joi.string()
    .allow('')
    .custom((value: string, helpers) => {
      for (const origin of parseOriginList(value)) {
        const { error } = Joi.string().uri().validate(origin);
        if (error) {
          return helpers.error('any.custom', {
            message: `${label} contains an invalid origin: ${origin}`,
          });
        }
      }
      return value;
    });

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3000),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
    .default('info'),

  WEB_ORIGIN: originList('WEB_ORIGIN').default('http://localhost:3000'),
  // Purely additive browser allow-list. `https://www.carsalepro.de` was in
  // neither WEB_ORIGIN nor the Vercel preview pattern, so every browser call
  // from the real production domain — signup, password reset, email
  // verification, the public report check — was blocked by CORS (F-01).
  CORS_ORIGINS: originList('CORS_ORIGINS').default(''),
  APP_ENV: Joi.string().valid('development', 'staging', 'production').default('development'),

  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),

  REDIS_URL: Joi.string().allow('').default(''),

  R2_ACCOUNT_ID: Joi.string().allow('').default(''),
  R2_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  R2_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  R2_BUCKET: Joi.string().default('carsalepro-reports'),
  // RETIRED. Kept in the schema only so a deployment that still carries it
  // fails LOUDLY at boot (see the production block below) instead of quietly
  // serving every paid report PDF unsigned. Use R2_PUBLIC_BUCKET instead.
  R2_PUBLIC_URL: Joi.string().uri().allow('').default(''),
  // Dedicated PUBLIC bucket for showroom listing photos. All four blank in
  // dev/CI => permanent URLs stay off and signed URLs keep being served.
  R2_PUBLIC_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  R2_PUBLIC_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  R2_PUBLIC_BUCKET: Joi.string().allow('').default(''),
  R2_PUBLIC_BASE_URL: Joi.string().uri().allow('').default(''),
  // Dedicated PRIVATE bucket + narrowly-scoped token for KYC identity documents
  // (SECURITY.md H2). Blank in dev/CI => R2Service falls back to the main bucket.
  R2_KYC_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  R2_KYC_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  R2_KYC_BUCKET: Joi.string().allow('').default(''),
  SIGNED_URL_TTL_MINUTES: Joi.number().integer().min(1).max(1440).default(15),

  // Auth (shared HS256 secret with the website NextAuth)
  JWT_SECRET: Joi.string().allow('').default('dev-shared-secret-change-me'),
  JWT_EXPIRES_IN: Joi.string().default('30d'),
  // Dedicated key for the internal oauth-upsert endpoint. When unset, the
  // endpoint falls back to comparing against JWT_SECRET (legacy behavior).
  INTERNAL_API_KEY: Joi.string().allow('').default(''),

  // Stripe
  STRIPE_SECRET_KEY: Joi.string().allow('').default(''),
  STRIPE_PUBLISHABLE_KEY: Joi.string().allow('').default(''),
  STRIPE_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  STRIPE_CONNECT_REFRESH_URL: Joi.string().uri().allow('').default(''),
  STRIPE_CONNECT_RETURN_URL: Joi.string().uri().allow('').default(''),

  // Mapbox (server-side geocoding)
  MAPBOX_TOKEN: Joi.string().allow('').default(''),

  // Notifications — email goes through Resend; blank key => dev outbox (logs).
  RESEND_API_KEY: Joi.string().allow('').default(''),
  // Must be on a domain verified with Resend. `notifications.carsalepro.de` is
  // the verified one; the apex is not. Keep this equal to the default in
  // configuration.ts, which carries the full note.
  EMAIL_FROM: Joi.string()
    .allow('')
    .default('CarSalePro <no-reply@notifications.carsalepro.de>'),
  EMAIL_REPLY_TO: Joi.string().allow('').default(''),
  TWILIO_ACCOUNT_SID: Joi.string().allow('').default(''),
  TWILIO_AUTH_TOKEN: Joi.string().allow('').default(''),
  TWILIO_FROM: Joi.string().allow('').default(''),
  FCM_SERVICE_ACCOUNT_JSON: Joi.string().allow('').default(''),

  // Scheduler (E11) — 'false' disables the in-process cron jobs.
  SCHEDULER_ENABLED: Joi.string().valid('true', 'false').default('true'),

  // The FREE-tier cap is OFF by default (FREE is unlimited since 2026-08). The
  // limit itself stays configurable for the rare case the gate is switched back
  // on, and is `.min(1)` so it can never double as an accidental kill switch.
  FREE_REPORTS_LIMIT: Joi.number().integer().min(1).default(3),
  ENFORCE_FREE_REPORT_LIMIT: Joi.boolean().default(false),
  PRESIGNED_UPLOAD_TTL: Joi.number().integer().min(60).max(86400).default(900),
  PRESIGNED_DOWNLOAD_TTL: Joi.number().integer().min(60).max(86400).default(3600),

  NHTSA_BASE_URL: Joi.string().uri().default('https://vpic.nhtsa.dot.gov/api'),

  // Paid VIN history (BE-S3). 'mock', 'carsxe' and 'aggregate' are implemented;
  // an unknown value falls back to the mock, which refuses PAID unlocks in
  // production. 'aggregate' is the real one: it runs every source that has a key
  // and merges them into one report, so turning a source on is a key, not a
  // release.
  //
  // Deliberately NOT a Joi `.valid(...)`. A typo here should cost a
  // 503 and a loud startup error, not a service that will not boot: the
  // fall-through in vin-history.module.ts already makes the wrong value safe,
  // and refusing to start would take the whole API down over one feature.
  VIN_HISTORY_PROVIDER: Joi.string().allow('').default('mock'),
  VIN_HISTORY_API_KEY: Joi.string().allow('').default(''),
  // The CarAPI key, kept SEPARATE from VIN_HISTORY_API_KEY because the two
  // providers are different accounts with different billing, and one env var
  // holding whichever key the current provider needs is how a CarsXE key ends up
  // being sent to CarAPI — which answers 401 and still charges nobody, so the
  // feature simply stops working with no wrong-looking value anywhere. Empty is
  // valid and means "not configured": the client then makes no call at all and
  // POST /unlock refuses rather than taking money.
  CARAPI_API_KEY: Joi.string().allow('').default(''),
  // Lets the mock provider sell in production. Payloads stay flagged synthetic.
  VIN_HISTORY_ALLOW_SYNTHETIC_SALE: Joi.boolean().default(false),

  // Boot-time self-check. `false` downgrades fatal findings to error logs.
  STARTUP_CHECK_STRICT: Joi.string().valid('true', 'false').default('true'),
  // Explicit acknowledgement that identity documents share the reports bucket.
  ALLOW_SHARED_KYC_BUCKET: Joi.string().valid('true', 'false').default('false'),

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
    // SECURITY.md H2: KYC documents belong in their own private bucket behind
    // their own scoped token, and `R2_KYC_*` is how that is switched on. It is
    // deliberately NOT required here. Hard-failing the boot would take the whole
    // service down to protect a feature that, unset, is merely no better than it
    // was yesterday — KYC objects still never resolve to a public URL, because
    // `kycSignedDownloadUrl` has no `R2_PUBLIC_URL` short-circuit. R2Service logs
    // an error-level warning on every production boot until the vars are set.
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
    // R2_PUBLIC_URL is a GLOBAL switch inside `createPresignedDownloadUrl`: any
    // value makes EVERY private object in the reports bucket — paid inspection
    // PDFs included — resolve to an unsigned, permanent URL. It was introduced
    // for showroom photos, which now come from their own public bucket.
    //
    // Refusing to boot is deliberate. The failure it prevents is silent: nothing
    // errors, nothing logs, the site looks correct, and the paid product is
    // simply free to anyone holding a key. A service that will not start is a
    // page in the deploy log; this is not.
    if (envVars.R2_PUBLIC_URL) {
      return helpers.error('any.custom', {
        message:
          'R2_PUBLIC_URL is retired and must be unset: it exposes the ENTIRE reports bucket, ' +
          'paid report PDFs included. Serve public images from R2_PUBLIC_BUCKET instead.',
      });
    }
  }
  return envVars;
});
