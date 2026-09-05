# CarSalePro Backend

The shared NestJS backend for the **CarSalePro** ecosystem. One service, one Postgres + Cloudflare R2, two API surfaces:

- **Mobile MVP (legacy, frozen)** — root routes (`/vin`, `/quota`, `/reports`, `/me`, …) authenticated by the `X-Device-Id` header. Used by the shipped Flutter app; the contract must not change.
- **Website (Phase 2+)** — everything under `/api/v1/*`, authenticated by a Bearer JWT. Powers the Next.js site in `../carsalepro-frontend`: a verified-reports marketplace, an Uber-model inspection exchange with Stripe Connect escrow, KYC, per-order LegalSync contracts, notifications, and an admin panel.

> Full product spec: `../docs/07_Website_MVP_Требования_и_План.md`. End-to-end development report (architecture, per-epic detail, security posture, go-live checklist): `../docs/reports/2026-06-14_carsalepro-website-mvp.md` (+ PDF).

## Quick links

- **Live API:** https://carsalepro-backend.onrender.com · **Swagger:** `/docs` · **OpenAPI JSON:** `/docs-json` · **Health:** `/health`
- **Source:** https://github.com/carsaleproadmin/carsalepro-backend
- **Render service:** `srv-d83o7j1kh4rs73cgjfng` — **paid `starter` plan, always on** (auto-deploys on push to `main`; start command runs `prisma migrate deploy`)
- **Render Postgres:** `dpg-d83o5v3rjlhs73900aig-a` — **paid `basic_256mb` plan**, 1 GB disk (PostgreSQL 16 + PostGIS)
- **Neither is on the free tier.** Both are billed, and have been since July 2026. A free Render service spins down after 15 minutes of idle and a free database expires after 30 days; neither applies here, so the API does not sleep and the database will not lapse. Plans verified through the Render API on 2026-09-05 (`plan: starter` / `plan: basic_256mb`, both `not_suspended`, no `expiresAt`).
- **Cloudflare R2 buckets:** `carsalepro-reports` — private (prefixes: `free/`, `pro/`, `report-photos/`, `listings/`, `kyc/`, `contracts/`, `fonts/`) · optional **public** image bucket (`R2_PUBLIC_*`, served from `https://img.carsalepro.de`) for showroom photos

## Tech stack

| Layer | Choice |
|---|---|
| Runtime / framework | Node.js · NestJS 11 · TypeScript |
| Database | PostgreSQL 16 + **PostGIS** (geo) · Prisma 6 (27 models) |
| Cache / queue backing | Redis (ioredis) — link-codes; in-memory fallback when `REDIS_URL` unset |
| Object store | Cloudflare R2 (S3-compatible, AWS SDK v3 + presigners) |
| Auth | HS256 JWT (shared secret with the website's NextAuth) · `@node-rs/argon2` password hashing |
| Payments | Stripe (PaymentIntents + Connect escrow: separate charges & transfers) |
| Geo | PostGIS KNN (raw SQL) · Mapbox (server-side geocoding) |
| Notifications | Channel providers (email/SMS/push) with a **dev-outbox** fallback; in-process `@nestjs/schedule` cron |
| Validation / docs | class-validator + global `ValidationPipe` · Joi env schema · `@nestjs/swagger` |
| Observability | helmet · pino-style logging interceptor · Sentry (optional, when `SENTRY_DSN` set) |
| Testing | Jest unit + Supertest e2e (**684 e2e across 26 suites**, 486 unit across 37) |
| Deploy | Render (auto-deploy from `main`) |

## Run locally

```bash
cd carsalepro-backend
cp .env.example .env                                   # fill creds for full functionality
docker compose up -d postgres redis                    # Postgres+PostGIS :5433, Redis :6380, MinIO :9000
npm install
npx prisma generate
npx prisma migrate deploy                              # apply migrations (incl. the PostGIS extension)
npm run prisma:seed                                    # PlatformSettings, admin user, legal templates
$env:PORT=3001; npm run start:dev                      # website dev on :3001 (matches frontend API_BASE_URL)
```

`prisma migrate deploy` is preferred over `migrate dev` locally — the PostGIS image pre-creates the extension, and `migrate dev`/`reset` hit interactive prompts. `.env` is gitignored; the committed template is [.env.example](./.env.example).

### Tests

```bash
npm test                                               # unit tests
npm run test:e2e -- --forceExit                        # 684 e2e / 26 suites (needs Postgres+PostGIS on :5433)
node scripts/verify-deployed.mjs https://carsalepro-backend.onrender.com   # deployed smoke
```

Always pass `--forceExit` (open Redis/handles otherwise keep Jest alive) and run **one** Jest process at a time (the suites share the local DB). e2e force Stripe into mock mode and disable the scheduler (`NODE_ENV=test`).

## API surface

Two route families share the app; the global `JwtAuthGuard` enforces a Bearer JWT **only** for paths starting with `/api/v1` (and re-checks the user in the DB on every request for ban/erasure/role), while `RolesGuard` gates `@Roles(Role.ADMIN)` routes. Legacy root routes stay on `X-Device-Id`. `@Public()` opts a route out of JWT (auth endpoints, `/api/v1/public/*`, `/api/v1/settings/public`, `/webhooks/stripe`).

**Mobile (root, `X-Device-Id`, frozen — extended additively by report-sync v2):** `GET /health` · `GET /vin/:vin` · `GET|POST /quota` · `POST|GET /reports` (+`PUT /:id` quota-free re-sync, `/:id/complete`, `DELETE /:id`; `POST /reports` is **unlimited for FREE and PRO alike** — the 3-report lifetime cap was retired 2026-08 and only comes back with `ENFORCE_FREE_REPORT_LIMIT=true`, in which case the frozen 402 body returns; accepts globally unique `CSP-<uuid>` codes as an idempotency key and a validated **structured `reportData` payload, contract v1**) · `POST /reports/:id/photos/upload` (multipart — **server-side sharp compression** to 1920 px / mozjpeg q80, slot-keyed replace + hash short-circuit) + `GET /reports/:id/photos`, `DELETE /reports/:id/photos/:photoId` (legacy presigned `POST /reports/:id/photos` still works) · `DELETE /me` (GDPR erasure incl. photo prefixes) · `GET /catalog` (**all 35 app languages**) · `GET /legal/:doc` · `GET /fonts/manifest` (presigned CJK PDF font packs with SHA-256).

**Website (`/api/v1`, JWT):** `auth` (login/register/verify/reset/oauth-upsert) · `users` (+ device-links) · `me/reports` archive · `public` (showroom/inspectors/report-check) · `reports` (PPV access + download) · `payments` (Stripe Checkout/PPV/gold) + `/webhooks/stripe` · `listings` (report-claimed **and** `POST /listings/manual` — a seller-declared listing with no inspection, its own photo gallery, badged `verified:false` in the showroom) · `orders` (quote/create/transition/contract) + `offers` + `geo` matching · `inspector` (profile, Stripe Connect onboarding — **any country, any legal form**: `POST /inspector/stripe-onboarding` optionally takes `country` (ISO 3166-1 alpha-2) and `businessType` (`individual` / `company` / `non_profit` / `government_entity`), defaulting to the stored choice and then to `STRIPE_CONNECT_DEFAULT_COUNTRY`, with the country refused once an account exists because Stripe cannot move one — earnings) · `kyc` (**multipart document upload** — `POST /kyc/applications/:id/documents/upload`; there is deliberately no presigned variant: the KYC bucket has no CORS and must not get any, so the bytes pass through the API, which checks the multipart part's content type against the file's magic bytes, keeps PDFs verbatim and compresses images) · `legal-templates` + per-order contracts · `notifications` (+ preferences) · `settings/public` · `admin/*` (users, orders, listings, settings, legal, finance + DAC7 CSV, dashboard, audit, KYC queue). **Swagger at `/docs` is the authoritative endpoint reference.**

## Cross-cutting conventions

The short list. Every one of these has a **rule with its reasoning** in [CLAUDE.md](./CLAUDE.md) — read that before changing any of them; this section is an index, not the contract.

- **Money is integer cents** end to end; tariffs and fees live in the `PlatformSetting` table, read through `SettingsService` and never hardcoded. The one documented deviation is `reportData`, which carries plain EUR numbers because it is archival inspection JSON and never ledger input.
- **The FREE tier is unlimited.** `DeviceQuota` still records `freeReportsUsed` / `freeReportsLimit` as historical counters and, more importantly, `isPro`; `GET /quota` exposes `freeLimitEnforced` so a client can tell a counter from a paywall. Enforcement returns only with `ENFORCE_FREE_REPORT_LIMIT=true`.
- **Mobile PRO is a single 7.00 EUR purchase, not a subscription** — `carsalepro_pro_lifetime`, granting a permanent `DeviceQuota.isPro` with no expiry. Website Stripe subscriptions are a different product and are unaffected.
- **The order lifecycle flows through one state machine** (`src/orders/order-state-machine.ts`); refunds, transfers and payouts fire only from legal transitions, and the per-order contract is auto-rendered on `ASSIGNED`.
- **Orders authorize first and capture at acceptance** (the ride-hailing model). Creating an order places a hold, `payment_intent.amount_capturable_updated` starts a search window (`orderSearchWindowMinutes`, 6 h) and dispatches, and the funds are taken only when an inspector accepts, so an order is never `ASSIGNED` with uncaptured money. Nobody accepts → a cron releases the hold and cancels, which answers `refundCents: 0` + `refundMode: "authorization_released"` and writes no `Refund` row. Money state lives on `Payment`, not in `OrderStatus`.
- **An order can only be closed with a complete report.** The gate checks which elements the `reportData` payload contains — every required exterior angle, all 17 paint panels with a reading and a photo, both calibration shots, four wheels with tread, DOT and size — rather than comparing a score to a threshold. Both required lists carry a legacy amnesty, so growing one never strands the apps already in the field.
- **The backend deploys before the app, never after.** Every array cap is a raise and both amnesties are additive: an older app against the new API is fine, a newer app against the old one is the failure mode.
- **Money that fails becomes a task, not an exception.** Refunds and payouts park a row with a retry schedule, a cron drains them, and the admin finance area lists both queues.
- **Stripe** runs in mock mode when no key is set or `NODE_ENV==='test'`; the webhook needs the raw body and **claims** its idempotency row before handling, so two concurrent deliveries of one event run the handler once.
- **A payout account may be in any country and any legal form, and the country is chosen once.** An unanswered legal form is omitted so Stripe Express asks rather than being guessed; a later request naming a different country is refused rather than silently creating a second account. There is deliberately no list of supported countries in this repo.
- **The reference catalog is served in 35 languages** — four authored by hand, 31 machine-translated sidecars merged at boot and at export. Because every label has a client-side fallback chain, a locale that merged nothing renders another language silently, so completeness is asserted rather than assumed.
- **PostGIS geography columns are Prisma `Unsupported`**, so all geo I/O is parameterized raw SQL.
- **Showroom images have permanent URLs only through a second, deliberately public R2 bucket.** Publicity in R2 is a property of the bucket, so a "public prefix" of the reports bucket cannot exist and would publish the paid PDFs; `R2_PUBLIC_URL` is retired and fails a production boot. Each `ListingPhoto` records which bucket holds it, and a report-backed listing's showroom photos are mirrored into the public bucket under a deterministic key (`Listing.publicPhotosMirroredAt`). With `R2_PUBLIC_*` unset, photos stay on 15-minute signed URLs. Backfill with `npx ts-node scripts/migrate-listing-photos-public.ts --dry-run`.
- **KYC objects never travel through the general R2 methods, and the browser never writes to that bucket.** Uploads are multipart through the API; the KYC bucket has no CORS and must never be given any.
- **Notification channels** default to a dev-outbox until provider env keys are set; the in-app channel is always live. The scheduler is off when `NODE_ENV==='test'` or `SCHEDULER_ENABLED='false'`.

## Project layout

```
src/
  common/   config/   prisma/   r2/   redis/        # infra: middleware, env, Prisma, R2, Redis
  auth/     users/    me-reports/  link-codes/      # identity, accounts, device linking
  vin/  quota/  reports/  me/  catalog/             # legacy mobile MVP surface
  public/   listings/   settings/                    # showroom, marketplace, tariffs
  geo/  orders/  payments/  inspector/              # inspection exchange + Stripe Connect escrow
  kyc/  legal/   fonts/                              # verification, static legal + contracts, CJK PDF font packs
  admin/    notifications/   scheduler/   worker/   # admin panel, notifications, cron, scale-out entrypoint
  health/   main.ts                                  # health probe + bootstrap (helmet, raw-body webhook, Swagger)
prisma/   schema.prisma · migrations · seed.ts
test/     *.e2e-spec.ts (26 suites) + fixtures + helpers
scripts/  verify-deployed.mjs · generate-api-md.js
```

## Deploy & operations

Render auto-deploys on push to `main` and runs `prisma migrate deploy` on start. Environment is validated by Joi at boot (a missing/weak `JWT_SECRET` or missing R2 creds fail the boot in production). The env var matrix lives in [.env.example](./.env.example); provider/credential setup and the prioritized go-live items are in [SECURITY.md](./SECURITY.md) and the development report under `../docs/reports/`.

**A boot-time self-check runs after Joi and refuses to start on a silently-wrong environment**: a BOM or stray quoting in a secret, a KYC bucket that equals the reports bucket, a CORS list with no https origin, `R2_PUBLIC_URL` still set. Values are never printed, only `MISSING` / `set (len 64)` / `has BOM`. Read the result at `GET /health/startup` — `/health` itself is untouched, because it is Render's `healthCheckPath`. Escapes, both logged loudly: `STARTUP_CHECK_STRICT=false`, `ALLOW_SHARED_KYC_BUCKET=true`. Why it exists, and why an unreachable third party is deliberately not fatal: [CLAUDE.md](./CLAUDE.md).

**Deploy order matters twice.** Set `R2_KYC_*` on Render *before* the self-check ships, or the boot fails. Subscribe the Stripe webhook to `payment_intent.amount_capturable_updated`, `.canceled` and `.payment_failed` *before* manual capture ships, or every order authorizes the customer's card and then sits in `CREATED` — under manual capture `payment_intent.succeeded` fires at capture, not at payment. The reconciler is insurance against a lost webhook, not a substitute for the subscription. Full sequence with verification commands: `../docs/reports/2026-08-09_production-config-runbook.md`.

**Onboarding an inspector outside the platform's own country needs cross-border payouts enabled on the Stripe platform account.** Nothing in this repo restricts the country — `STRIPE_CONNECT_DEFAULT_COUNTRY` is only the fallback for a request that names none — so the first proof that a country works is Stripe's answer. Get it from `node scripts/stripe-connect-smoke.mjs` (it creates an Express account in that country with a test key) rather than from an inspector's failed attempt.

> The older `docs/{API,ARCHITECTURE,DEPLOY,DEV_REPORT}.md` files describe the original **mobile MVP** only. For the website, treat Swagger (`/docs`), this README, and the `../docs/reports/` development report as current.
