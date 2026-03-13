# Queue System

A production-oriented queue processing system built with Node.js, TypeScript, BullMQ, Redis, and Postgres.

It provides:

- A producer API for enqueueing jobs (`POST /jobs`, `POST /jobs/bulk`)
- Multi-queue worker runtime for priority/workload classes
- Idempotency and lifecycle status tracking in Postgres
- Dead-letter capture and reprocess support
- Bearer-first client auth with HMAC compatibility
- Structured lifecycle logs for enqueue and worker events

## Architecture

- Producer (`Express`): validates/authenticates requests and writes jobs to Redis queues
- Redis (`BullMQ`): queue state, scheduling, retries, worker coordination
- Worker (`BullMQ Worker`): consumes queues, executes processor, updates status
- Postgres: idempotency records, status current/events, dead-letter records, API clients/nonces

See full request lifecycle in `docs/REQUEST_FLOW.md`.

## Queue Routing

Queue name is derived from `priority + workload` with optional shard suffix:

- `high-io`, `high-cpu`
- `default-io`, `default-cpu`
- `low-io`, `low-cpu`

Optional `shardCount` adds `-shard-{index}` suffix based on `partitionKey` hashing.

## Key Features

- Minimal single-job payload support (metadata defaults are auto-filled)
- Bulk ingest up to 10,000 items per request (`POST /jobs/bulk`)
- Redis-efficient bulk enqueue via `addBulk()` in internal batches
- Request-level controls:
  - `delayMs`
  - `retryCount`
  - `executionMode` (`parallel` or `sequential`)
- Per-user/entity routing via `uniqueId` (mapped to partition key fallback)
- Enqueue source tagging in metadata: `individual` or `bulk`

## Logging and Status Lifecycle

The system captures both logs and durable status transitions:

- Producer logs:
  - request received
  - job enqueued / bulk jobs enqueued
- Worker logs:
  - job started
  - job failed
  - job completed
  - job stalled (warning)
- Postgres status timeline:
  - `queued`, `active`, `completed`, `failed`, `duplicate`, `dead-lettered`

`metadata.enqueueSource` is persisted so you can distinguish single vs bulk-origin jobs.

## Quick Start

1. Install dependencies:

```powershell
npm.cmd install
```

2. Configure `.env` (Redis + Postgres).

3. Apply DB migrations in order:

- `src/infra/migrations/001_reliability_core.sql`
- `src/infra/migrations/002_client_hmac_auth.sql`
- `src/infra/migrations/003_bearer_token_hash.sql`

4. Start producer:

```powershell
npm.cmd run dev:producer
```

5. Start worker:

```powershell
npm.cmd run dev:worker
```

Worker startup now subscribes to all base queues (`high/default/low` x `io/cpu`).

## Scripts

- `npm.cmd run dev:producer`
- `npm.cmd run dev:worker`
- `npm.cmd run build`
- `npm.cmd run typecheck`
- `npm.cmd run validate:send-job`
- `npm.cmd run validate:duplicate`
- `npm.cmd run validate:db`
- `npm.cmd run load:test`

## API Overview

Core endpoints:

- `GET /health`
- `POST /jobs`
- `POST /jobs/bulk`
- `GET /jobs`
- `GET /jobs/:jobId`
- `GET /jobs/:jobId/events`
- `POST /dead-letter/:id/reprocess`

Admin endpoints:

- `GET /admin/keys`
- `POST /admin/keys`
- `POST /admin/keys/:id/rotate`
- `POST /admin/keys/:id/revoke`

Detailed payloads and examples:

- `docs/API_USAGE_AND_PAYLOAD_REFERENCE.md`
- `docs/RENDER_DEPLOYMENT_SINGLE_OR_DUAL.md`

## Example Requests

Single enqueue (`POST /jobs`):

```json
{
  "uniqueId": "user-123",
  "executionMode": "parallel",
  "job": {
    "name": "webhook.dispatch",
    "payload": {
      "endpoint": "https://example.com/webhook",
      "eventType": "user.created",
      "method": "POST",
      "data": {
        "userId": "u-123",
        "email": "user@example.com"
      }
    }
  },
  "delayMs": 0,
  "retryCount": 3
}
```

Bulk enqueue (`POST /jobs/bulk`):

```json
{
  "defaults": {
    "executionMode": "parallel",
    "retryCount": 3,
    "delayMs": 0
  },
  "items": [
    {
      "uniqueId": "user-123",
      "job": {
        "name": "webhook.dispatch",
        "payload": {
          "endpoint": "https://example.com/webhook",
          "eventType": "data.imported",
          "method": "POST",
          "data": {
            "recordId": "r-1"
          }
        }
      }
    },
    {
      "uniqueId": "user-123",
      "executionMode": "sequential",
      "job": {
        "name": "webhook.dispatch",
        "payload": {
          "endpoint": "https://example.com/webhook",
          "eventType": "data.imported",
          "method": "POST",
          "data": {
            "recordId": "r-2"
          }
        }
      }
    }
  ]
}
```

PowerShell example (`POST /jobs`):

```powershell
$token = '<accessToken>'
$body = @{
  uniqueId = 'user-123'
  executionMode = 'parallel'
  job = @{
    name = 'webhook.dispatch'
    payload = @{
      endpoint = 'https://example.com/webhook'
      eventType = 'user.created'
      method = 'POST'
      data = @{
        userId = 'u-123'
      }
    }
  }
  delayMs = 0
  retryCount = 3
}

Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3000/jobs' `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType 'application/json' `
  -Body ($body | ConvertTo-Json -Depth 20)
```

curl example (`POST /jobs/bulk`):

```bash
curl -X POST "http://localhost:3000/jobs/bulk" \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "defaults": {
      "executionMode": "parallel",
      "retryCount": 3,
      "delayMs": 0
    },
    "items": [
      {
        "uniqueId": "user-123",
        "job": {
          "name": "webhook.dispatch",
          "payload": {
            "endpoint": "https://example.com/webhook",
            "eventType": "data.imported",
            "method": "POST",
            "data": { "recordId": "r-1" }
          }
        }
      }
    ]
  }'
```

## Auth

Client API supports:

- Bearer token auth (recommended)
- HMAC headers (compatibility mode)

Admin APIs require:

- `X-Admin-Token`

See `docs/SETUP_FROM_SCRATCH.md` for full setup and auth details.

## Operations

- Runbook: `docs/OPERATIONS_RUNBOOK.md`
- Reliability decisions: `PREBUILD_DECISIONS.md`
- Validation notes: `docs/SECTION7_VALIDATION.md`

## Throughput & Capacity

The core operation is single job enqueue (`POST /jobs`) — the primary API for all integrations. Bulk enqueue is available for batch imports but single enqueue is the heart of the system.

### Single Enqueue (`POST /jobs`) — Core Path

| Step | Type | Calls | Avg Latency |
|---|---|---|---|
| Zod validation | CPU | 0 I/O | ~0.1ms |
| Rate limit check | In-memory | 0 I/O | ~0ms |
| Queue depth check | Redis | 0 (cached 2s) | ~0ms |
| `queue.add()` | Redis | 1 | ~2ms |
| Status upsert (CTE) | DB | 1 | ~5ms |
| **Total** | | **1 Redis + 1 DB** | **~7ms** |

**Single enqueue throughput:**

| DB_POOL_MAX | Max enqueue/sec |
|---|---|
| 5 | ~1,000/sec |
| 15 | ~3,000/sec |
| 20 | ~4,000/sec |

### Worker Processing (per job)

| Step | DB Calls |
|---|---|
| Idempotency claim (atomic CTE) | 1 |
| Status → active | 1 |
| Processor (your code) | — |
| Mark idempotency completed | 1 |
| Status → completed | 1 |
| **Total** | **4** |

**Worker throughput:**

| DB_POOL_MAX | Max jobs/sec |
|---|---|
| 5 | ~250/sec |
| 15 | ~750/sec |
| 20 | ~1,000/sec |

### Bulk Enqueue (`POST /jobs/bulk`) — Batch Import

For high-volume imports, bulk enqueue batches 100 jobs per Redis+DB call:

| 1,000 jobs via bulk | Redis Calls | DB Calls |
|---|---|---|
| Before optimizations | 1,000 | 2,000 |
| After optimizations | 10 | 10 |

### Bottleneck Order

1. `DB_POOL_MAX` — primary limiter for all DB-bound operations
2. Database connection pool (Supabase free tier: ~20-60 concurrent connections)
3. Redis command budget (Upstash free tier: 500K commands/month)
4. Network latency to DB/Redis (~2-10ms per call)
5. Single Node.js process (~10K-15K concurrent async operations)

### Redis Command Budget

BullMQ workers poll Redis continuously (~12 cmd/sec per queue, even idle).

| Config | Idle cmd/sec | Daily |
|---|---|---|
| 6 queues + signals (30s) | ~70 | ~6M |
| 1 queue + signals (5 min) | ~13 | ~1.1M |
| 1 queue + signals off | ~12 | ~1M |

Set `WORKER_QUEUES=default-io` and `SCALE_SIGNALS_ENABLED=false` for metered Redis providers.
