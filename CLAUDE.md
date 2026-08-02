# CLAUDE.md — CarSalePro Backend

Agent-specific guidance. Project overview, stack, endpoints, and run/deploy steps are in @README.md — read it first and don't duplicate it here.

## What this repo is now

One NestJS service with **two API surfaces** (see @README.md):

- **Legacy mobile MVP** — root routes (`/vin`, `/quota`, `/reports`, `/me`, `/catalog`, `/legal`, `/health`), `X-Device-Id` auth, **frozen contract** (the shipped Flutter app depends on it byte-for-byte).
- **Website (Phase 2+)** — `/api/v1/*`, Bearer-JWT auth. The full marketplace / inspection-exchange / payments / KYC / LegalSync / admin / notifications platform was **built in this repo** (extending it in place was a deliberate decision — do NOT suggest moving it to a separate repo).

## Reference catalog (`src/catalog/catalog.data.ts`)

Single source of truth for `GET /catalog`, exported to the mobile bundle via `npx ts-node scripts/export-catalog.ts` (never hand-edit `carsalepro-mobile/assets/catalog/catalog.v1.json`). Each `ChecklistItemDef` carries `defaultTier` (T1/T2/T3) and `partId?` — the mobile app turns the 98 checks into damage presets and stores them as synthetic **`C<number>` codes** (e.g. `C42`) in `ReportDamageDto.kstCode` (`@MaxLength(8)`). **The `C` prefix is reserved for that mapping — never mint real K/S/T codes starting with `C`.** `LocalizedLabel` has an optional `uk` (Ukrainian, added checklist-first 2026-07-22); other sections fall back uk→ru on the client. The 8 **required exterior angles are ordered by the inspector's walk-around** (diag_front_left → left → front → diag_front_right → right → diag_rear_right → rear → diag_rear_left) and 4 of them carry a `hint` about the front-wheel position; angle `order` is not persisted anywhere, angle **ids are** (mobile photo kinds `exterior-<id>` / `interior-<id>`, cloud slot keys). `thicknessPanels` holds the 13 guided Lackdicke stations, each resolving to a real `parts` id — **the `extra_` panelId prefix is reserved** for user-added ad-hoc measurements (same idea as the `C` prefix). Fields are additive — the frozen `GET /catalog` shape is unchanged. Regenerate the client + re-run the export after any catalog edit.

## Hard rules

- **Never break the mobile contract.** Don't change root routes, their `X-Device-Id` behavior, or the R2 key layout `<tier>/<deviceId>/<reportId>.pdf` (GDPR erasure in `MeService.erase` + `R2Service.deletePrefix` depend on it). Extensions must be additive (like report-sync v2 was). Legacy mobile e2e (`mobile-link`, `vin`, `quota`, `reports`, `report-sync`, `report-photos`, `me`) must stay green.
- **FREE is unlimited (since 2026-08) — but the 402 shape is still frozen.** `POST /reports` no longer caps anything: enforcement sits behind `ENFORCE_FREE_REPORT_LIMIT`, which **defaults to false** (`quota.enforceFreeLimit`, `render.yaml` pins `"false"`). Never "disable" it via `FREE_REPORTS_LIMIT=0` — Joi rejects that (`.min(1)`), because `used >= limit` would then reject the *first* report. When the flag is true, `consumeQuota()` throws exactly this and nothing else (pinned by `test/reports.e2e-spec.ts`; the shipped Flutter app still handles it, and `AllExceptionsFilter` projects it to `{statusCode, error, message, path, timestamp}` on the wire):
  ```json
  { "error": "PaymentRequired",
    "message": "FREE-tier limit of 3 reports reached. Upgrade to PRO to continue.",
    "freeReportsUsed": 3, "freeReportsLimit": 3 }
  ```
  Keep the machinery: `DeviceQuota` is still the storage for **`isPro`** (drives the PDF watermark and the ad gate), `freeReportsUsed` still increments (with `rollbackQuota()`), `GET /quota` still returns all five legacy fields verbatim — the mobile freezed DTO declares them non-nullable `int`s — plus the additive `freeLimitEnforced`, and `Report.tier` still drives the R2 key layout. Don't churn any of it.
- **Report sync v2 invariants** (`src/reports/`): `CSP-<uuid v4>` codes are the create-idempotency key — re-posting the same code from the same device returns the existing report and **never consumes quota twice** (partial unique index `report_code_uuid_unique` backs the cross-device 409). `reportData` with `reportSchemaVersion: 1` is validated **before** quota is consumed (a 400 never burns a credit) via `report-data.validator.ts` — lenient, unknown keys allowed. `PUT /reports/:id` is quota-free. Photo uploads (`POST /reports/:id/photos/upload`, multipart) are compressed server-side by `photo-processing.service.ts` (sharp, 1920 px, mozjpeg q80, 2-transform semaphore) and slot-keyed `(reportId, kind, position)` with a content-hash short-circuit; `photosManifest` is mirrored from `ReportPhoto` rows so website consumers stay untouched. Photo keys live under `report-photos/<deviceId>/<reportId>/`.
- **`reportData` v1 array caps are sized for the worst report, not the average one** (`dto/report-data-v1.dto.ts`): `photos` 300, `damages`/`checklist` 200, `thickness.panels` 60, `recipients` 20, `wheels` 4, plus a 1 MiB payload cap in the validator. Hitting a cap is a 400 `invalid_report_data`, which **blocks the mobile Finish flow** — raise a cap before it can bite, never tighten one.
- **Money in `reportData` is plain EUR numbers** — a documented, contained deviation from the integer-cents rule (archival inspection JSON, never ledger input).
- **Money is integer cents.** No floats. All fees/tariffs come from `PlatformSetting` via `SettingsService.getCents`/`getNumber` — never hardcode amounts.
- **Order lifecycle goes through the state machine** (`src/orders/order-state-machine.ts` `canTransition` + `OrdersService.transition`). Refunds/transfers/payouts fire only from legal transitions. The per-order contract auto-renders on the `ASSIGNED` transition (wrapped so it can't break assignment).
- **Auth surface:** website routes live under `@Controller('api/v1/...')`; the global `JwtAuthGuard` enforces JWT only for `/api/v1` and re-loads the user from the DB each request (ban/erasure/role/KYC are authoritative from the DB). Use `@Public()` to opt out, `@Roles(Role.ADMIN)` for admin routes (every `api/v1/admin/*` controller must carry it), `@CurrentUser('id')` for the caller.
- **Prisma over raw SQL — except PostGIS.** Geography columns are `Unsupported`; do geo I/O with parameterized `$queryRaw`/`$executeRaw` (`Prisma.sql`/`Prisma.join`) — never string-interpolate user input.
- **Stripe** runs MOCK when no key OR `NODE_ENV==='test'`. The webhook (`/webhooks/stripe`, `@Public`, raw body) verifies the signature and records its idempotency row only after successful handling.
- **Notifications are non-fatal** — `NotificationService.notify` must never throw into a domain flow; in `NODE_ENV==='test'` it dispatches inline so e2e can assert rows. The scheduler (`src/scheduler`) is gated off when `NODE_ENV==='test'` or `SCHEDULER_ENABLED='false'`.
- **Secrets** come from `ConfigService`, never source or logs. KYC documents are served only via short-lived **signed** URLs (`R2Service.createPrivateSignedUrl`) — never a public URL. Mask device/user ids in logs (`mask()` helpers).
- **No schema edits without a migration.** Migrations under `prisma/migrations/` are part of the contract — never edit a committed one. **`prisma migrate diff` proposes `DROP INDEX` for the three PostGIS GIST indexes on every single run** — grep the generated SQL for `DROP INDEX` and strip those lines before committing, then re-verify with `SELECT indexname FROM pg_indexes WHERE indexname LIKE '%location_idx'` (three rows).
- **Money that reaches a client comes from `SettingsService.getPriceCatalog()`** (integer cents). The website must never hardcode a price or bake one into a translation file.
- **A notification whose payload carries a live credential must not create an inapp row** — `GET /api/v1/notifications` returns the stored payload, so an in-app copy of a password-reset link turns a borrowed session into a permanent takeover. See `SECRET_BEARING_TYPES`.
- **KYC objects go through the `kyc*` methods on `R2Service`, never the general ones.** `createPresignedDownloadUrl` short-circuits to `R2_PUBLIC_URL`; `kycSignedDownloadUrl` never does.

## Migrations

Use `npx prisma migrate deploy` (non-interactive) to apply, and `prisma migrate diff --from-url … --to-schema-datamodel … --script` to author new migrations. `migrate dev`/`reset` hit interactive prompts / an AI-consent guard in this environment and the PostGIS image pre-creates the extension — avoid them. After changing `schema.prisma`, regenerate the client, add a migration, and re-seed with `npm run prisma:seed`.

## Verify before pushing

```bash
npx tsc --noEmit -p tsconfig.build.json
npm run lint                               # ESLint 9 flat config (eslint.config.mjs)
npm test                                   # 87 unit / 9 suites
npm run test:e2e -- --forceExit            # 301 e2e / 22 suites must stay green; ONE jest at a time
```

Always pass `--forceExit` (Redis/handles keep Jest alive otherwise). e2e reads
`.env.test` (see `.env.test.example`), which points at a **dedicated**
`carsalepro_test` database and deliberately blanks `STRIPE_SECRET_KEY`,
`MAPBOX_TOKEN`, `RESEND_API_KEY` and `SENTRY_DSN`. Without that file the suite
silently runs against the dev database using real credentials. Suites that assert
prices must pin the tariff (`test/helpers/tariff.ts`) — the admin settings suite
mutates `orderBaseFeeEur` as part of an acceptance test. Render auto-deploys on push to `main` (runs `prisma migrate deploy` on start; Joi env validation can fail the boot — e.g. a weak prod `JWT_SECRET`). If a deploy fails, check `mcp__render__list_logs` for `srv-d83o7j1kh4rs73cgjfng` first. **Commit messages must not mention Claude/AI or include a Co-Authored-By trailer.**

## Where agent-relevant things live

| Concern | Location |
|---|---|
| Bootstrap (helmet, CORS allowlist, raw-body webhook, Swagger) | `src/main.ts` |
| Wiring + global guards (Throttler → Jwt → Roles) | `src/app.module.ts`, `src/auth/` |
| Env schema + config | `src/config/env.validation.ts`, `configuration.ts` |
| Order state machine + exchange | `src/orders/` (`order-state-machine.ts`, `orders.service.ts`) |
| Stripe escrow / webhooks | `src/payments/` (`stripe.service.ts`, `payments.service.ts`, `webhook.controller.ts`) |
| Geo (PostGIS KNN) | `src/geo/` |
| Tariffs (PlatformSetting) | `src/settings/` |
| LegalSync contracts | `src/legal/legal-contract.service.ts`, `legal-contracts.content.ts` |
| Notifications + cron | `src/notifications/`, `src/scheduler/`, `src/worker/main.ts` |
| Outstanding security items | [SECURITY.md](./SECURITY.md) |

## Adding a website feature

It belongs here, under `/api/v1`. Add a module (controller `@Controller('api/v1/<feature>')` + service + DTOs with class-validator), wire it in `app.module.ts`, reuse `SettingsService` / `OrdersService.transition` / `StripeService` rather than duplicating money/state logic, add a `*.e2e-spec.ts` (≥ the coverage of sibling suites), and keep the mobile contract untouched.
