# API Usage and Payload Reference

This document explains how to use the producer service APIs and what every request payload key means.

## Base URL

- Local: `http://localhost:3000`

## Client Authentication (Recommended: Bearer Token)

Recommended mode for clients is bearer token auth.

When `AUTH_BEARER_ENABLED=true`, these endpoints accept:

- `Authorization: Bearer <accessToken>`

Protected endpoints:

- `POST /jobs`
- `GET /jobs`
- `GET /jobs/:jobId`
- `GET /jobs/:jobId/events`
- `POST /dead-letter/:id/reprocess`

`GET /health` remains public.

`accessToken` is the client `secretValue` returned by admin `create`/`rotate` API key calls.

Token storage note:

- Bearer access tokens are validated via SHA-256 hash lookup (`bearer_token_hash`).
- Legacy rows without hash are upgraded on first successful bearer authentication.

Revocation behavior:

- If admin calls `POST /admin/keys/:id/revoke`, that token becomes invalid immediately.

## Client Authentication (HMAC Compatibility Mode)

If bearer token is not used, HMAC headers are still supported:

Required HMAC headers:

- `X-Access-Key-Id`: client key id from `api_clients.key_id`
- `X-Timestamp`: unix seconds, unix milliseconds, or ISO timestamp
- `X-Nonce`: unique per request
- `X-Signature`: hex HMAC-SHA256 signature

Canonical string to sign:

```text
{METHOD}\n{PATH_WITH_QUERY}\n{TIMESTAMP_MS}\n{NONCE}\n{SHA256_HEX_OF_RAW_BODY}
```

Notes:

- `TIMESTAMP_MS` is normalized to milliseconds on the server.
- For empty body, body hash is SHA256 of empty bytes.
- Nonces are one-time use within `AUTH_NONCE_TTL_MS`.

## Platform Admin Authentication

Admin key-management endpoints use header token auth:

- Header: `X-Admin-Token`
- Value: must match `ADMIN_API_TOKEN` from service `.env`

Admin endpoints:

- `GET /admin/keys`
- `POST /admin/keys`
- `POST /admin/keys/:id/rotate`
- `POST /admin/keys/:id/revoke`

### Admin Route Details (Line by Line)

#### 1. `GET /admin/keys`

Purpose:
- Lists client keys available in `api_clients`.

Headers:
- `X-Admin-Token: <ADMIN_API_TOKEN>`

Query parameters:
- `tenantId` (optional)
- `status` (optional: `active` or `revoked`)

Success:
- Status: `200`
- Body:

```json
{
  "items": [
    {
      "keyId": "client_demo_key_001",
      "tenantId": "tenant1",
      "clientName": "Demo Client",
      "status": "active",
      "createdAt": "2026-03-10T05:35:42.755Z",
      "updatedAt": "2026-03-10T05:35:42.755Z",
      "revokedAt": null,
      "lastUsedAt": null
    }
  ]
}
```

Common errors:
- `401 ADMIN_AUTH_MISSING_TOKEN`
- `401 ADMIN_AUTH_INVALID_TOKEN`

#### 2. `POST /admin/keys`

Purpose:
- Creates a new client key and one-time secret for HMAC auth.

Headers:
- `X-Admin-Token: <ADMIN_API_TOKEN>`
- `Content-Type: application/json`

Request body:

```json
{
  "tenantId": "tenant1",
  "clientName": "Acme Worker"
}
```

Optional body key:
- `keyId` (if omitted, server generates it).

Success:
- Status: `201`
- Body includes `secretValue` once:

```json
{
  "keyId": "client_f0e1d2c3b4a59687",
  "tenantId": "tenant1",
  "clientName": "Acme Worker",
  "status": "active",
  "createdAt": "2026-03-10T06:00:00.000Z",
  "secretValue": "generated-secret-value"
}
```

Common errors:
- `400 VALIDATION_ERROR`
- `409 ADMIN_KEY_EXISTS`

#### 3. `POST /admin/keys/:id/rotate`

Purpose:
- Keeps same `keyId` and generates a new `secretValue`.

Why rotate:
- Routine security rotation.
- Incident response for suspected secret leakage.

Headers:
- `X-Admin-Token: <ADMIN_API_TOKEN>`

Path parameter:
- `id` = existing key id.

Success:
- Status: `200`
- Body:

```json
{
  "keyId": "client_demo_key_001",
  "secretValue": "new-generated-secret",
  "rotatedAt": "2026-03-10T06:10:00.000Z"
}
```

Common errors:
- `404 ADMIN_KEY_NOT_FOUND`

#### 4. `POST /admin/keys/:id/revoke`

Purpose:
- Disables a key so it can no longer authenticate.

Why revoke:
- Client offboarding.
- Compromised credentials.
- Immediate access cut-off.

Headers:
- `X-Admin-Token: <ADMIN_API_TOKEN>`

Path parameter:
- `id` = existing key id.

Success:
- Status: `200`
- Body:

```json
{
  "keyId": "client_demo_key_001",
  "revoked": true,
  "revokedAt": "2026-03-10T06:20:00.000Z"
}
```

Common errors:
- `404 ADMIN_KEY_NOT_FOUND`

### Admin Verification Order

1. Call `GET /admin/keys` and confirm token works.
2. Call `POST /admin/keys` and save returned `keyId` and `secretValue`.
3. Call `POST /admin/keys/:id/rotate` and replace client `secretKey`.
4. Call protected `POST /jobs` with new secret and confirm `202`.
5. Call `POST /admin/keys/:id/revoke` and confirm protected calls fail for that key.

Example create request body:

```json
{
  "tenantId": "tenant1",
  "clientName": "Acme Worker"
}
```

Create/rotate responses include `secretValue` once. Persist it securely because it is required for bearer authentication and HMAC request signing.

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
- Enqueues a webhook job.
- You can send a minimal request (`job.name` + `job.payload`), and the service auto-fills metadata defaults.

Success:
- Status: `202`
- Body:

```json
{
  "accepted": true,
  "queueName": "default-io",
  "jobId": "tenant1__tenant1__webhook.dispatch__user.created__v1-001",
  "delayed": false,
  "delayMs": 0
}
```

### Request Body Schema

Minimal (recommended):

```json
{
  "uniqueId": "user-123",
  "job": {
    "name": "webhook.dispatch",
    "payload": {
      "endpoint": "https://example.com/webhook",
      "eventType": "user.created",
      "data": {
        "userId": "u-123",
        "email": "user@example.com"
      }
    }
  }
}
```

Full (optional metadata override):

```json
{
  "uniqueId": "user-123",
  "job": {
    "name": "webhook.dispatch",
    "metadata": {
      "idempotencyKey": "tenant1:webhook.dispatch:user.created:v1-001",
      "correlationId": "corr-001-abcdef",
      "requestedAt": "2026-03-09T00:00:00.000Z",
      "tenantId": "tenant1",
      "schemaVersion": 1,
      "priority": "default",
      "workload": "io-bound",
      "partitionKey": "tenant1"
    },
    "payload": {
      "endpoint": "https://example.com/webhook",
      "eventType": "user.created",
      "method": "POST",
      "headers": {
        "x-source": "queue-system"
      },
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

### Top-Level Keys

- `job`: Required. Job envelope containing `name` and `payload`.
- `job.metadata`: Optional. If omitted, service fills defaults.
- `uniqueId`: Optional user/entity routing key.
  - Recommended for per-user ordering: send same `uniqueId` for that user.
  - Mapped to `job.metadata.partitionKey` when `partitionKey` is not provided.
- `delayMs`: Optional. Delay before job becomes available to workers. Must be `>= 0`.
- `retryCount`: Optional. Number of retries after the first attempt. Must be `0..20`.
  - Example: `retryCount: 3` means up to 4 total attempts (1 first try + 3 retries).
- `shardCount`: Advanced optional. Number of queue shards for partition routing. Must be `1..1024`.
  - Most clients should not send this; platform defaults are usually enough.

### `job` Keys

- `job.name`: Required. Job type.
  - Allowed value: `webhook.dispatch`
- `job.metadata`: Optional. Delivery/idempotency/routing information.
- `job.payload`: Required. Business payload for the selected `job.name`.

### `job.metadata` Keys (All Optional)

- `idempotencyKey`: Optional (min 8 chars when provided).
  - Why: prevents duplicate side effects for retries/re-submits.
  - Note: if missing/invalid, service auto-generates one.
- `correlationId`: Optional (min 8 chars when provided).
  - Why: trace one request across logs/systems.
- `requestedAt`: Optional (ISO datetime string).
  - Why: records request time and aids debugging/auditing.
- `tenantId`: Optional (non-empty string).
  - Why: tenant isolation, per-tenant throttling, and DB partitioning context.
  - Note: when auth is enabled, tenant is inferred from auth context.
- `schemaVersion`: Optional (integer >= 1).
  - Why: supports payload contract evolution safely.
- `priority`: Optional.
  - Allowed: `high`, `default`, `low`.
  - Why: influences queue routing/priority behavior.
- `workload`: Optional.
  - Allowed: `io-bound`, `cpu-heavy`.
  - Why: routes to workload-appropriate queue.
- `partitionKey`: Optional string.
  - Why: consistent routing for related jobs when partitioning/sharding is needed.
  - Note: if missing, service uses `uniqueId` when provided; otherwise defaults to tenant id.

### `job.payload` for `webhook.dispatch`

- `endpoint`: Required valid URL.
- `eventType`: Required non-empty event name.
- `method`: Optional, one of `POST`, `PUT`, `PATCH` (defaults to `POST`).
- `headers`: Optional object of string headers.
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

## Endpoint 3: List Jobs

### `GET /jobs`

Purpose:
- Lists current job statuses for the authenticated tenant.

Authentication:
- Required (Bearer token or HMAC headers).

Query parameters:
- `status` (optional): `queued`, `active`, `completed`, `failed`, `dead-lettered`, `duplicate`
- `jobName` (optional): `webhook.dispatch`
- `cursor` (optional): ISO datetime cursor for pagination (`updatedAt` from previous response)
- `limit` (optional): integer `1..200`, default `50`

Success:
- Status: `200`
- Body:

```json
{
  "items": [
    {
      "queue": "default-io",
      "jobId": "tenant1__tenant1__webhook.dispatch__user.created__v1-001",
      "jobName": "webhook.dispatch",
      "status": "completed",
      "metadata": {
        "tenantId": "tenant1",
        "idempotencyKey": "tenant1:webhook.dispatch:user.created:v1-001",
        "correlationId": "corr-001-abcdef",
        "requestedAt": "2026-03-09T00:00:00.000Z",
        "schemaVersion": 1,
        "priority": "default",
        "workload": "io-bound"
      },
      "updatedAt": "2026-03-10T12:00:00.000Z"
    }
  ],
  "nextCursor": "2026-03-10T12:00:00.000Z"
}
```

Common errors:
- `400 VALIDATION_ERROR` for invalid query values.

## Endpoint 4: Get Job By Id

### `GET /jobs/:jobId`

Purpose:
- Fetches the current status row for one job under the authenticated tenant.

Authentication:
- Required (Bearer token or HMAC headers).

Path parameter:
- `jobId`: required non-empty job id string.

Success:
- Status: `200`
- Body:

```json
{
  "queue": "default-io",
  "jobId": "tenant1__tenant1__webhook.dispatch__user.created__v1-001",
  "jobName": "webhook.dispatch",
  "status": "completed",
  "metadata": {
    "tenantId": "tenant1",
    "idempotencyKey": "tenant1:webhook.dispatch:user.created:v1-001",
    "correlationId": "corr-001-abcdef",
    "requestedAt": "2026-03-09T00:00:00.000Z",
    "schemaVersion": 1,
    "priority": "default",
    "workload": "io-bound"
  },
  "updatedAt": "2026-03-10T12:00:00.000Z"
}
```

Common errors:
- `400 INVALID_JOB_ID` when `jobId` is empty.
- `404 JOB_NOT_FOUND` when job is missing for this tenant.

## Endpoint 5: Job Timeline

### `GET /jobs/:jobId/events`

Purpose:
- Returns the ordered event timeline for one tenant job, including attempt summary and key timestamps.

Authentication:
- Required (Bearer token or HMAC headers).

Path parameter:
- `jobId`: required non-empty job id string.

Success:
- Status: `200`
- Body:

```json
{
  "jobId": "tenant1__tenant1__webhook.dispatch__user.created__v1-001",
  "summary": {
    "totalEvents": 4,
    "totalAttempts": 1,
    "failedAttempts": 0,
    "completedAt": "2026-03-10T12:00:00.000Z",
    "firstSeenAt": "2026-03-10T11:59:00.000Z",
    "lastSeenAt": "2026-03-10T12:00:00.000Z"
  },
  "events": [
    {
      "id": 1001,
      "queue": "default-io",
      "jobId": "tenant1__tenant1__webhook.dispatch__user.created__v1-001",
      "jobName": "webhook.dispatch",
      "status": "queued",
      "metadata": {
        "tenantId": "tenant1",
        "idempotencyKey": "tenant1:webhook.dispatch:user.created:v1-001",
        "correlationId": "corr-001-abcdef",
        "requestedAt": "2026-03-09T00:00:00.000Z",
        "schemaVersion": 1,
        "priority": "default",
        "workload": "io-bound"
      },
      "createdAt": "2026-03-10T11:59:00.000Z"
    }
  ]
}
```

Summary fields:
- `totalEvents`: all timeline rows recorded for this job.
- `totalAttempts`: number of `active` transitions.
- `failedAttempts`: number of `failed` transitions.
- `completedAt`: first completion timestamp if present.
- `deadLetteredAt`: first dead-letter timestamp if present.
- `firstSeenAt` and `lastSeenAt`: bounds of the timeline.

Common errors:
- `400 INVALID_JOB_ID` when `jobId` is empty.
- `404 JOB_NOT_FOUND` when no timeline exists for this tenant+job.

## Endpoint 6: Reprocess Dead Letter

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
  - You can override per request using `retryCount` in `POST /jobs`.

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

## Endpoint 2B: Bulk Enqueue Jobs

### `POST /jobs/bulk`

Purpose:
- Accept up to `10,000` jobs in one API call.
- Server enqueues items one-by-one in request order.

Authentication:
- Required (Bearer token or HMAC headers).

Request body:

```json
{
  "defaults": {
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
          "data": {
            "recordId": "r-1"
          }
        }
      }
    }
  ]
}
```

Rules:
- `items` min `1`, max `10000`.
- Each item has same shape as `POST /jobs`.
- Item value overrides `defaults` when both are present.

Success:
- Status: `202`
- Body includes `totalEnqueued` and one result per item.

Notes:
- This endpoint bypasses per-request tenant admission limiting because the whole batch is one request.
- Queue capacity checks still apply.

## Quick Usage Examples (PowerShell)

Health:

```powershell
Invoke-RestMethod -Method Get -Uri http://localhost:3000/health
```

Enqueue webhook job:

```powershell
$body = @{
  uniqueId = 'user-123'
  job = @{
    name = 'webhook.dispatch'
    payload = @{
      endpoint = 'https://example.com/webhook'
      eventType = 'user.created'
      method = 'POST'
      headers = @{
        'x-source' = 'queue-system'
      }
      data = @{
        userId = 'u-123'
        email = 'user@example.com'
      }
    }
  }
}

Invoke-RestMethod -Method Post -Uri http://localhost:3000/jobs -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 10)
```

Bulk enqueue (single call):

```powershell
$items = 1..1000 | ForEach-Object {
  @{
    uniqueId = 'user-123'
    job = @{
      name = 'webhook.dispatch'
      payload = @{
        endpoint = 'https://example.com/webhook'
        eventType = 'data.imported'
        data = @{ recordId = "r-$_" }
      }
    }
  }
}

$bulkBody = @{
  defaults = @{ retryCount = 3; delayMs = 0 }
  items = $items
}

Invoke-RestMethod -Method Post -Uri http://localhost:3000/jobs/bulk -ContentType 'application/json' -Body ($bulkBody | ConvertTo-Json -Depth 20)
```
