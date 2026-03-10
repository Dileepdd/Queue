# Request Flow

This document explains what actually happens when a request hits the producer API.

## High-Level Components

- Producer API (`Express`): validates/authenticates request and enqueues jobs.
- Redis (`BullMQ`): queue storage and scheduling (waiting, delayed, active, retries).
- Worker (`BullMQ Worker`): pulls jobs from Redis and executes processor.
- Postgres: source of truth for idempotency, status timeline, dead-letter records, API clients.

## Data Placement

- Redis is used for queue state, delayed scheduling, and worker coordination.
- Postgres is used for durable business/state tracking:
  - `idempotency_records`
  - `job_status_current`
  - `job_status_events`
  - `dead_letter_records`
  - `api_clients`, `api_request_nonces`
- In-memory producer map is used for tenant API rate limiting window (per process), not Redis.

## Flow: `POST /jobs`

1. Request enters producer.
2. JSON body parsed (raw bytes also preserved for HMAC verification).
3. Auth middleware runs:
- Bearer path: validates token hash/plaintext fallback against `api_clients`.
- HMAC path: validates headers, timestamp skew, nonce replay, and signature.
4. Request schema validation runs (`job`, optional `uniqueId`, `executionMode`, `delayMs`, `retryCount`, `shardCount`).
5. Job envelope normalization fills defaults if missing:
- `idempotencyKey`, `correlationId`, `requestedAt`, `tenantId`, `schemaVersion`, `priority`, `workload`.
- `partitionKey` uses `job.metadata.partitionKey` or `uniqueId` or tenant fallback.
6. Admission checks:
- Payload size and delayed horizon checks.
- Tenant rate limiter check (in-memory bucket, unless bulk path bypass).
7. Queue routing:
- Base queue from `priority + workload`.
- Optional shard suffix from `partitionKey + shardCount`.
8. Queue depth check against configured max.
9. Enqueue to Redis via BullMQ:
- Job name: `webhook.dispatch`.
- Job data: normalized envelope.
- Job options: `jobId`, optional `delay`, optional per-request `attempts` (`retryCount + 1`).
10. Postgres status write:
- Upsert `job_status_current` as `queued`.
- Append `job_status_events` row.
- Metadata includes `enqueueSource=individual`.
11. Producer returns `202 Accepted` with queue and job id.

## Flow: `POST /jobs/bulk`

1. Auth and body validation run.
2. `items` array (up to 10,000) is normalized and routed with the same rules as `POST /jobs`.
3. Bulk route sets `skipAdmissionRateLimit=true` for per-item API limiter checks.
4. Jobs are submitted to Redis using BullMQ `addBulk()` in internal batches (size 100).
5. Response returns `202` with `totalEnqueued` and `jobs` array (`jobId`, `queue`).
6. Each queued job status/timeline metadata is tagged with `enqueueSource=bulk`.

## Worker Execution Flow

1. Worker subscribes to a queue (default runtime starts `default-io`).
2. Worker receives job from Redis.
3. Validates job envelope.
4. Idempotency claim in Postgres:
- New claim -> process.
- Duplicate completed -> mark status `duplicate`, return saved result.
- Busy lock -> move same job to delayed and throw `DelayedError` (no attempt burn).
5. Status set to `active` in Postgres.
6. Processor executes with timeout guard.
7. On success:
- Mark idempotency `completed` with result.
- Status set to `completed`.
8. On failure:
- Mark idempotency `failed`.
- Status set to `failed`.
- BullMQ retry/backoff applies until attempts exhausted.
9. If final attempt fails:
- Insert row in `dead_letter_records`.
- Status set to `dead-lettered`.

## Reprocess Flow: `POST /dead-letter/:id/reprocess`

1. Fetch DLQ row from Postgres.
2. Re-enqueue original payload/metadata to Redis queue.
3. Mark DLQ row as reprocessed.
4. Return `202` with new job id.

## Status Read Flows

- `GET /jobs`: reads tenant-scoped rows from `job_status_current`.
- `GET /jobs/:jobId`: reads one tenant-scoped current status row.
- `GET /jobs/:jobId/events`: reads tenant-scoped timeline from `job_status_events` and computes summary.

## Retry Behavior

- Default retries/backoff are queue-level defaults from env.
- Per request, `retryCount` can override attempts for that job (`attempts = retryCount + 1`).
- API rate-limit retries (`429`) are client-side responsibility.

## Ordering and Parallelism

- Same `uniqueId` routes to same partition key lane (when shard routing is used).
- `executionMode=parallel` uses normal worker concurrency behavior.
- `executionMode=sequential` uses a per-partition distributed lock in the worker so only one job in that lane runs at a time.
- Effective throughput still depends on queue assignment, worker count, and worker concurrency.

## Operational Notes

- Queue overload returns `503 QUEUE_OVERLOADED`.
- Tenant admission limit returns `429 TENANT_RATE_LIMITED`.
- DB saturation/transient errors are mapped to retryable `503` responses.
- Retention sweeps periodically clean old terminal idempotency/status/dead-letter data.
- Producer emits structured enqueue logs for both paths with `enqueueSource`.
