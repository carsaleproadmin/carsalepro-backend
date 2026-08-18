# CarSalePro Backend

The shared NestJS backend for the **CarSalePro** ecosystem. One service, one Postgres + Cloudflare R2, two API surfaces:

- **Mobile MVP (legacy, frozen)** — root routes (`/vin`, `/quota`, `/reports`, `/me`, …) authenticated by the `X-Device-Id` header. Used by the shipped Flutter app; the contract must not change.
- **Website (Phase 2+)** — everything under `/api/v1/*`, authenticated by a Bearer JWT. Powers the Next.js site in `../carsalepro-frontend`: a verified-reports marketplace, an Uber-model inspection exchange with Stripe Connect escrow, pay-per-view reports, KYC, per-order LegalSync contracts, notifications, and an admin panel.

> Full product spec: `../docs/07_Website_MVP_Требования_и_План.md`. End-to-end development report (architecture, per-epic detail, security posture, go-live checklist): `../docs/reports/2026-06-14_carsalepro-website-mvp.md` (+ PDF).

## Quick links

- **Live API:** https://carsalepro-backend.onrender.com · **Swagger:** `/docs` · **OpenAPI JSON:** `/docs-json` · **Health:** `/health`
- **Source:** https://github.com/carsaleproadmin/carsalepro-backend
- **Render service:** `srv-d83o7j1kh4rs73cgjfng` (auto-deploys on push to `main`; start command runs `prisma migrate deploy`)
- **Render Postgres:** `dpg-d83o5v3rjlhs73900aig-a` (PostgreSQL 16 + PostGIS)
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
| Testing | Jest unit + Supertest e2e (**519 e2e across 26 suites**, 730 unit) |
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
npm run test:e2e -- --forceExit                        # 519 e2e / 26 suites (needs Postgres+PostGIS on :5433)
node scripts/verify-deployed.mjs https://carsalepro-backend.onrender.com   # deployed smoke
```

Always pass `--forceExit` (open Redis/handles otherwise keep Jest alive) and run **one** Jest process at a time (the suites share the local DB). e2e force Stripe into mock mode and disable the scheduler (`NODE_ENV=test`).

## API surface

Two route families share the app; the global `JwtAuthGuard` enforces a Bearer JWT **only** for paths starting with `/api/v1` (and re-checks the user in the DB on every request for ban/erasure/role), while `RolesGuard` gates `@Roles(Role.ADMIN)` routes. Legacy root routes stay on `X-Device-Id`. `@Public()` opts a route out of JWT (auth endpoints, `/api/v1/public/*`, `/api/v1/settings/public`, `/webhooks/stripe`).

**Mobile (root, `X-Device-Id`, frozen — extended additively by report-sync v2):** `GET /health` · `GET /vin/:vin` · `GET|POST /quota` · `POST|GET /reports` (+`PUT /:id` quota-free re-sync, `/:id/complete`, `DELETE /:id`; `POST /reports` is **unlimited for FREE and PRO alike** — the 3-report lifetime cap was retired 2026-08 and only comes back with `ENFORCE_FREE_REPORT_LIMIT=true`, in which case the frozen 402 body returns; accepts globally unique `CSP-<uuid>` codes as an idempotency key and a validated **structured `reportData` payload, contract v1**) · `POST /reports/:id/photos/upload` (multipart — **server-side sharp compression** to 1920 px / mozjpeg q80, slot-keyed replace + hash short-circuit) + `GET /reports/:id/photos`, `DELETE /reports/:id/photos/:photoId` (legacy presigned `POST /reports/:id/photos` still works) · `DELETE /me` (GDPR erasure incl. photo prefixes) · `GET /catalog` (**all 35 app languages**) · `GET /legal/:doc` · `GET /fonts/manifest` (presigned CJK PDF font packs with SHA-256).

**Website (`/api/v1`, JWT):** `auth` (login/register/verify/reset/oauth-upsert) · `users` (+ device-links) · `me/reports` archive · `public` (showroom/inspectors/report-check) · `reports` (PPV access + download) · `payments` (Stripe Checkout/PPV/gold) + `/webhooks/stripe` · `listings` (report-claimed **and** `POST /listings/manual` — a seller-declared listing with no inspection, its own photo gallery, badged `verified:false` in the showroom) · `vin-history` (paid provenance check, backed by **several sources merged into one report** — `VIN_HISTORY_PROVIDER=aggregate`, and the report never names them: free `GET /:vin/preview` — which names the car from the free NHTSA decode and costs nothing, because the live provider bills for every endpoint and has no free probe, so its counts are `null` and `probed` is `false` before a purchase; `POST /:vin/unlock`, refusing an uncovered VIN **before** any payment row exists; `me/vin-checks` + `GET /me/vin-checks/:id/download?format=pdf|json`, a rendered de/en/ru PDF written at fulfilment and lazily on first download; `POST|DELETE /me/vin-checks/:id/share` mints and revokes an unguessable public link served by `@Public() GET /public/vin-report/:token`) · `orders` (quote/create/transition/contract) + `offers` + `geo` matching · `inspector` (profile, Stripe Connect onboarding — **any country, any legal form**: `POST /inspector/stripe-onboarding` optionally takes `country` (ISO 3166-1 alpha-2) and `businessType` (`individual` / `company` / `non_profit` / `government_entity`), defaulting to the stored choice and then to `STRIPE_CONNECT_DEFAULT_COUNTRY`, with the country refused once an account exists because Stripe cannot move one — earnings) · `kyc` (**multipart document upload** — `POST /kyc/applications/:id/documents/upload`; there is deliberately no presigned variant: the KYC bucket has no CORS and must not get any, so the bytes pass through the API, which checks the multipart part's content type against the file's magic bytes, keeps PDFs verbatim and compresses images) · `legal-templates` + per-order contracts · `notifications` (+ preferences) · `settings/public` · `admin/*` (users, orders, listings, settings, legal, finance + DAC7 CSV, dashboard, audit, KYC queue). **Swagger at `/docs` is the authoritative endpoint reference.**

## Cross-cutting conventions

- **FREE tier is unlimited.** `DeviceQuota` still records `freeReportsUsed` / `freeReportsLimit` (historical counters) and, more importantly, `isPro`; `GET /quota` exposes `freeLimitEnforced` so a client can tell a counter from a paywall.
- **Money is integer cents** end to end; tariffs/fees live in the `PlatformSetting` table (read via `SettingsService` — never hardcoded).
- **Order lifecycle** flows through a single state machine (`src/orders/order-state-machine.ts`); refunds/transfers/payouts fire only from legal transitions; the contract is auto-rendered on `ASSIGNED`.
- **Order payments are authorized on creation and captured when an inspector accepts.** If nobody accepts inside `orderSearchWindowMinutes` (six hours), a cron releases the hold and cancels — nothing was ever charged, so no `Refund` row is written. Money state lives on `Payment` (`pending → authorized → succeeded`, or `cancelled`), not in `OrderStatus`: `PAID` has always meant "the customer's money is committed", and whether it is held or taken is a payment fact. `GET /orders/:id` carries optional `payment` / `search` / `reportRequirement` blocks so the website can render the difference without depending on deploy order.
- **A report may only close an order if it contains every required element** — each exterior angle, each paint panel with a reading and a photo, both calibration shots, all four wheels with tread/DOT/size. The refusal lists what is missing.
- **Orders authorize first and capture at acceptance** (the ride-hailing model). Creating an order places a **hold** (`capture_method: 'manual'`); `payment_intent.amount_capturable_updated` starts a search window (`orderSearchWindowMinutes`, 6 h) and dispatches; the funds are taken only when an inspector accepts, so an order is never `ASSIGNED` with uncaptured money. Nobody accepts → a cron releases the hold and cancels. Cancelling before acceptance therefore answers `refundCents: 0` + `refundMode: "authorization_released"` and writes **no** `Refund` row — the money never left the customer. **Stripe must be subscribed to `payment_intent.amount_capturable_updated`, `.canceled` and `.payment_failed`.**
- **An order can only be closed with a complete report.** The gate runs on both `POST /orders/:id/report` and `POST /reports` with an `orderId`, and since 2026-08-13 it checks which elements the report's `reportData` payload contains rather than comparing a score to a threshold. `minReportQualityScore` (PlatformSetting) kept its name but is now only a lever: `0` turns the gate off from the admin panel, anything above it turns the gate on. A report with no structured payload is `report_quality_unknown` (update the app); one with gaps is `report_incomplete`, carrying the structured `missing` list. An older 8-angle report is judged against the walk-around it was filed under, so it stays closable. `GET /orders/:id` exposes the required counts in `reportRequirement`.
- **Stripe** runs in **mock mode** when no key is set or `NODE_ENV==='test'`; the webhook needs the raw body and **claims** its idempotency row before handling, marking it processed afterwards (a failure deletes the claim, so Stripe's retry still works, and two concurrent deliveries of one event run the handler once).
- **An inspector's payout account may be in any country and any legal form, and the country is chosen once.** `POST /inspector/stripe-onboarding` takes an optional `country` + `businessType`; both were hardcoded (`DE`, `individual`) until 2026-08-19, which meant no company and nobody outside Germany could be paid — Express onboarding does not offer the company form to an account that already declares itself a natural person. An unanswered legal form is **omitted** so Stripe asks during onboarding rather than being guessed. Stripe fixes an account's country at creation and has no API to move it, so a later request naming a different country is refused with `connect_country_locked` (409) instead of silently creating a second account somewhere the inspector cannot be paid; a country Stripe will not open comes back as `connect_country_unsupported`, naming it. Which countries are supported is Stripe's answer at the moment of the call — there is deliberately no list of them in this repo.
- **Money that fails becomes a task, not an exception.** Refunds and payouts both park a row with a retry schedule, a cron drains them, and the admin finance area lists both queues (`/api/v1/admin/finance/payouts|refunds`). Cancelling an order that was never charged is a no-op, not an error; refunding a purchase revokes what it bought.
- **PostGIS geography** columns are Prisma `Unsupported` → all geo I/O is parameterized raw SQL.
- **The reference catalog is served in 35 languages.** Four are authored by hand in `catalog.data.ts`; the other 31 are machine-translated sidecars under `src/catalog/i18n/`, merged at boot and at export. Because every label has a client-side fallback chain, a locale that merged nothing would render another language silently — so completeness is asserted, not assumed.
- **Showroom images have permanent URLs when — and only when — a second, deliberately PUBLIC R2 bucket is configured.** Publicity in R2 is a property of the bucket, so a "public prefix" of the reports bucket cannot exist and would publish the paid PDFs; `R2_PUBLIC_URL` is retired and fails a production boot. Each `ListingPhoto` records which bucket holds it, and a report-backed listing's showroom photos are *mirrored* into the public bucket under a deterministic key (`Listing.publicPhotosMirroredAt`). With `R2_PUBLIC_*` unset nothing changes: photos stay on 15-minute signed URLs. Backfill with `npx ts-node scripts/migrate-listing-photos-public.ts --dry-run` (it deletes nothing from the reports bucket).
- **Notification channels** default to a dev-outbox (logs) until provider env keys are set; the in-app channel is always live. The scheduler is disabled when `NODE_ENV==='test'` or `SCHEDULER_ENABLED='false'`.

## Project layout

```
src/
  common/   config/   prisma/   r2/   redis/        # infra: middleware, env, Prisma, R2, Redis
  auth/     users/    me-reports/  link-codes/      # identity, accounts, device linking
  vin/  quota/  reports/  me/  catalog/             # legacy mobile MVP surface
  public/   listings/   settings/  vin-history/     # showroom, marketplace, tariffs, paid VIN checks
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

**A boot-time self-check runs after Joi and refuses to start on a silently-wrong environment**: a BOM or stray quoting in a secret, a KYC bucket that equals the reports bucket, a CORS list with no https origin, `R2_PUBLIC_URL` still set. It exists because four of the nine blocking defects in the 2026-08-08 audit were environment values and not one of them failed a build, a test or `/health` — a BOM in the Mapbox token made every geocode 401, so the order form told people their valid address did not exist. Values are never printed, only `MISSING` / `set (len 64)` / `has BOM`. A third party being briefly unreachable is deliberately *not* fatal. Read the result at `GET /health/startup`; `/health` itself is unchanged, because it is Render's `healthCheckPath` and a Mapbox outage must not pull the service out of rotation. Escapes, both logged loudly: `STARTUP_CHECK_STRICT=false`, `ALLOW_SHARED_KYC_BUCKET=true`.

**Deploy order matters twice.** Set `R2_KYC_*` on Render *before* the self-check ships, or the boot fails. Subscribe the Stripe webhook to `payment_intent.amount_capturable_updated`, `.canceled` and `.payment_failed` *before* manual capture ships, or every order authorizes the customer's card and then sits in `CREATED` — under manual capture `payment_intent.succeeded` fires at capture, not at payment. The reconciler is insurance against a lost webhook, not a substitute for the subscription. Full sequence with verification commands: `../docs/reports/2026-08-09_production-config-runbook.md`.

**Onboarding an inspector outside the platform's own country needs cross-border payouts enabled on the Stripe platform account.** Nothing in this repo restricts the country — `STRIPE_CONNECT_DEFAULT_COUNTRY` is only the fallback for a request that names none — so the first proof that a country works is Stripe's answer. Get it from `node scripts/stripe-connect-smoke.mjs` (it creates an Express account in that country with a test key) rather than from an inspector's failed attempt.

> The older `docs/{API,ARCHITECTURE,DEPLOY,DEV_REPORT}.md` files describe the original **mobile MVP** only. For the website, treat Swagger (`/docs`), this README, and the `../docs/reports/` development report as current.
