# Queue System Setup From Scratch

This guide shows how to run the project end-to-end with Redis + Postgres, then verify with scripts and Postman.

## 1. Prerequisites

- Node.js 20+ (LTS recommended)
- npm (comes with Node.js)
- A Redis instance (Upstash or local Docker)
- A Postgres instance (Supabase, Neon, RDS, or local Docker)
- Optional: `psql` CLI for running SQL migrations

## 2. Install Project Dependencies

From `c:\Queue`:

```powershell
npm.cmd install
```

## 3. Create Redis

### Option A: Upstash Redis (recommended for cloud)

1. Create a Redis database in Upstash.
2. Copy connection values into `.env`:

- `REDIS_URL`
- `REDIS_HOST`
- `REDIS_PORT`
- `REDIS_USERNAME`
- `REDIS_PASSWORD`
- `REDIS_TLS=true`

### Option B: Local Redis with Docker

```powershell
docker run --name queue-redis -p 6379:6379 -d redis:7
```

Use this local config:

```dotenv
REDIS_URL=redis://localhost:6379
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_USERNAME=
REDIS_PASSWORD=
REDIS_TLS=false
```

## 4. Create Postgres

### Option A: Supabase/Cloud Postgres

1. Create a Postgres database.
2. Copy URI into `DATABASE_URL`.
3. Set SSL flags:

```dotenv
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=false
```

### Option B: Local Postgres with Docker

```powershell
docker run --name queue-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=queue -p 5432:5432 -d postgres:16
```

Use this local config:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/queue
DB_SSL=false
DB_SSL_REJECT_UNAUTHORIZED=false
```

## 5. Configure Environment

1. Copy `.env.example` to `.env`.
2. Fill Redis + Postgres values.
3. Keep defaults initially for queue settings.

Important tuning values currently used:

- `DB_POOL_MAX=5`
- `QUEUE_CONCURRENCY=10`
- `DB_IDEMPOTENCY_CLAIM_WARN_MS=600`

## 6. Run Database Migration

Run `src/infra/migrations/001_reliability_core.sql` on your Postgres DB.

### With `psql`

```powershell
psql "$env:DATABASE_URL" -f src/infra/migrations/001_reliability_core.sql
```

### With cloud SQL editor

Open `src/infra/migrations/001_reliability_core.sql`, copy/paste, execute once.

## 7. Start Services

Open two terminals in `c:\Queue`.

Terminal 1 (producer API):

```powershell
npm.cmd run dev:producer
```

Terminal 2 (worker):

```powershell
npm.cmd run dev:worker
```

Expected behavior:

- Producer listens on `PORT` (default `3000`)
- Worker logs `worker started`

## 8. Quick Validation

### Health check

```powershell
Invoke-RestMethod -Method Get -Uri http://localhost:3000/health
```

Expected:

```json
{"ok":true,"service":"producer"}
```

### Send one sample job

```powershell
npm.cmd run validate:send-job
```

### Duplicate/idempotency check

```powershell
npm.cmd run validate:duplicate
```

### Inspect DB state

```powershell
npm.cmd run validate:db
```

### Optional load test

```powershell
npm.cmd run load:test -- --requests 500 --concurrency 20
```

## 9. API Endpoints

- `GET /health`
- `POST /jobs`
- `POST /dead-letter/:id/reprocess`

## 10. API Call Order (What To Call First)

Use this sequence every time you start fresh.

1. Call `GET /health` first.
2. If response is `200` with `{"ok":true,"service":"producer"}`, call `POST /jobs`.
3. If `POST /jobs` returns `202`, the job was accepted by the queue.
4. Check worker logs for `job started` and `job completed`.
5. Run `npm.cmd run validate:db` to confirm status and idempotency records are moving to terminal states.
6. Use `POST /dead-letter/:id/reprocess` only when there is a real DLQ row to retry.

Expected status codes:

- `GET /health` -> `200 OK`
- `POST /jobs` -> `202 Accepted`
- `POST /jobs` -> `429` or `503` can happen under backpressure; retry after the `Retry-After` header.
- `POST /dead-letter/:id/reprocess` -> `202 Accepted` when requeue is accepted.

Request payload for `POST /jobs`:

```json
{
  "job": {
    "name": "email.send",
    "metadata": {
      "idempotencyKey": "tenant1:email.send:user123:send:v1-001",
      "correlationId": "corr-001-abcdef",
      "requestedAt": "2026-03-09T00:00:00.000Z",
      "tenantId": "tenant1",
      "schemaVersion": 1,
      "priority": "default",
      "workload": "io-bound"
    },
    "payload": {
      "to": "user@example.com",
      "subject": "Welcome",
      "body": "Hello from queue system"
    }
  },
  "delayMs": 0,
  "shardCount": 1
}
```

## 11. Postman

Import: `postman/queue-system.postman_collection.json`

Set collection variable:

- `baseUrl` = `http://localhost:3000`

## 12. Common Issues

- `EADDRINUSE: 3000`: another producer already running.
- `SELF_SIGNED_CERT` or SSL errors: verify `DB_SSL` and `DB_SSL_REJECT_UNAUTHORIZED` for your provider.
- Too many DB clients: reduce `DB_POOL_MAX`.
- `MaxClientsInSessionMode: max clients reached`: your Postgres pooler session limit is saturated. Set `DB_POOL_MAX=2` or `3`, stop duplicate producer/worker terminals, restart both services, and retry.
- Many `429`/`503` under load: expected with backpressure; reduce load or raise limits carefully.
- Stale `processing` idempotency rows after crash: wait for lock expiry window (`LOCK_SECONDS`, currently 5 minutes) before declaring stuck.

## 13. Security Notes

- Rotate any leaked credentials immediately.
- Never commit real secrets to git.
- Keep `.env` local and out of source control.
