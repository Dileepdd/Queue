# API Usage and Payload Reference

This document explains how to use the producer service APIs and what every request payload key means.

## Base URL

- Local: `http://localhost:3000`

## Recommended API Call Flow

1. Call `GET /health`.
2. If healthy, call `POST /jobs` to enqueue work.
3. Check worker logs for processing.
4. Validate persistence with `npm.cmd run validate:db`.
5. Use `POST /dead-letter/:id/reprocess` only for failed jobs already in DLQ.

## Endpoint 1: Health

### `GET /health`

Purpose:
- Confirms producer process is up and serving requests.

Request body:
- None.

Success:
- Status: `200`
- Body:

```json
{
  "ok": true,
  "service": "producer"
}
```

## Endpoint 2: Enqueue Job

### `POST /jobs`

Purpose:
- Enqueues a job to the correct BullMQ queue based on metadata (`priority`, `workload`, `partitionKey`, optional `shardCount`).

Success:
- Status: `202`
- Body:

```json
{
  "accepted": true,
  "queueName": "default-io",
  "jobId": "tenant1__tenant1__email.send__user123__send__v1-001",
  "delayed": false,
  "delayMs": 0
}
```

### Request Body Schema

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
      "workload": "io-bound",
      "partitionKey": "user123"
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

### Top-Level Keys

- `job`: Required. Job envelope containing `name`, `metadata`, and `payload`.
- `delayMs`: Optional. Delay before job becomes available to workers. Must be `>= 0`.
- `shardCount`: Optional. Number of route shards for partitioning. Must be `1..1024`.

### `job` Keys

- `job.name`: Required. Job type.
  - Allowed values:
  - `email.send`
  - `report.generate`
  - `webhook.dispatch`
- `job.metadata`: Required. Delivery/idempotency/routing information.
- `job.payload`: Required. Business payload for the selected `job.name`.

### `job.metadata` Keys

- `idempotencyKey`: Required (min 8 chars).
  - Why: prevents duplicate side effects for retries/re-submits.
  - Note: if missing/invalid, service auto-generates one.
- `correlationId`: Required (min 8 chars).
  - Why: trace one request across logs/systems.
- `requestedAt`: Required (ISO datetime string).
  - Why: records request time and aids debugging/auditing.
- `tenantId`: Required (non-empty string).
  - Why: tenant isolation, per-tenant throttling, and DB partitioning context.
- `schemaVersion`: Required (integer >= 1).
  - Why: supports payload contract evolution safely.
- `priority`: Required.
  - Allowed: `high`, `default`, `low`.
  - Why: influences queue routing/priority behavior.
- `workload`: Required.
  - Allowed: `io-bound`, `cpu-heavy`.
  - Why: routes to workload-appropriate queue.
- `partitionKey`: Optional string.
  - Why: consistent routing for related jobs when partitioning/sharding is needed.

### `job.payload` by Job Type

For `email.send`:

- `to`: Required email address.
- `subject`: Required non-empty subject.
- `body`: Required non-empty message body.

Example:

```json
{
  "name": "email.send",
  "metadata": {
    "idempotencyKey": "tenant1:email.send:user123:send:v1-001",
    "correlationId": "corr-email-001",
    "requestedAt": "2026-03-09T00:00:00.000Z",
    "tenantId": "tenant1",
    "schemaVersion": 1,
    "priority": "default",
    "workload": "io-bound"
  },
  "payload": {
    "to": "user@example.com",
    "subject": "Welcome",
    "body": "Hello"
  }
}
```

For `report.generate`:

- `reportId`: Required non-empty report identifier.
- `format`: Required output format (`csv` or `pdf`).

Example:

```json
{
  "name": "report.generate",
  "metadata": {
    "idempotencyKey": "tenant1:report.generate:report-42:v1-001",
    "correlationId": "corr-report-001",
    "requestedAt": "2026-03-09T00:00:00.000Z",
    "tenantId": "tenant1",
    "schemaVersion": 1,
    "priority": "default",
    "workload": "cpu-heavy"
  },
  "payload": {
    "reportId": "report-42",
    "format": "csv"
  }
}
```

For `webhook.dispatch`:

- `endpoint`: Required valid URL.
- `eventType`: Required non-empty event name.
- `data`: Required object payload delivered to webhook target.

Example:

```json
{
  "name": "webhook.dispatch",
  "metadata": {
    "idempotencyKey": "tenant1:webhook.dispatch:user.created:v1-001",
    "correlationId": "corr-webhook-001",
    "requestedAt": "2026-03-09T00:00:00.000Z",
    "tenantId": "tenant1",
    "schemaVersion": 1,
    "priority": "high",
    "workload": "io-bound",
    "partitionKey": "tenant1"
  },
  "payload": {
    "endpoint": "https://example.com/webhook",
    "eventType": "user.created",
    "data": {
      "userId": "u-123",
      "email": "user@example.com"
    }
  }
}
```

## Endpoint 3: Reprocess Dead Letter

### `POST /dead-letter/:id/reprocess`

Purpose:
- Requeue a failed job from dead-letter storage.

Path parameter:
- `id`: required positive integer dead-letter record id.

Request body:
- None.

Success:
- Status: `202`
- Body:

```json
{
  "accepted": true,
  "queue": "default-io",
  "jobId": "12345"
}
```

Common errors:
- `400 INVALID_DLQ_ID` when `id` is not a positive integer.
- `404 DLQ_NOT_FOUND` when no dead-letter row exists for that id.

## Common Error Responses

Validation failure:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Invalid request payload",
  "details": []
}
```

Backpressure/rate limits:

- `429 TENANT_RATE_LIMITED` with `Retry-After: 5`
- `503 QUEUE_OVERLOADED` with `Retry-After: 5`
- `503 DB_SATURATED` with `Retry-After: 5`
- `503 DB_TRANSIENT_ERROR` with `Retry-After: 5`

Payload/delay limits:

- `413 PAYLOAD_TOO_LARGE`
- `400 DELAY_HORIZON_EXCEEDED`

## Runtime Behavior (Retries, Buffer Time, Timeouts)

These are not request payload keys. They are service-level settings from `.env` that control execution behavior.

- `QUEUE_ATTEMPTS` (default `5`):
  - Total attempts per job (first try + retries).
  - Example: `5` means 1 initial attempt and up to 4 retries.

- `QUEUE_BACKOFF_MS` (default `1000`):
  - Delay before retrying a failed attempt.
  - This acts as retry buffer time between attempts.

- `JOB_TIMEOUT_DEFAULT_MS` (default `120000`):
  - Max runtime for a single attempt before timeout handling marks it failed/retryable.

- `QUEUE_LOCK_DURATION_MS` (default `60000`):
  - Worker lock lease duration while processing a job.

- `QUEUE_STALLED_INTERVAL_MS` (default `30000`):
  - How often stalled jobs are checked by BullMQ.

- `QUEUE_MAX_STALLED_COUNT` (default `1`):
  - Max stalled recoveries allowed before job is treated as failed.

- `QUEUE_RATE_LIMIT_MAX` + `QUEUE_RATE_LIMIT_DURATION_MS` (defaults `100` per `1000ms`):
  - Tenant-level API admission limit.
  - If exceeded, API returns `429 TENANT_RATE_LIMITED`.

- `QUEUE_MAX_DEPTH` (default `200000`):
  - Queue depth safety cap; API returns `503 QUEUE_OVERLOADED` when crossed.

- `QUEUE_MAX_DELAYED_HORIZON_MS` (default `604800000` = 7 days):
  - Maximum allowed `delayMs` in `POST /jobs`.

Practical formula for worst-case completion window per job:

- Approx upper bound = `QUEUE_ATTEMPTS * JOB_TIMEOUT_DEFAULT_MS + (QUEUE_ATTEMPTS - 1) * QUEUE_BACKOFF_MS + delayMs`

This is a rough operational estimate and excludes infrastructure outages.

## Quick Usage Examples (PowerShell)

Health:

```powershell
Invoke-RestMethod -Method Get -Uri http://localhost:3000/health
```

Enqueue email job:

```powershell
$body = @{
  job = @{
    name = 'email.send'
    metadata = @{
      idempotencyKey = "tenant1:email.send:user123:send:v1-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
      correlationId = "corr-$([Guid]::NewGuid().ToString('N').Substring(0,12))"
      requestedAt = (Get-Date).ToUniversalTime().ToString('o')
      tenantId = 'tenant1'
      schemaVersion = 1
      priority = 'default'
      workload = 'io-bound'
    }
    payload = @{
      to = 'user@example.com'
      subject = 'Hello'
      body = 'Queue test'
    }
  }
}

Invoke-RestMethod -Method Post -Uri http://localhost:3000/jobs -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 10)
```
