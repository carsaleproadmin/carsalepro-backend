# CarSalePro Backend

Minimal NestJS backend for the **CarSalePro mobile MVP** (Flutter). The mobile app is offline-first; the server only:

- decodes VINs via NHTSA vPIC and caches the result in Postgres,
- gates a **FREE-tier 3-reports-lifetime quota** per device,
- issues presigned R2 URLs so the device can upload its generated inspection PDF directly to Cloudflare R2,
- serves a per-device report history with presigned download URLs,
- supports **GDPR right-to-erasure** for any device.

No user accounts, no passwords. Identity is the `X-Device-Id` request header (UUID v4 generated client-side).

---

## Quick links

- **Live API:** https://carsalepro-backend.onrender.com
- **Swagger UI:** https://carsalepro-backend.onrender.com/docs
- **OpenAPI JSON:** https://carsalepro-backend.onrender.com/docs-json
- **Health:** https://carsalepro-backend.onrender.com/health
- **Source:** https://github.com/carsaleproadmin/carsalepro-backend
- **Render service:** https://dashboard.render.com/web/srv-d83o7j1kh4rs73cgjfng
- **Render Postgres:** https://dashboard.render.com/d/dpg-d83o5v3rjlhs73900aig-a
- **Cloudflare R2 bucket:** `carsalepro-reports` (jurisdiction default, EU)

---

## Tech stack

| Layer        | Choice |
|--------------|--------|
| Runtime      | Node.js 20 |
| Framework    | NestJS 11 |
| Language     | TypeScript 5.6 |
| Database     | PostgreSQL 16 (Render managed) |
| ORM          | Prisma 6 |
| Object store | Cloudflare R2 (S3-compatible, AWS SDK v3 + presigners) |
| Validation   | class-validator + Joi env schema |
| Docs         | @nestjs/swagger → Swagger UI at `/docs` |
| Observability| @sentry/node (optional; activates when `SENTRY_DSN` is set) |
| Testing      | Jest unit + Supertest E2E |
| Local infra  | Docker Compose Postgres |
| Deploy       | Render (Node runtime, auto-deploy on push to `main`) |

---

## Run locally

```bash
cd carsalepro-backend
cp .env.example .env                   # fill R2_* creds if you want full functionality
docker compose up -d postgres          # Postgres on :5433 to avoid clashing with other projects
npm install --legacy-peer-deps
npx prisma generate
npx prisma migrate dev                 # creates tables in local DB
npm run start:dev                      # http://localhost:3000
```

The `.env` file is gitignored. The example checked into the repo is at [.env.example](./.env.example).

### Tests

```bash
npm test          # 9 unit tests (no Docker / no R2 required)
npm run test:e2e  # 11 supertest E2E tests (needs Postgres on :5433)
```

### End-to-end smoke against a deployed URL

```bash
node scripts/verify-deployed.mjs https://carsalepro-backend.onrender.com
```

The script exercises every endpoint: health, Swagger, VIN decode (cache miss → cache hit), 3 quota-permitted uploads, the 4th returning **402 Payment Required**, a real PDF roundtrip through R2 with SHA-256 verification, soft delete, and GDPR erasure.

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Terminus probe: Postgres ping + R2 `HeadBucket` |
| `GET` | `/vin/:vin` | NHTSA vPIC decode, Postgres cache (`cached:true` on second call) |
| `GET` | `/quota` | Device quota summary (`X-Device-Id` required) |
| `POST` | `/quota/upgrade` | Mark device as PRO after IAP; trusts client receipt in MVP |
| `POST` | `/reports` | Reserve a report and obtain a presigned R2 upload URL. **402** if FREE-tier exhausted. |
| `POST` | `/reports/:id/complete` | Confirm the PDF was successfully uploaded to R2 |
| `GET` | `/reports` | List device reports (presigned download URLs on uploaded items) |
| `DELETE` | `/reports/:id` | Soft-delete report + remove R2 object |
| `DELETE` | `/me` | GDPR erasure: wipe all reports, quota, and R2 objects for the device |
| `GET` | `/docs` | Swagger UI |
| `GET` | `/docs-json` | OpenAPI 3.0 JSON |

All write endpoints require `X-Device-Id: <uuid-v4>`. Reads that don't take a device id are public.

See `docs/API.md` for full request/response schemas (generated from Swagger).

---

## Project layout

```
carsalepro-backend/
├── src/
│   ├── common/        # device-id middleware/decorator, exception filter, logging, Sentry bootstrap
│   ├── config/        # configuration() factory + Joi env validation
│   ├── prisma/        # PrismaModule + PrismaService
│   ├── r2/            # R2Service (S3 SDK + presign + deletePrefix for GDPR)
│   ├── health/        # /health (terminus)
│   ├── vin/           # /vin/:vin
│   ├── quota/         # /quota, /quota/upgrade
│   ├── reports/       # /reports CRUD + complete
│   ├── me/            # DELETE /me (GDPR erasure)
│   └── main.ts        # bootstrap: helmet, CORS, ValidationPipe, Swagger
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── test/              # supertest E2E specs + helpers
├── scripts/
│   └── verify-deployed.mjs
├── docs/              # ARCHITECTURE.md, DEPLOY.md, API.md, DEV_REPORT.md
├── Dockerfile         # multi-stage node:20-alpine
├── docker-compose.yml # local Postgres on :5433
└── render.yaml        # Blueprint reference (live service was created via MCP)
```

---

## Further reading

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module map, request flow, retention policy
- [docs/DEPLOY.md](docs/DEPLOY.md) — Render + R2 setup, env var matrix, rollback procedure
- [docs/API.md](docs/API.md) — every endpoint with request/response shapes
- [docs/DEV_REPORT.md](docs/DEV_REPORT.md) — implementation report (PDF version also available)
- [CLAUDE.md](CLAUDE.md) — agent guidance for working in this codebase
