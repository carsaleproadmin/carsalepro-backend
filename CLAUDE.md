# CLAUDE.md — CarSalePro Backend

Agent-specific guidance. Project overview, stack, endpoints, and run/deploy steps are in @README.md — read it first and don't duplicate it here.

## What this repo is now

One NestJS service with **two API surfaces** (see @README.md):

- **Legacy mobile MVP** — root routes (`/vin`, `/quota`, `/reports`, `/me`, `/catalog`, `/legal`, `/health`), `X-Device-Id` auth, **frozen contract** (the shipped Flutter app depends on it byte-for-byte).
- **Website (Phase 2+)** — `/api/v1/*`, Bearer-JWT auth. The full marketplace / inspection-exchange / payments / KYC / LegalSync / admin / notifications platform was **built in this repo** (extending it in place was a deliberate decision — do NOT suggest moving it to a separate repo).

## Hard rules

- **Never break the mobile contract.** Don't change root routes, their `X-Device-Id` behavior, the `POST /reports` → **402 `free_limit_reached`** paywall shape, or the R2 key layout `<tier>/<deviceId>/<reportId>.pdf` (GDPR erasure in `MeService.erase` + `R2Service.deletePrefix` depend on it). Legacy mobile e2e (`mobile-link`, `vin`, `quota`, `reports`, `me`) must stay green.
- **Money is integer cents.** No floats. All fees/tariffs come from `PlatformSetting` via `SettingsService.getCents`/`getNumber` — never hardcode amounts.
- **Order lifecycle goes through the state machine** (`src/orders/order-state-machine.ts` `canTransition` + `OrdersService.transition`). Refunds/transfers/payouts fire only from legal transitions. The per-order contract auto-renders on the `ASSIGNED` transition (wrapped so it can't break assignment).
- **Auth surface:** website routes live under `@Controller('api/v1/...')`; the global `JwtAuthGuard` enforces JWT only for `/api/v1` and re-loads the user from the DB each request (ban/erasure/role/KYC are authoritative from the DB). Use `@Public()` to opt out, `@Roles(Role.ADMIN)` for admin routes (every `api/v1/admin/*` controller must carry it), `@CurrentUser('id')` for the caller.
- **Prisma over raw SQL — except PostGIS.** Geography columns are `Unsupported`; do geo I/O with parameterized `$queryRaw`/`$executeRaw` (`Prisma.sql`/`Prisma.join`) — never string-interpolate user input.
- **Stripe** runs MOCK when no key OR `NODE_ENV==='test'`. The webhook (`/webhooks/stripe`, `@Public`, raw body) verifies the signature and records its idempotency row only after successful handling.
- **Notifications are non-fatal** — `NotificationService.notify` must never throw into a domain flow; in `NODE_ENV==='test'` it dispatches inline so e2e can assert rows. The scheduler (`src/scheduler`) is gated off when `NODE_ENV==='test'` or `SCHEDULER_ENABLED='false'`.
- **Secrets** come from `ConfigService`, never source or logs. KYC documents are served only via short-lived **signed** URLs (`R2Service.createPrivateSignedUrl`) — never a public URL. Mask device/user ids in logs (`mask()` helpers).
- **No schema edits without a migration.** Migrations under `prisma/migrations/` are part of the contract — never edit a committed one.

## Migrations

Use `npx prisma migrate deploy` (non-interactive) to apply, and `prisma migrate diff --from-url … --to-schema-datamodel … --script` to author new migrations. `migrate dev`/`reset` hit interactive prompts / an AI-consent guard in this environment and the PostGIS image pre-creates the extension — avoid them. After changing `schema.prisma`, regenerate the client, add a migration, and re-seed with `npm run prisma:seed`.

## Verify before pushing

```bash
npx tsc --noEmit -p tsconfig.build.json
npm run test:e2e -- --forceExit            # 185 e2e / 18 suites must stay green; ONE jest at a time
```

Always pass `--forceExit` (Redis/handles keep Jest alive otherwise). Render auto-deploys on push to `main` (runs `prisma migrate deploy` on start; Joi env validation can fail the boot — e.g. a weak prod `JWT_SECRET`). If a deploy fails, check `mcp__render__list_logs` for `srv-d83o7j1kh4rs73cgjfng` first. **Commit messages must not mention Claude/AI or include a Co-Authored-By trailer.**

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
