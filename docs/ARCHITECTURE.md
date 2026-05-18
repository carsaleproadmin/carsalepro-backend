# Architecture

## Module map

```
AppModule
├── ConfigModule (global, Joi-validated)
├── PrismaModule (global)        — PrismaService extends PrismaClient
├── R2Module (global)            — R2Service wraps @aws-sdk/client-s3 + presigners
├── HealthModule                 — /health via @nestjs/terminus
├── VinModule                    — GET /vin/:vin, NHTSA fetch + cache
├── QuotaModule                  — GET /quota, POST /quota/upgrade
├── ReportsModule                — POST/GET/DELETE /reports + /reports/:id/complete
└── MeModule                     — DELETE /me (GDPR erasure)
```

Global cross-cutting concerns wired in `AppModule`:

- `DeviceIdMiddleware` parses `X-Device-Id` on every request.
- `AllExceptionsFilter` standardizes the error envelope (`statusCode`, `error`, `message`, `path`, `timestamp`).
- `LoggingInterceptor` logs `METHOD URL -> STATUS (Nms)`.

## Data model

Three Prisma tables. No foreign keys: `Report` and `DeviceQuota` are independent rows keyed by `deviceId` (string).

```mermaid
erDiagram
  VinCache {
    string vin PK "17 chars"
    json payload
    string source "default: nhtsa-vpic"
    datetime fetchedAt
  }
  DeviceQuota {
    string deviceId PK
    int freeReportsUsed "default 0"
    int freeReportsLimit "default 3"
    boolean isPro "default false"
    datetime proActivatedAt
    string proPlatform
    datetime updatedAt
    datetime createdAt
  }
  Report {
    string id PK "cuid"
    string deviceId "indexed"
    string code "CSP-###"
    string vin "17 chars, nullable"
    string s3Key "free|pro/<deviceId>/<id>.pdf"
    int sizeBytes
    string hash "SHA-256 hex"
    string tier "free|pro"
    boolean uploaded "false until /complete"
    datetime createdAt
    datetime deletedAt "soft delete"
  }
```

## Request flow: report upload (happy path)

```mermaid
sequenceDiagram
  participant App as Flutter App
  participant API as NestJS API
  participant DB as Postgres
  participant R2 as Cloudflare R2

  App->>API: POST /reports {code, vin, ...} with X-Device-Id
  API->>DB: BEGIN
  API->>DB: SELECT/UPSERT DeviceQuota
  API->>DB: UPDATE freeReportsUsed += 1 (or detect isPro)
  API->>DB: COMMIT
  API->>DB: INSERT Report (uploaded=false)
  API->>R2: getSignedUrl(PutObject, expires=15min)
  API-->>App: {reportId, s3Key, presignedUploadUrl, expiresAt}
  App->>R2: PUT presigned URL (multipart PDF body)
  App->>API: POST /reports/:id/complete
  API->>R2: HeadObject(s3Key)
  alt object exists
    API->>DB: UPDATE Report SET uploaded=true
    API-->>App: {id, uploaded: true}
  else not found
    API-->>App: 404
  end
```

## Quota gate (402)

```mermaid
sequenceDiagram
  participant App as Flutter App
  participant API as NestJS API
  participant DB as Postgres

  App->>API: POST /reports (X-Device-Id=D)
  API->>DB: SELECT DeviceQuota WHERE deviceId=D
  alt isPro=true
    Note over API,DB: tier="pro", no counter change
  else freeReportsUsed < freeReportsLimit
    API->>DB: UPDATE freeReportsUsed += 1
    Note over API,DB: tier="free"
  else freeReportsUsed >= freeReportsLimit
    API-->>App: 402 Payment Required\n"FREE-tier limit reached"
  end
```

The increment + the gate live inside the same `$transaction`, so concurrent uploads from one device cannot exceed the limit by 1.

## GDPR erasure

`DELETE /me` deletes:

1. Every R2 object under `free/<deviceId>/*` and `pro/<deviceId>/*` (via `ListObjectsV2` + `DeleteObjects` in batches).
2. Every `Report` row for the device (hard delete, not soft).
3. The `DeviceQuota` row.

The operation is idempotent — running it again returns zero counts.

## Retention

- Reports are stored **forever** by design (see `docs/01_Требования_к_системе.md`). No lifecycle rule on the R2 bucket.
- The FREE-tier "limit" is a **lifetime count of generated reports**, not a retention window.
- VinCache rows are never evicted. NHTSA data changes infrequently and a stale entry is acceptable; if a refresh is ever needed, drop the row and the next request will refetch.

## Configuration

All config flows through `@nestjs/config` with a Joi schema (`src/config/env.validation.ts`). The app fails fast on boot if a required production secret is missing. Local development tolerates empty R2 credentials — the `/reports` endpoints return `503 Cloud storage not configured` but the rest of the API remains usable for tests.

## Observability

- **Logs** — Nest's default Logger; `LoggingInterceptor` adds request/response lines. Sensitive values (full device IDs, IAP receipts, R2 secrets) are never logged.
- **Sentry** — `@sentry/node` initializes if `SENTRY_DSN` is set. The default error filter forwards 5xx automatically.
- **Health** — `/health` checks DB ping + R2 `HeadBucket`. Render's liveness probe hits this endpoint.

## What's deliberately not here

- No user / account / session tables.
- No CSRF, no rate limiter (mobile clients only, low volume in MVP).
- No internal admin endpoints (those are Phase 2 site work).
- No background workers or scheduled jobs (uploads are synchronous, history is pull-based).
- No multi-region replication.
