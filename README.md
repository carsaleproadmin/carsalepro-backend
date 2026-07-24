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
- **Cloudflare R2 bucket:** `carsalepro-reports` (prefixes: `free/`, `pro/`, `report-photos/`, `listings/`, `kyc/`, `contracts/`)

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
| Testing | Jest unit + Supertest e2e (**222 e2e across 20 suites**) |
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
npm run test:e2e -- --forceExit                        # 222 e2e / 20 suites (needs Postgres+PostGIS on :5433)
node scripts/verify-deployed.mjs https://carsalepro-backend.onrender.com   # deployed smoke
```

Always pass `--forceExit` (open Redis/handles otherwise keep Jest alive) and run **one** Jest process at a time (the suites share the local DB). e2e force Stripe into mock mode and disable the scheduler (`NODE_ENV=test`).

## API surface

Two route families share the app; the global `JwtAuthGuard` enforces a Bearer JWT **only** for paths starting with `/api/v1` (and re-checks the user in the DB on every request for ban/erasure/role), while `RolesGuard` gates `@Roles(Role.ADMIN)` routes. Legacy root routes stay on `X-Device-Id`. `@Public()` opts a route out of JWT (auth endpoints, `/api/v1/public/*`, `/api/v1/settings/public`, `/webhooks/stripe`).

**Mobile (root, `X-Device-Id`, frozen — extended additively by report-sync v2):** `GET /health` · `GET /vin/:vin` · `GET|POST /quota` · `POST|GET /reports` (+`PUT /:id` quota-free re-sync, `/:id/complete`, `DELETE /:id`; `POST /reports` returns **402** when the FREE 3-report quota is exhausted; accepts globally unique `CSP-<uuid>` codes as an idempotency key and a validated **structured `reportData` payload, contract v1**) · `POST /reports/:id/photos/upload` (multipart — **server-side sharp compression** to 1920 px / mozjpeg q80, slot-keyed replace + hash short-circuit) + `GET /reports/:id/photos`, `DELETE /reports/:id/photos/:photoId` (legacy presigned `POST /reports/:id/photos` still works) · `DELETE /me` (GDPR erasure incl. photo prefixes) · `GET /catalog` · `GET /legal/:doc`.

**Website (`/api/v1`, JWT):** `auth` (login/register/verify/reset/oauth-upsert) · `users` (+ device-links) · `me/reports` archive · `public` (showroom/inspectors/report-check) · `reports` (PPV access + download) · `payments` (Stripe Checkout/PPV/gold) + `/webhooks/stripe` · `listings` · `orders` (quote/create/transition/contract) + `offers` + `geo` matching · `inspector` (profile, Stripe Connect onboarding, earnings) · `kyc` · `legal-templates` + per-order contracts · `notifications` (+ preferences) · `settings/public` · `admin/*` (users, orders, listings, settings, legal, finance + DAC7 CSV, dashboard, audit, KYC queue). **Swagger at `/docs` is the authoritative endpoint reference.**

## Cross-cutting conventions

- **Money is integer cents** end to end; tariffs/fees live in the `PlatformSetting` table (read via `SettingsService` — never hardcoded).
- **Order lifecycle** flows through a single state machine (`src/orders/order-state-machine.ts`); refunds/transfers/payouts fire only from legal transitions; the contract is auto-rendered on `ASSIGNED`.
- **Stripe** runs in **mock mode** when no key is set or `NODE_ENV==='test'`; the webhook needs the raw body and records its idempotency row only after successful handling.
- **PostGIS geography** columns are Prisma `Unsupported` → all geo I/O is parameterized raw SQL.
- **Notification channels** default to a dev-outbox (logs) until provider env keys are set; the in-app channel is always live. The scheduler is disabled when `NODE_ENV==='test'` or `SCHEDULER_ENABLED='false'`.

## Project layout

```
src/
  common/   config/   prisma/   r2/   redis/        # infra: middleware, env, Prisma, R2, Redis
  auth/     users/    me-reports/  link-codes/      # identity, accounts, device linking
  vin/  quota/  reports/  me/  catalog/             # legacy mobile MVP surface
  public/   listings/   settings/                   # showroom, marketplace, platform tariffs
  geo/  orders/  payments/  inspector/              # inspection exchange + Stripe Connect escrow
  kyc/  legal/                                       # verification + static legal + LegalSync contracts
  admin/    notifications/   scheduler/   worker/   # admin panel, notifications, cron, scale-out entrypoint
  health/   main.ts                                  # health probe + bootstrap (helmet, raw-body webhook, Swagger)
prisma/   schema.prisma · migrations · seed.ts
test/     *.e2e-spec.ts (20 suites) + fixtures + helpers
scripts/  verify-deployed.mjs · generate-api-md.js
```

## Deploy & operations

Render auto-deploys on push to `main` and runs `prisma migrate deploy` on start. Environment is validated by Joi at boot (a missing/weak `JWT_SECRET` or missing R2 creds fail the boot in production). The env var matrix lives in [.env.example](./.env.example); provider/credential setup and the prioritized go-live items are in [SECURITY.md](./SECURITY.md) and the development report under `../docs/reports/`.

> The older `docs/{API,ARCHITECTURE,DEPLOY,DEV_REPORT}.md` files describe the original **mobile MVP** only. For the website, treat Swagger (`/docs`), this README, and the `../docs/reports/` development report as current.
