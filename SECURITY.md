# Security — remaining hardening (infra / credentials / design)

The E14 audit's server-side code remediations (H1, H3, M4, M5, L3, L4) are
implemented in this repo. The items below are **not code-complete** here because
they require provisioning, external credentials, or product/design decisions.
Each lists *what*, *why*, and *how to finish*.

## H2 — Dedicated private R2 bucket + scoped credentials for KYC
- **What**: KYC documents currently live under the `kyc/` prefix of the same
  R2 bucket as public report PDFs. The code already reads dedicated narrow
  credentials (`R2_KYC_ACCESS_KEY_ID` / `R2_KYC_SECRET_ACCESS_KEY` in
  `src/config/configuration.ts`), but no separate private bucket or scoped token
  is wired up yet.
- **Why**: Sensitive identity documents must be isolated from public objects and
  served only via short-lived signed URLs (now enforced in code by
  `R2Service.createPrivateSignedUrl`, used by the KYC admin view path). A scoped
  token limits blast radius if the public bucket's credentials leak.
- **How to finish**: In the Cloudflare dashboard create a private bucket (no
  public access, no `R2_PUBLIC_URL`) and an R2 API token scoped to that bucket /
  the `kyc/` prefix. Point a dedicated R2 client at it using the
  `R2_KYC_*` creds, and route KYC put/get/delete through that client.

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

## L2 — Verify the uploader is the assigned inspector
- **What**: `OrdersService.submitReportForOrder` does not yet confirm that the
  account submitting the report is the inspector actually assigned to the order.
- **Why**: Prevents another (even KYC-verified) inspector from submitting a
  report for an order that isn't theirs.
- **How to finish**: Requires the device↔inspector identity link to be wired
  (so the submitting principal is known). Once available, assert
  `order.inspectorId === submitter.id` (403 otherwise) in
  `submitReportForOrder`.

## L5 — Strictly validate `X-Device-Id` as UUIDv4
- **What**: The `X-Device-Id` header is parsed leniently
  (`src/common/middleware/device-id.middleware.ts`) rather than strictly
  validated as a UUIDv4.
- **Why**: Strict validation would reject malformed / injected device IDs.
- **How to finish**: This is intentionally left lenient to preserve the legacy
  mobile contract (existing app builds may send non-canonical IDs). Tighten to a
  UUIDv4 regex only after confirming all shipped mobile clients comply, ideally
  behind a version gate so older clients aren't locked out.
