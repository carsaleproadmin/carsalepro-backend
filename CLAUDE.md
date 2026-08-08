# CLAUDE.md — CarSalePro Backend

Agent-specific guidance. Project overview, stack, endpoints, and run/deploy steps are in @README.md — read it first and don't duplicate it here.

## What this repo is now

One NestJS service with **two API surfaces** (see @README.md):

- **Legacy mobile MVP** — root routes (`/vin`, `/quota`, `/reports`, `/me`, `/catalog`, `/legal`, `/health`), `X-Device-Id` auth, **frozen contract** (the shipped Flutter app depends on it byte-for-byte).
- **Website (Phase 2+)** — `/api/v1/*`, Bearer-JWT auth. The full marketplace / inspection-exchange / payments / KYC / LegalSync / admin / notifications platform was **built in this repo** (extending it in place was a deliberate decision — do NOT suggest moving it to a separate repo).

## Reference catalog (`src/catalog/catalog.data.ts` + `src/catalog/i18n/`)

Single source of truth for `GET /catalog`, exported to the mobile bundle via `npx ts-node scripts/export-catalog.ts` (never hand-edit `carsalepro-mobile/assets/catalog/catalog.v1.json`).

**The catalog now carries all 30 app languages, 292 localizable entries each.** The four human-translated locales (`de`/`en`/`ru`/`uk`) stay authored by hand in `catalog.data.ts`; the other 26 live as one sidecar per locale in `src/catalog/i18n/catalog.<tag>.json` and are merged in by `mergeCatalogI18n` — at boot from `CatalogModule.onModuleInit`, and at export from the export script. Splicing 26 more fields into each of 292 label objects would have taken `catalog.data.ts` from 3 273 lines to roughly 12 000, buried its ~100 explanatory comments in machine output, and made the provenance of any given string invisible. `LocalizedLabel` is therefore an index signature over tags, not a fixed set of fields.

A sidecar key matching no catalog entry is **reported, never fatal**: the catalog is allowed to drop an entry between a translation run and an export, and failing the export over that would block a legitimate change. Orphans surface as a warning from both the module and the script.

**Why the completeness spec matters more than it looks.** Every label has a fallback chain on the client (`zh-Hant → zh → en`, `ms → id → en`, `uk → ru → en`), so a locale whose sidecar merged nothing renders a *different language* with nothing erroring anywhere. That is exactly how 164 Ukrainian catalog labels shipped as Russian in July 2026. `catalog.i18n.spec.ts` asserts that all 26 sidecars exist and that each covers every localizable entry; the mobile repo asserts the same over the exported bundle. The fallback is insurance, not evidence.

Each `ChecklistItemDef` carries `defaultTier` (T1/T2/T3) and `partId?` — the mobile app turns the 98 checks into damage presets and stores them as synthetic **`C<number>` codes** (e.g. `C42`) in `ReportDamageDto.kstCode` (`@MaxLength(8)`). **The `C` prefix is reserved for that mapping — never mint real K/S/T codes starting with `C`.** The 8 **required exterior angles are ordered by the inspector's walk-around** (diag_front_left → left → front → diag_front_right → right → diag_rear_right → rear → diag_rear_left) and **all eight carry a `hint`** about wheel position — the four diagonals say to turn the near front wheel outward, the four straight views say wheels square. That *difference* is the instruction, so the e2e suite asserts the semantic split per locale rather than counting hinted angles; four of the eight shipped with no hint at all until 2026-08-05, and their absence was pinned by an assertion in both repos. The diagonal hint deliberately does not name a side: the longer RU/UK wording wrapped to a second line and pushed the mobile capture screen's instruction box past what a 320 dp screen can host at the 1.3 font clamp. Angle `order` is not persisted anywhere, angle **ids are** (mobile photo kinds `exterior-<id>` / `interior-<id>`, cloud slot keys). `thicknessPanels` holds the 13 guided Lackdicke stations, each resolving to a real `parts` id — **the `extra_` panelId prefix is reserved** for user-added ad-hoc measurements (same idea as the `C` prefix). Fields are additive — the frozen `GET /catalog` shape is unchanged. Regenerate the client + re-run the export after any catalog edit.

## Downloadable PDF fonts (`src/fonts/`)

`GET /fonts/manifest` returns presigned URLs plus a SHA-256 and byte count for each CJK font face, stored under `fonts/v1/` in the reports bucket. The mobile app fetches a pack the first time it generates a Chinese, Japanese or Korean report and caches the bytes.

Three things here are decisions, not defaults:

- **Why serve them at all.** `package:pdf` embeds its own fonts and cannot use the platform's, so a CJK report needs a real ~10 MB file even though both mobile platforms ship CJK system faces. Bundling all four would add ~33 MB to an app most of whose users never generate one.
- **Why mirror instead of linking gstatic.** `fonts.gstatic.com` is unreachable from mainland China — the single largest market for the locale it would be serving.
- **Why the digest is mandatory.** A truncated TrueType file does not throw when parsed. It yields a font whose glyph metrics are all zero, and the report renders with invisible text and nothing in the logs. `scripts/upload-fonts.ts` verifies every file against the committed digest — and that its sfnt version is TrueType `glyf`, not OTF or a collection, which `package:pdf` silently mis-parses — **before** uploading any of them, so a half-published pack cannot leave the app fetching three faces of four.

The manifest is a root route alongside `/catalog` and `/legal`; the frozen mobile contract is untouched.

## Hard rules

- **Never break the mobile contract.** Don't change root routes, their `X-Device-Id` behavior, or the R2 key layout `<tier>/<deviceId>/<reportId>.pdf` (GDPR erasure in `MeService.erase` + `R2Service.deletePrefix` depend on it). Extensions must be additive (like report-sync v2 was). Legacy mobile e2e (`mobile-link`, `vin`, `quota`, `reports`, `report-sync`, `report-photos`, `me`) must stay green.
- **FREE is unlimited (since 2026-08) — but the 402 shape is still frozen.** `POST /reports` no longer caps anything: enforcement sits behind `ENFORCE_FREE_REPORT_LIMIT`, which **defaults to false** (`quota.enforceFreeLimit`, `render.yaml` pins `"false"`). Never "disable" it via `FREE_REPORTS_LIMIT=0` — Joi rejects that (`.min(1)`), because `used >= limit` would then reject the *first* report. When the flag is true, `consumeQuota()` throws exactly this and nothing else (pinned by `test/reports.e2e-spec.ts`). Since 2026-08-09 `AllExceptionsFilter` **passes through** any key a domain exception put alongside `error`/`message`, so `freeReportsUsed`/`freeReportsLimit` now reach the wire beside `{statusCode, error, message, path, timestamp}` — purely additive, and inert for the shipped Flutter app, which derives `quotaBlocked` from the 402 **status alone** (`lib/core/net/net_failure.dart:80`) and never reads the body:
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
  - **`@Public()` is a FULL bypass — it returns before `req.user` is ever populated.** So `@CurrentUser('id')` on a public route is `undefined` even when the request carried a perfectly valid Bearer token. That is right for login and the webhook, and wrong for a route that is open to visitors but still wants to know who is asking. Pair it with **`@OptionalAuth()`** (`POST /api/v1/orders/quote` is the only user today): the guard then resolves the caller best-effort and **never throws** — a stale token means anonymous, not 401. `@OptionalAuth()` without `@Public()` does nothing, so it cannot weaken a protected route. Without it, making the quote public silently dropped both the waitlist entry and the self-assignment exclusion for every signed-in caller.
- **One named throttler must not cap the whole app.** `ThrottlerGuard` evaluates **every** configured throttler on **every** route, so the `lookup` bucket (20/min, meant for unauthenticated VIN/report lookups) capped the entire API — mobile photo upload died at exactly 20 and no full report could finish its backup in one pass. `NamedThrottlerGuard` (`src/common/guards/named-throttler.guard.ts`, registered in `app.module.ts`) skips any non-`default` throttler a route did not explicitly request via `@Throttle`. Adding a third named throttler needs no change; forgetting the guard does.
- **CORS is a list.** `WEB_ORIGIN` is the **canonical** origin (used to build absolute URLs; if it holds a comma-separated list the FIRST entry is canonical) and `CORS_ORIGINS` is purely additive. Resolution is pure and tested in `src/config/cors.ts` — `main.ts` is unreachable from Jest, which is why the rule deciding who may call the API had no test and shipped allowing exactly one origin.
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
npm test                                   # 97 unit / 10 suites
npm run test:e2e -- --forceExit            # 302 e2e / 22 suites must stay green; ONE jest at a time
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
| Catalog i18n merge (26 sidecars -> in-memory catalog) | `src/catalog/catalog.i18n.ts` |
| Downloadable CJK PDF fonts | `src/fonts/` + `scripts/upload-fonts.ts` |
| Outstanding security items | [SECURITY.md](./SECURITY.md) |

## Adding a website feature

It belongs here, under `/api/v1`. Add a module (controller `@Controller('api/v1/<feature>')` + service + DTOs with class-validator), wire it in `app.module.ts`, reuse `SettingsService` / `OrdersService.transition` / `StripeService` rather than duplicating money/state logic, add a `*.e2e-spec.ts` (≥ the coverage of sibling suites), and keep the mobile contract untouched.
