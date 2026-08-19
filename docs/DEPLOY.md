# Deploy

> **Historical** — the FREE 3-report cap was retired 2026-08; see README + CLAUDE.md.

This document covers the exact steps used to bring CarSalePro Backend MVP into production on Render + Cloudflare R2. Subsequent deploys are automatic on every push to `main`.

## Architecture

```
GitHub (carsaleproadmin/carsalepro-backend, branch=main)
        │   (Render auto-deploy on push)
        ▼
┌──────────────────────────────────────────────┐
│ Render Web Service: carsalepro-backend       │
│ - Node 20 runtime, Frankfurt region          │
│ - URL: carsalepro-backend.onrender.com       │
└──────────────────────────────────────────────┘
        │                                  │
        │ Internal pg connection           │ S3 over HTTPS
        ▼                                  ▼
┌────────────────────────┐   ┌─────────────────────────────┐
│ Render Postgres 16     │   │ Cloudflare R2               │
│ carsalepro_db (free)   │   │ bucket: carsalepro-reports  │
│ Frankfurt              │   │ jurisdiction: default (EU)  │
└────────────────────────┘   └─────────────────────────────┘
```

## Resources (provisioned 2026-05-15)

| Resource | Identifier |
|---|---|
| Render workspace | `tea-d81nglnlk1mc73b00u3g` ("Egor's workspace") |
| Render web service | `srv-d83o7j1kh4rs73cgjfng` |
| Render Postgres | `dpg-d83o5v3rjlhs73900aig-a` (database `carsalepro_db`, user `carsalepro_db_user`) |
| Cloudflare account | `f8dbfc5a3fcf74bf65e0e7af90b5a349` |
| R2 bucket | `carsalepro-reports` (EEUR location, default jurisdiction) |
| Public URL | https://carsalepro-backend.onrender.com |
| Swagger | https://carsalepro-backend.onrender.com/docs |

## Environment variables

All variables match `.env.example`. The deployed values are stored on Render and never committed to the repo.

| Key | Source | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `PORT` | `10000` | Render's default for free Node services |
| `LOG_LEVEL` | `info` | |
| `DATABASE_URL` | Render Postgres Internal URL | `postgresql://carsalepro_db_user:…@dpg-…/carsalepro_db` |
| `R2_ACCOUNT_ID` | Cloudflare R2 page | `f8dbfc5a3fcf74bf65e0e7af90b5a349` |
| `R2_ACCESS_KEY_ID` | R2 API token (S3 panel) | `b4cc9fd9d4fcf04492022a10c826480d` |
| `R2_SECRET_ACCESS_KEY` | R2 API token (S3 panel) | secret — store via Render dashboard only |
| `R2_BUCKET` | `carsalepro-reports` | |
| `R2_PUBLIC_URL` | empty | leave blank — backend always presigns downloads |
| `FREE_REPORTS_LIMIT` | `3` | matches the spec |
| `PRESIGNED_UPLOAD_TTL` | `900` | 15 min |
| `PRESIGNED_DOWNLOAD_TTL` | `3600` | 1 h |
| `NHTSA_BASE_URL` | `https://vpic.nhtsa.dot.gov/api` | |
| `SENTRY_DSN` | empty for MVP | add later to enable error reporting |
| `SENTRY_ENVIRONMENT` | `production` | |

## First-time provisioning (already done)

These steps were executed once via MCP. They are documented here in case the resources are ever recreated.

### 1. Cloudflare R2

```text
- Enable R2 in dashboard if it's not yet active (one-click "Get Started")
- Create bucket `carsalepro-reports` (default jurisdiction)
- R2 → Manage R2 API Tokens → Create API token
    Name: carsalepro-backend
    Permissions: Object Read & Write
    Scope: Apply to specific buckets only → carsalepro-reports
- Copy Access Key ID and Secret Access Key (one-time visibility)
```

### 2. Render Postgres

Via Render MCP:

```text
mcp__render__create_postgres
  name: carsalepro-db
  plan: free
  region: frankfurt
  version: 16
```

After ~1 min the status flips to `available`. The connection string isn't exposed via API — copy the **Internal Database URL** from the dashboard's Connections panel.

### 3. Render Web Service

Via Render MCP:

```text
mcp__render__create_web_service
  name: carsalepro-backend
  runtime: node
  repo: https://github.com/carsaleproadmin/carsalepro-backend
  branch: main
  region: frankfurt
  plan: free
  autoDeploy: yes
  buildCommand: "npm ci --legacy-peer-deps && npx prisma generate && npm run build"
  startCommand: "npx prisma migrate deploy && node dist/main.js"
  envVars: [ ... all from the table above except DATABASE_URL ]
```

Then add `DATABASE_URL` separately (it requires the dashboard-fetched secret):

```text
mcp__render__update_environment_variables
  serviceId: srv-d83o7j1kh4rs73cgjfng
  envVars: [ { key: DATABASE_URL, value: <internal pg url> } ]
  replace: false
```

The env-var update triggers an automatic redeploy.

## Day-to-day deploys

Just push to `main`. Render auto-builds and rolls in.

```bash
git push origin main
```

Watch the build with:

```text
mcp__render__list_deploys serviceId=srv-d83o7j1kh4rs73cgjfng limit=5
mcp__render__get_deploy   serviceId=srv-d83o7j1kh4rs73cgjfng deployId=<id>
mcp__render__list_logs    resource=srv-d83o7j1kh4rs73cgjfng
```

The first request after the free service idles (~15 min of no traffic) takes ~30 s to cold start.

## Rollback

```text
mcp__render__list_deploys serviceId=srv-d83o7j1kh4rs73cgjfng limit=10
# pick a successful deploy id
```

Then use the dashboard's "Rollback" action — there is no MCP rollback verb yet. Alternatively, `git revert <bad-commit> && git push` will trigger a fresh forward deploy of the previous state.

## Health & alerts

- Liveness: `GET /health` — terminus checks Postgres + R2. Render uses this for routing.
- Sentry (when configured): forwards 5xx errors only.
- Render free plan has no email alerts; monitor manually via the dashboard.

## Free-tier caveats

- Render Postgres free instance expires after 30 days (date in `mcp__render__get_postgres`). Upgrade before the date to keep data — `mcp__render__update_postgres_plan` or via dashboard.
- Render free web services sleep after 15 min idle. First request after sleep takes ~30 s while the container warms up. Health check waits for boot before routing traffic.
