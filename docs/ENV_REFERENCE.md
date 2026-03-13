# Environment Variables Reference

Complete reference for every environment variable in this queue system. All variables are validated at startup via Zod — the process will crash immediately if any value is invalid.

---

## Core / General

| Variable | Type | Default | Description |
|---|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` | Runtime environment. Controls logging format and behavior. |
| `SERVICE_NAME` | string | `queue-system` | Identifier used in structured log output. |
| `PORT` | integer (1–65535) | `3000` | HTTP port for the producer API. On Render, do **not** set this — Render injects it. |
| `LOG_LEVEL` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` | `info` | Pino log level. Use `debug` or `trace` only during development. |

---

## Redis

Redis is used exclusively by BullMQ for job queuing and worker coordination. You must provide either `REDIS_URL` or `REDIS_HOST` + `REDIS_PORT`.

| Variable | Type | Default | Description |
|---|---|---|---|
| `REDIS_URL` | URL string | — | Full Redis connection URL (e.g. `rediss://default:pass@host:6379`). Takes priority over host/port. |
| `REDIS_HOST` | string | — | Redis hostname. Required if `REDIS_URL` is not set. |
| `REDIS_PORT` | integer (1–65535) | — | Redis port. Required if `REDIS_URL` is not set. |
| `REDIS_USERNAME` | string | — | Redis username (Upstash uses `default`). |
| `REDIS_PASSWORD` | string | — | Redis password / token. |
| `REDIS_TLS` | boolean | `false` | Enable TLS for Redis connections. Set `true` for Upstash and most cloud providers. |

---

## PostgreSQL

PostgreSQL stores idempotency records, job status, dead-letter entries, auth clients, and request nonces.

| Variable | Type | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | string | **required** | Full Postgres connection string (e.g. `postgresql://user:pass@host:5432/db`). |
| `DB_SSL` | boolean | `true` | Enable SSL for database connections. Set `false` for local Docker Postgres. |
| `DB_SSL_REJECT_UNAUTHORIZED` | boolean | `false` | Reject connections with invalid SSL certificates. Keep `false` for Supabase/Neon session poolers. |
| `DB_POOL_MAX` | integer (1–200) | `20` | Maximum number of connections in the pg pool. See [recommended values](#db_pool_max-recommendations) below. |
| `DB_STATEMENT_TIMEOUT_MS` | integer (≥100) | `5000` | Maximum time a single SQL statement can run before being cancelled. |

### DB_POOL_MAX Recommendations

| Scenario | Recommended Value |
|---|---|
| Dev / demo (Supabase free tier) | 5–10 |
| Single server combined mode | 15–20 |
| Separate producer + worker | Producer: 10, Worker: 15–20 |
| High throughput (paid DB) | 30–50 |

**Too high**: Overwhelms the database with connections, increases memory usage, can hit provider connection limits (Supabase free = 60 max).

**Too low**: Requests queue up waiting for a pool connection, increasing latency. Under load this becomes the throughput bottleneck.

---

## Queue Behavior

Controls how BullMQ processes and retries jobs.

| Variable | Type | Default | Description |
|---|---|---|---|
| `QUEUE_ATTEMPTS` | integer (1–20) | `5` | Maximum retry attempts per job before it moves to dead-letter. |
| `QUEUE_BACKOFF_MS` | integer (≥100) | `1000` | Base delay between retries (exponential backoff). Actual delay = `QUEUE_BACKOFF_MS * 2^(attempt-1)`. |
| `QUEUE_CONCURRENCY` | integer (1–500) | `10` | Number of jobs each worker processes simultaneously. Higher values increase throughput but also DB/Redis load. |
| `QUEUE_LOCK_DURATION_MS` | integer (≥5000) | `60000` | How long a worker holds a lock on a job. If the job hasn't completed within this window, BullMQ considers it stalled. |
| `QUEUE_STALLED_INTERVAL_MS` | integer (≥5000) | `30000` | How often BullMQ checks for stalled jobs (jobs that exceeded their lock duration). |
| `QUEUE_MAX_STALLED_COUNT` | integer (0–10) | `1` | How many times a stalled job can be re-attempted. `0` = move to failed immediately when stalled. |

---

## Rate Limiting & Capacity

Guards that prevent queue overload and oversized payloads.

| Variable | Type | Default | Description |
|---|---|---|---|
| `QUEUE_RATE_LIMIT_MAX` | integer (≥1) | `100` | Maximum number of jobs a worker processes per rate-limit window. |
| `QUEUE_RATE_LIMIT_DURATION_MS` | integer (≥100) | `1000` | Duration of each rate-limit window in milliseconds. With defaults: 100 jobs/second per queue. |
| `JOB_TIMEOUT_DEFAULT_MS` | integer (≥1000) | `120000` | Default timeout applied to jobs that don't specify their own. After this duration the job is marked failed. |
| `QUEUE_MAX_DEPTH` | integer (≥1000) | `200000` | Maximum number of waiting jobs allowed per queue. Enqueue is rejected with 429 when exceeded. |
| `QUEUE_MAX_PAYLOAD_BYTES` | integer (≥1024) | `262144` | Maximum job payload size in bytes (default 256 KB). Larger payloads are rejected at enqueue. |
| `QUEUE_MAX_DELAYED_HORIZON_MS` | integer (≥1000) | `604800000` | Maximum delay allowed for delayed jobs (default 7 days). |

---

## Worker & Redis Budget

Controls which queues start and how aggressively the system polls Redis.

| Variable | Type | Default | Description |
|---|---|---|---|
| `WORKER_QUEUES` | comma-separated string | `""` (all 6 queues) | Which queues to start workers for. Valid names: `high-io`, `high-cpu`, `default-io`, `default-cpu`, `low-io`, `low-cpu`. Leave empty to start all 6. Example: `default-io,high-io`. |
| `SCALE_SIGNALS_ENABLED` | boolean | `true` | Enable autoscaling signal collection (queue depth sampling). Disable to save ~1.5 Redis cmd/sec per queue. |
| `SCALE_SIGNAL_INTERVAL_MS` | integer (≥5000) | `300000` | How often to collect scaling signals (default 5 minutes). Lower values give more responsive autoscaling but more Redis commands. |
| `REDIS_CONNECTION_BUDGET_PRODUCER` | integer (≥1) | `100` | Maximum ioredis connections the producer can open. |
| `REDIS_CONNECTION_BUDGET_WORKER` | integer (≥1) | `100` | Maximum ioredis connections the worker can open. |
| `DB_IDEMPOTENCY_CLAIM_WARN_MS` | integer (≥1) | `150` | Log a warning if the idempotency claim query takes longer than this. Useful for detecting slow DB performance. |

### Redis Command Budget (Upstash / Metered Plans)

BullMQ workers poll Redis continuously, even when idle. Each active queue generates ~12 Redis commands/second.

| Configuration | Cmd/sec | Cmd/day | Cmd/month |
|---|---|---|---|
| All 6 queues + signals | ~70 | ~6.0M | ~180M |
| 1 queue + signals (5 min) | ~13 | ~1.1M | ~34M |
| 1 queue + signals disabled | ~12 | ~1.0M | ~31M |

**Upstash Free Tier** (500K commands/month): Use `WORKER_QUEUES=default-io` and `SCALE_SIGNALS_ENABLED=false`. This gives ~12 cmd/sec which uses ~31M cmd/month — still over the free limit for always-on workers. Free tier is only viable if the process sleeps most of the time (e.g., Render free web service).

---

## Data Retention

Automated cleanup of old records. Runs as a periodic sweep inside the worker process.

| Variable | Type | Default | Description |
|---|---|---|---|
| `RETENTION_ENABLED` | boolean | `true` | Enable or disable the retention sweep entirely. |
| `RETENTION_INTERVAL_MS` | integer (≥60000) | `3600000` | How often the retention sweep runs (default 1 hour). |
| `RETENTION_IDEMPOTENCY_DAYS` | integer (≥1) | `30` | Delete idempotency records older than this many days. |
| `RETENTION_STATUS_EVENT_DAYS` | integer (≥1) | `30` | Delete job status event history older than this many days. |
| `RETENTION_DEAD_LETTER_DAYS` | integer (≥1) | `90` | Delete dead-letter records older than this many days. |

---

## Authentication

Controls how the producer API authenticates incoming requests.

| Variable | Type | Default | Description |
|---|---|---|---|
| `AUTH_HMAC_REQUIRED` | boolean | `false` | When `true`, all job submission endpoints require valid authentication (bearer token or HMAC signature). |
| `AUTH_BEARER_ENABLED` | boolean | `true` | Enable bearer token authentication (`Authorization: Bearer <token>`). Tokens are SHA-256 hashed before DB lookup. |
| `AUTH_CLOCK_SKEW_MS` | integer (≥1000) | `300000` | Maximum clock skew allowed for HMAC timestamp validation (default 5 minutes). |
| `AUTH_NONCE_TTL_MS` | integer (≥1000) | `300000` | How long HMAC nonces are stored to prevent replay attacks (default 5 minutes). Expired nonces are cleaned by the retention sweep. |
| `ADMIN_API_TOKEN` | string | `""` | Token required for admin endpoints (`GET /admin/keys`, `POST /admin/keys`, etc.) via `X-Admin-Token` header. Leave empty to disable admin endpoints (they return 401). |

---

## Webhook Dispatch

Controls how the worker delivers webhooks to target endpoints.

| Variable | Type | Default | Description |
|---|---|---|---|
| `WEBHOOK_TIMEOUT_MS` | integer (1000–120000) | `30000` | HTTP request timeout for each webhook delivery attempt. |
| `WEBHOOK_SIGNING_SECRET` | string | `""` | HMAC-SHA256 secret for signing webhook payloads. When set, each delivery includes `X-Webhook-Signature` and `X-Webhook-Timestamp` headers so receivers can verify authenticity. Leave empty to disable signing. |
| `WEBHOOK_SSRF_PROTECTION` | boolean | `true` | Block webhook delivery to private/internal IP ranges (127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, IPv6 loopback/ULA) and non-http(s) schemes. Set `false` only for local development. |

### How webhook signing works

When `WEBHOOK_SIGNING_SECRET` is set, each delivery adds:
- `X-Webhook-Signature: sha256=<hex>` — HMAC-SHA256 of `{timestamp}.{json_body}`
- `X-Webhook-Timestamp: <epoch_ms>` — timestamp used in the signature

Receiver verification (pseudocode):
```
expected = hmac_sha256(secret, timestamp + "." + raw_body)
valid = timing_safe_equal(expected, signature_from_header)
```

### Retry behavior

| Status code | Behavior |
|---|---|
| 2xx | Success — job completed |
| 429, 5xx | Retryable — BullMQ retries with exponential backoff |
| Other 4xx | Non-retryable — job discarded immediately, moves to dead-letter |

---

## Quick Copy (.env.example)

```dotenv
# Core
NODE_ENV=development
SERVICE_NAME=queue-system
PORT=3000
LOG_LEVEL=info

# Redis
REDIS_URL="rediss://default:<password>@<host>:6379"
REDIS_HOST=<host>
REDIS_PORT=6379
REDIS_USERNAME=default
REDIS_PASSWORD=<password>
REDIS_TLS=true

# PostgreSQL
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<db>
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=false
DB_POOL_MAX=20
DB_STATEMENT_TIMEOUT_MS=5000

# Queue Behavior
QUEUE_ATTEMPTS=5
QUEUE_BACKOFF_MS=1000
QUEUE_CONCURRENCY=10
QUEUE_LOCK_DURATION_MS=60000
QUEUE_STALLED_INTERVAL_MS=30000
QUEUE_MAX_STALLED_COUNT=1

# Rate Limiting & Capacity
QUEUE_RATE_LIMIT_MAX=100
QUEUE_RATE_LIMIT_DURATION_MS=1000
JOB_TIMEOUT_DEFAULT_MS=120000
QUEUE_MAX_DEPTH=200000
QUEUE_MAX_PAYLOAD_BYTES=262144
QUEUE_MAX_DELAYED_HORIZON_MS=604800000

# Worker & Redis Budget
WORKER_QUEUES=default-io
SCALE_SIGNALS_ENABLED=false
SCALE_SIGNAL_INTERVAL_MS=300000
REDIS_CONNECTION_BUDGET_PRODUCER=100
REDIS_CONNECTION_BUDGET_WORKER=100
DB_IDEMPOTENCY_CLAIM_WARN_MS=150

# Data Retention
RETENTION_ENABLED=true
RETENTION_INTERVAL_MS=3600000
RETENTION_IDEMPOTENCY_DAYS=30
RETENTION_STATUS_EVENT_DAYS=30
RETENTION_DEAD_LETTER_DAYS=90

# Webhook Dispatch
WEBHOOK_TIMEOUT_MS=30000
WEBHOOK_SIGNING_SECRET=
WEBHOOK_SSRF_PROTECTION=true

# Authentication
AUTH_HMAC_REQUIRED=false
AUTH_BEARER_ENABLED=true
AUTH_CLOCK_SKEW_MS=300000
AUTH_NONCE_TTL_MS=300000
ADMIN_API_TOKEN=replace-with-strong-admin-token
```
