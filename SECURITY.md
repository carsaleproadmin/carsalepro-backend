# Security — remaining hardening (infra / credentials / design)

The E14 audit's server-side code remediations (H1, H2, H3, M4, M5, L3, L4) are
implemented in this repo. The items below are **not code-complete** here because
they require provisioning, external credentials, or product/design decisions.
Each lists *what*, *why*, and *how to finish*.

## Resolved

### SEC-1 — Raw verification and password-reset tokens on the auth response
- **Was**: `POST /api/v1/auth/register` returned `emailVerification` and
  `POST /api/v1/auth/password-reset` returned `reset`, both containing the raw
  single-use token. Both endpoints are `@Public()`, so anyone who could reach
  `/password-reset` with a known address received a working credential for that
  account. The same endpoint also returned `null` for unknown addresses and an
  object for known ones, making it an account-existence oracle.
- **Now**: `register` returns `{ token, user }` and `password-reset` returns
  `{ ok: true }` unconditionally. The raw token is handed to
  `NotificationsService` (`auth.verify_email` / `auth.password_reset`) and never
  crosses the API boundary. `AuthService.requestPasswordResetAndNotify` resolves
  `void` for known and unknown addresses alike.
- **Delivery**: that made email the *only* route for both tokens, and until
  BE-S5 no provider was actually wired — `EmailProviderImpl` logged to the
  DevOutbox and returned success even with credentials set. It now sends through
  **Resend** whenever `RESEND_API_KEY` is present and `NODE_ENV !== 'test'`.
  Setting that key in each real environment is therefore a prerequisite for
  self-service verification and password reset.
- **Residual**: a known address performs one extra INSERT, so a determined
  attacker behind the 5 req/min throttle could in principle time the difference.
  An artificial delay was considered and rejected — it would make the endpoint
  trivially expensive to hold open. Covered by `test/auth.e2e-spec.ts` cases
  14–18, which assert byte-identical responses and that the link still works
  end to end through the notification.

### L2 — Report submitter is now verified against the assigned inspector
- **Was**: `POST /reports` with an `orderId` advanced that order to SUBMITTED with
  no check on who was uploading. Any device that knew an order id could do it.
  The code documented this in a comment rather than enforcing it.
- **Now**: `ReportsService.assertOrderSubmitter` resolves the submitting device
  to an account via `DeviceLink` and requires it to match `order.inspectorId`.
  It runs **before** the quota gate, so a rejected submission never costs the
  device a free report. Three distinct codes — `device_not_linked` (recoverable
  through link-codes), `not_order_inspector`, `order_not_assigned` — plus a 404
  for an unknown order.
- **Scope**: the check applies **only** when `orderId` is present. Reports
  without one — every submission the shipped Flutter app makes — are untouched;
  requiring a device link on `POST /reports` in general would brick the app.
  `test/order-report-auth.e2e-spec.ts` case 7 is the regression guard for that.
- The service-level `OrdersService.submitReportForOrder(orderId)` is unchanged,
  because admin overrides and the auto-approve cron have no device to check.

### H2 — Dedicated private R2 bucket + scoped credentials for KYC
- **Was**: identity documents lived under the `kyc/` prefix of
  `carsalepro-reports`, the same bucket as public report PDFs, reachable with the
  same credentials. `R2_KYC_ACCESS_KEY_ID` / `R2_KYC_SECRET_ACCESS_KEY` were read
  into config and never used. Worse, `R2Service.createPresignedDownloadUrl`
  short-circuits to `R2_PUBLIC_URL` when that variable is set — the day an
  operator set it, anything sharing that code path became world-readable.
- **Now, enforced in code**:
  - `R2Service` holds a **second `S3Client`** built from the `R2_KYC_*`
    credentials against `R2_KYC_BUCKET`, plus KYC-only methods —
    `kycPresignedUploadUrl`, `kycSignedDownloadUrl`, `kycDeleteObject`,
    `kycDeletePrefix`, `isKycConfigured()`, `isKycDedicated()`. They are separate
    methods rather than a `scope` argument with a default, because a defaulted
    scope is exactly how a KYC object ends up in the public bucket.
  - `kycSignedDownloadUrl` **never** consults `R2_PUBLIC_URL`. `test/kyc.e2e-spec.ts`
    case 14 boots an app with `R2_PUBLIC_URL` set to a sentinel, proves the public
    report path really does short-circuit to it, and then asserts every KYC view
    URL carries `X-Amz-Signature` and contains no trace of the sentinel.
  - `KycDocument.bucket` (migration `20260729040000_…`) records where each object
    lives: NULL = the legacy shared bucket, a value = the dedicated one. Reads
    resolve the client from that column, so pre-migration rows keep working
    through the whole migration window.
  - `env.validation.ts` requires `R2_KYC_ACCESS_KEY_ID`,
    `R2_KYC_SECRET_ACCESS_KEY` and `R2_KYC_BUCKET` when `NODE_ENV=production`;
    the boot fails without them. When they are absent outside production the KYC
    methods fall back to the main client/bucket and log a warning at startup, so
    local dev and CI are unaffected.
  - `MeService.erase` now sweeps `kyc/<userId>/` (resolved through `DeviceLink`)
    via `kycDeletePrefix`, in **both** buckets, and stamps `purgedAt` on the
    matching rows. Previously a GDPR erasure removed reports and photos and left
    the passport scans behind.
- **Still needs a human** (dashboard actions, not code):
  1. Create the private bucket — no public access, **no** custom domain, and it
     must never be given an `R2_PUBLIC_URL`.
  2. Create an R2 API token **scoped to that bucket alone** (object read/write).
     This is a Cloudflare dashboard action; there is no API for scoped-token
     creation. Set `R2_KYC_ACCESS_KEY_ID` / `R2_KYC_SECRET_ACCESS_KEY` /
     `R2_KYC_BUCKET` on Render before the next production deploy — the Joi
     validator will otherwise refuse to boot.
  3. Move the existing objects with
     `npx ts-node scripts/migrate-kyc-objects.ts --dry-run` and then without the
     flag. It copies → verifies with `HeadObject` → updates `kyc_document.bucket`
     → and only then deletes the source, so an interrupted run always leaves the
     document readable. Idempotent and resumable.

## L1 — Switch IAP validation from client-trust to server-side
- **What**: `IAP_VALIDATION_MODE` defaults to `client-trust` — the backend
  trusts the client's claim of a successful in-app purchase.
- **Why**: Before money is actually charged / PRO entitlements are granted on
  real revenue, receipts must be verified against Apple/Google to prevent
  forged-purchase fraud.
- **How to finish**: Provision Apple (`APPLE_SHARED_SECRET`, App Store Server
  API key: `APPLE_ISSUER_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY`) and Google
  Play (`GOOGLE_PLAY_SA_JSON`, subscription product IDs) credentials, then set
  `IAP_VALIDATION_MODE=server`. Validators already exist under
  `src/quota/iap/`.

## L5 — Strictly validate `X-Device-Id` as UUIDv4
- **What**: The `X-Device-Id` header is parsed leniently
  (`src/common/middleware/device-id.middleware.ts`) rather than strictly
  validated as a UUIDv4.
- **Why**: Strict validation would reject malformed / injected device IDs.
- **How to finish**: This is intentionally left lenient to preserve the legacy
  mobile contract (existing app builds may send non-canonical IDs). Tighten to a
  UUIDv4 regex only after confirming all shipped mobile clients comply, ideally
  behind a version gate so older clients aren't locked out.
