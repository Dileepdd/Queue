# Pre-Build Decisions (Section 0)

This document finalizes all pre-build setup decisions before feature implementation.

## 1) SLOs, throughput, and burst assumptions

- Target throughput: **1,000,000 jobs/day** (~11.6 jobs/sec average).
- Peak burst assumption: **10x average** (~120 jobs/sec sustained for short windows).
- High-priority queue start latency SLO: **p95 < 30s**.
- Low-priority queue start latency SLO: **p95 < 5m**.
- Terminal failure rate SLO: **< 1% / day** (excluding business-valid rejects).
- Recovery time objective (RTO): **<= 5 minutes** after worker crash.
- Capacity policy: operate with **>= 30% headroom** over forecasted peak.

## 2) Infrastructure choices

- Redis: managed Redis with **primary + replica + automatic failover**.
- Redis persistence: **AOF everysec** (RDB optional snapshots for faster restart).
- Redis memory policy: **noeviction** for dedicated queue Redis.
- Database: managed PostgreSQL primary (read replica optional later).
- Deployment platform: containerized deployment with independent producer/worker scaling.
- Network: private networking between app, Redis, and DB; TLS for external edges.

## 3) Job contract baseline

All jobs must include:
- `jobName: string`
- `schemaVersion: number`
- `idempotencyKey: string`
- `correlationId: string`
- `requestedAt: string` (ISO timestamp)
- `tenantId: string`
- `payload: object` (job-specific schema)

Contract rules:
- Runtime schema validation on enqueue and worker consume.
- Worker supports current and previous schema versions during migration.
- Breaking payload changes require new job name or migration transformer.

## 4) Idempotency contract

- Delivery semantics: **at-least-once execution**.
- Correctness target: **exactly-once side effects**.
- Idempotency key format: `<tenantId>:<jobName>:<businessEntityId>:<operation>:<version>`.
- Worker behavior:
  1. Atomic DB claim (`INSERT ... ON CONFLICT DO NOTHING`)
  2. If claimed, execute side effects
  3. If duplicate, short-circuit and return deterministic result
- Side effects never execute before a successful claim.

## 5) Status model and error taxonomy

State machine:
- `queued -> active -> completed`
- `queued|active -> failed`
- `failed (terminal) -> dead-lettered`
- Duplicate path -> `duplicate`

Error taxonomy:
- `ValidationError` (non-retryable)
- `DependencyTimeoutError` (retryable)
- `DependencyRateLimitError` (retryable with backoff)
- `BusinessRuleError` (non-retryable)
- `InternalError` (retryable by policy)

## 6) DB schema + index baseline

Idempotency tables:
- `idempotency_records`
  - Unique: `(tenant_id, idempotency_key)`
  - Index: `(tenant_id, created_at DESC)`

Status tables:
- `job_status_current`
  - Unique: `(queue, job_id)`
  - Index: `(tenant_id, status, updated_at DESC)`
- `job_status_events`
  - Index: `(job_id, created_at)`
  - Index: `(status, updated_at)` for retry/DLQ operations

Data lifecycle:
- Archive/purge strategy for old idempotency and status events to keep active indexes small.

## 7) Observability baseline

Structured logs (JSON required fields):
- `timestamp`, `level`, `service`, `env`, `tenantId`, `queue`, `jobName`, `jobId`, `attempt`, `idempotencyKey`, `correlationId`, `schemaVersion`, `event`, `durationMs`, `errorCode`

Metrics baseline:
- Queue depth and queue age p95/p99
- Enqueue-to-start and processing latency p50/p95/p99
- Throughput (jobs/sec), retry rate, terminal failure rate
- DLQ size and growth
- Redis memory %, ops/sec, command latency, reconnect count
- DB idempotency claim latency, lock wait, deadlock count, pool saturation

Alert baseline:
- Queue age SLO breach
- Retry storm
- DLQ surge
- Redis saturation
- DB contention thresholds

## 8) CI/CD, secrets, config, and security baseline

- CI gates: lint, typecheck, tests, build.
- Deployment: staged rollout with rollback capability.
- Secrets: centralized secret manager; no secrets in repo.
- Config: strict startup validation (already implemented in `src/config/env.ts`).
- Security:
  - Principle of least privilege for DB/Redis credentials
  - Dependency vulnerability scanning in CI
  - Audit logging for operational actions (DLQ reprocess, scaling overrides)

---

## Sign-off criteria

Section 0 is complete when this document is accepted as the working baseline and used for implementation in Sections 2+.
