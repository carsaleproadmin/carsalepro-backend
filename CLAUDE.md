# CLAUDE.md — CarSalePro Backend

Agent-specific guidance. Human-facing docs live in `README.md` and `docs/`.

## What this project is

NestJS 11 backend that supports the CarSalePro Flutter mobile MVP. The full product concept is at `../docs/CONCEPT.md`. The MVP scope this backend covers is described at `../docs/06_Mobile_MVP_План_2_месяца.md` (Week 7 cloud sync + PRO IAP).

Only **6 endpoints** are in scope for MVP: health, VIN decode, quota (get + upgrade), reports (POST/GET/complete/DELETE), me (GDPR erasure). Anything bigger (auth, orders, marketplace, KYC, Stripe) is **explicitly Phase 2+** and should not be added here without an updated spec.

## Identity model

There are no user accounts. Every authenticated endpoint accepts `X-Device-Id: <uuid-v4>` and stores all rows keyed by it. Do not log full device IDs at `info` level; use the `mask()` helpers (`f0a1…3c4d`).

## Hard rules

- **Never log secrets or full receipts.** IAP receipt bytes flow through `/quota/upgrade` but are intentionally not persisted in MVP.
- **Never put R2 credentials in source.** Always read from `ConfigService`.
- **402 is part of the contract.** The mobile app interprets `POST /reports` returning 402 as "show paywall." Don't change the status code or message shape without coordinating with the mobile team.
- **Prisma over raw SQL.** The only exception so far is the transactional quota gate in `ReportsService.consumeQuota`, which uses `prisma.$transaction` for atomicity.
- **R2 keys follow `<tier>/<deviceId>/<reportId>.pdf`.** GDPR erasure relies on this prefix layout — don't change it without updating `MeService.erase` and `R2Service.deletePrefix`.
- **Tests must run without R2 creds.** The `Reports (e2e)` suite has both an R2-on path and an R2-off path; keep both green.

## Where things live

| Concept | File |
|---|---|
| Bootstrap, Swagger, helmet | `src/main.ts` |
| Wiring & global filters | `src/app.module.ts` |
| Env validation (Joi) | `src/config/env.validation.ts` |
| Device-id parsing | `src/common/middleware/device-id.middleware.ts` + `src/common/decorators/device-id.decorator.ts` |
| Quota gate | `src/reports/reports.service.ts` → `consumeQuota` |
| GDPR erasure | `src/me/me.service.ts` + `src/r2/r2.service.ts:deletePrefix` |
| Presigned URLs | `src/r2/r2.service.ts:createPresignedUploadUrl` / `createPresignedDownloadUrl` |
| VIN cache | `src/vin/vin.service.ts` |

## Common dev loop

```bash
docker compose up -d postgres           # Postgres on :5433
npm run start:dev                       # auto-reload Nest
npm test && npm run test:e2e            # 20 tests, all must stay green
node scripts/verify-deployed.mjs http://localhost:3000   # full smoke
```

Run `npx prisma migrate dev --name <slug>` for any schema change. Migrations under `prisma/migrations/` are part of the contract — never edit a committed migration.

## Verification before pushing

1. `npm test` — unit
2. `npm run test:e2e` — supertest
3. `node scripts/verify-deployed.mjs http://localhost:3000` — full local smoke
4. `npx tsc --noEmit -p tsconfig.build.json` — strict typecheck

Render auto-deploys on push to `main`. If a deploy fails, check `mcp__render__list_logs` with `resource=srv-d83o7j1kh4rs73cgjfng` before doing anything else.

## When asked to add a Phase 2 feature

Pause and confirm scope with the user — Phase 2 work generally belongs in a separate repo (the web frontend / marketplace) and adding modules here drags the MVP backend out of its minimal contract. The `docs/CONCEPT.md` "Phase 2+" section is the authoritative scope boundary.
