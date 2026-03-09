# Production Queue System Roadmap (Node.js + TypeScript + BullMQ + Redis + Express)

Implementation roadmap for a small team operating a high-scale SaaS queue system (~1M jobs/day) with strong reliability, horizontal scalability, and controllable complexity.

---

## Step 0) Define scale assumptions, objectives, and constraints

**Scale baseline**
- Target throughput: 1,000,000 jobs/day (~11.6 jobs/sec average).
- Peak assumption: 10x burst window (~120 jobs/sec sustained for short intervals).
- Delivery: at-least-once execution, exactly-once side effects via idempotency.

**Hard constraints**
- Producer and worker are separate deployable services.
- Duplicate execution is expected and must be safe.
- Side effects are never executed before atomic idempotency claim.

**Acceptance criteria**
- Throughput and burst assumptions are documented and owned.
- Delivery semantics and handler contract are approved by engineering + operations.

---

## Step 1) Scale risk register (explicit)

Capture risks before implementation:

1. Hidden scaling risks
  - Queue hot spots from uneven routing.
  - Retry storms causing self-amplified load.
  - Delayed-job accumulation causing memory growth.
2. Single points of failure
  - Single Redis node without HA.
  - Single worker deployment per queue class.
  - Single DB writer bottleneck.
3. Concurrency bottlenecks
  - Global limiter too strict for mixed workloads.
  - CPU-bound jobs blocking lock renewal.
4. Redis saturation risks
  - Memory pressure from retained completed/failed jobs.
  - High command rate from excessive polling/events.
5. DB contention risks (idempotency)
  - Hot unique index contention on `idempotency_key`.
  - Lock contention from long transactions around status writes.

**Acceptance criteria**
- Risk register has owner, mitigation, and detection metric per risk.
- Every high-severity risk has a runbook entry.

---

## Step 2) Bootstrap project boundaries and minimal architecture

Structure:
- `src/config` (env, redis, queue, limits, slo)
- `src/jobs` (typed payloads, schemas, schemaVersion)
- `src/producer` (API + routing)
- `src/worker` (worker factory + lifecycle)
- `src/idempotency` (claim/finalize)
- `src/status` (append-only state transitions)
- `src/dead-letter` (terminal failures + reprocess)
- `src/infra` (db/redis clients)
- `src/shared` (logger, tracing, errors)
- Entrypoints: `src/index-producer.ts`, `src/index-worker.ts`

SPOF reduction (small-team realistic):
- Run at least 2 worker replicas per queue class.
- Keep one Redis primary + one replica + automatic failover (managed service preferred).
- Use one relational DB primary with read replica only if required later.

Scaling annotation:
- Producer tier is stateless and horizontally scaled behind load balancer (N instances).
- Worker tier is independently horizontally scaled per queue class (N instances each).
- Deploy producer and worker autoscaling policies separately to avoid coupled failure modes.

**Acceptance criteria**
- Producer and worker boot independently.
- No queue class relies on single worker instance.

---

## Step 3) Environment contract and startup validation

Define required env:
- App: `NODE_ENV`, `PORT`, `SERVICE_NAME`, `LOG_LEVEL`
- Redis: `REDIS_URL` or host/port credentials, TLS settings
- Queue: attempts, backoff, concurrency, lock/stall tuning
- Rate limits: queue-level and downstream API-level
- Timeouts: default + per-job override
- DB: `DATABASE_URL`, pool size, statement timeout
- Limits: max queue depth, max payload bytes, max delayed horizon

Validation rules:
- Fail fast on invalid/missing config.
- Enforce sane bounds (e.g., concurrency and timeout min/max).

**Acceptance criteria**
- Startup fails for out-of-range operational settings.
- Config object is typed, immutable, and environment-specific.

---

## Step 4) Queue isolation and starvation-safe routing

Queue classes:
- Priority: `high-priority`, `default`, `low-priority`
- Workload: `cpu-heavy`, `io-bound`

Routing policy:
- High and low priority never share the same worker pool.
- CPU-heavy jobs are isolated to dedicated worker process group.
- IO-bound jobs use higher concurrency and tighter downstream limiter.

Starvation prevention:
- Reserve minimum consumers for low-priority queues.
- Apply weighted capacity budget per queue class.
- Alert on queue age p95/p99, not only depth.

Queue partitioning strategy:
- Start with logical partitioning by queue class (priority + workload).
- Add shard queues when hot spots appear: `queueName:shard-{0..N-1}` by stable hash (`tenantId` or `entityId`).
- Keep ordering-sensitive workloads pinned to partition key.
- Rebalance by increasing shard count only for saturated classes, not globally.

Scaling annotation:
- Multiple worker nodes consume the same queue class safely (BullMQ competing consumers).
- Partitioned queues allow targeted horizontal scaling without full-system rebalance.

**Acceptance criteria**
- High-priority backlog cannot starve low-priority beyond configured age SLO.
- CPU-heavy backlog does not degrade IO-bound queue latency SLO.

---

## Step 5) Redis and BullMQ production configuration

BullMQ shared config:
- Connection options for producer/worker.
- Default job options: attempts, exponential backoff, delayed support.
- Queue-specific options: lock duration, stalled interval, max stalled count.

Redis durability and saturation policy:
- Persistence: AOF `everysec` as default, optional RDB snapshots for recovery speed.
- Memory: `noeviction` for dedicated queue Redis.
- Retention: aggressively trim completed/failed jobs (count/age caps).
- Connection strategy: bounded reconnect with jitter + circuit-breaker behavior in producer.
- Capacity guardrails: alert on used memory %, blocked clients, ops/sec, command latency.

Redis connection pooling considerations:
- Use singleton Redis clients per process role; never create per-request connections.
- Separate connection budgets for producer API and worker nodes.
- Reuse shared non-blocking connection for `Queue`/`QueueEvents`; use dedicated blocking connection for each `Worker` process.
- Set max connections per pod/node and monitor connection churn.
- Add startup backoff and jitter to avoid thundering-herd reconnect after Redis failover.

Scaling annotation:
- Connection budget scales with instance count and is treated as a hard capacity input.

**Acceptance criteria**
- Redis config includes explicit persistence and memory policy.
- Job retention policy prevents unbounded memory growth.

---

## Step 6) Lock duration and timeout tuning policy

`lockDuration` policy:
- Start with `lockDuration = max(2 * p99_runtime, 30s)` per queue class.
- Recompute weekly from observed runtime metrics.

Long-running jobs:
- Prefer chunking/checkpointing for tasks > 2 minutes.
- If non-chunkable, isolate queue and set larger lock + timeout.

Hanging detection:
- Soft runtime threshold warning.
- Hard timeout fail and classify retryability.

False stall avoidance:
- Keep CPU-heavy work out of event loop where possible.
- Tune `stalledInterval` and `maxStalledCount` per queue class.

**Acceptance criteria**
- False stalls remain below threshold.
- Timeout policy exists for every job type.

---

## Step 7) Type-safe job contracts and schema versioning

Per-job contract includes:
- `jobName`, typed payload/result, runtime schema validation
- Required metadata: `idempotencyKey`, `correlationId`, `requestedAt`, `schemaVersion`

Versioning rules:
- Support current and previous schema version in workers.
- Breaking changes require new `jobName` or migration transformer.
- DLQ reprocessor performs version-aware transformation.

**Acceptance criteria**
- Unsupported schema versions fail fast with explicit reason.
- DLQ reprocess supports at least one previous schema version.

---

## Step 8) Producer API, admission control, and burst handling

Producer flow:
- Validate payload + schemaVersion.
- Generate/accept idempotency key.
- Route to queue by priority/workload policy.
- Support delayed jobs with horizon limit.
- Persist initial status if API contract requires synchronous visibility.

Burst and overload controls:
- API rate limits per tenant/client.
- Queue admission control when depth/age exceeds safe limits.
- Return explicit overload response and retry guidance.

Backpressure handling strategy:
- Implement layered backpressure: API throttling -> queue admission control -> downstream limiter.
- Return `429`/`503` with retry-after semantics when queue age/depth breaches threshold.
- Use per-tenant quotas to prevent a single tenant from exhausting shared capacity.
- Apply dynamic enqueue throttling based on Redis latency and queue age signals.

Scaling annotation:
- Producer instances scale horizontally while preserving global safety through centralized queue-age and quota checks.

**Acceptance criteria**
- Producer degrades gracefully under burst; does not flood Redis.
- Admission control triggers before SLO collapse.

---

## Step 9) Worker module with concurrency and limiter controls

Worker factory parameters:
- `queueName`, `processor`, `concurrency`, limiter config, timeout policy

Concurrency policy:
- Sequential mode (`concurrency=1`) for ordering-sensitive handlers.
- Parallel mode for independent jobs.
- Queue-class-specific concurrency caps to prevent downstream overload.

Downstream protection:
- Queue-level limiter + per-integration limiter.
- Retry jitter to avoid synchronized retry spikes.

Worker scaling strategy:
- Horizontal first: add worker nodes before raising per-node concurrency.
- Scale independently per queue class and per partition shard.
- Keep conservative per-node concurrency to reduce GC pauses and lock-renewal risk.
- Use queue age + queue depth + in-flight jobs as autoscaling signals.
- Enforce max scale guardrail to avoid Redis/DB overload from aggressive autoscaling.

Scaling annotation:
- Worker nodes are fungible; no sticky assignment required except ordering-sensitive partition keys.

**Acceptance criteria**
- Worker supports per-queue concurrency and limiter overrides.
- No downstream API saturation during synthetic burst test.

---

## Step 10) Idempotency design with DB contention mitigation

Contract:
- At-least-once execution is expected; side effects must be exactly-once by key.

DB design:
- `idempotency_records` with unique index on `(tenant_id, idempotency_key)`.
- Keep claim transaction short: claim first, perform side effect, finalize status.
- Store deterministic result hash/outcome for duplicate requests.

DB index strategy (idempotency):
- Primary unique index: `(tenant_id, idempotency_key)`.
- Lookup index for operations: `(tenant_id, created_at DESC)` for cleanup and audits.
- Optional partial index on recent window (`created_at >= now()-X`) when table is very large.
- Archive or partition historical rows by time to keep active index set small.

Contention mitigation:
- Partition key space logically (tenant-scoped key).
- Use upsert/insert-on-conflict pattern, avoid explicit `SELECT` before claim.
- Separate idempotency write path from heavy status analytics queries.
- Add TTL/archive strategy for old idempotency rows to keep index hot set small.

**Acceptance criteria**
- Duplicate execution never duplicates side effects.
- p95 idempotency claim latency remains within target under peak load test.

---

## Step 11) Retry, DLQ, and retry-storm protection

Retry rules:
- Exponential backoff with max attempts.
- Retryable vs permanent classification by error type.
- Jitter enabled to reduce synchronized retries.

DLQ rules:
- Terminal failures moved to DLQ with payload, schemaVersion, stack, attempts.
- Reprocess requires explicit operator action, validation, and provenance link.

Storm prevention:
- Cap global in-flight retries per queue class.
- Trigger protective throttling when retry rate spikes.

**Acceptance criteria**
- DLQ growth is observable and alert-backed.
- Retry storms are detected and rate-limited automatically.

---

## Step 12) Status tracking and write amplification control

State model:
- `queued -> active -> completed`
- `queued|active -> failed`
- terminal -> `dead-lettered`
- duplicate -> `duplicate`

Write strategy:
- Append-only transition log for audit correctness.
- Optional denormalized current-state table for fast reads.
- Batch/non-critical status updates where possible to reduce DB pressure.

DB index strategy (status tables):
- `job_status_current`: unique `(queue, job_id)` and filter index `(tenant_id, status, updated_at DESC)`.
- `job_status_events`: index `(job_id, created_at)` for trace replay.
- Operational index `(status, updated_at)` for retry/DLQ scanners.
- Avoid over-indexing write-heavy tables; verify each index via query plan.

Scaling annotation:
- Keep hot read paths on current-state table; keep event log append-only to reduce lock contention.

**Acceptance criteria**
- End-to-end trace exists for every job.
- Status write QPS remains within DB capacity at peak test load.

---

## Step 13) Graceful shutdown and restart safety

On `SIGINT`/`SIGTERM`:
1. Stop intake.
2. Pause worker.
3. Drain in-flight jobs within timeout budget.
4. Close BullMQ/Redis/DB connections cleanly.
5. Emit shutdown completion log and exit deterministically.

**Acceptance criteria**
- Controlled restart causes no partial side effects.
- Post-restart recovery meets RTO target.

---

## Step 14) Observability baseline for 1M/day

Structured logs (JSON required fields):
- `timestamp`, `level`, `service`, `env`, `tenantId`, `queue`, `jobName`, `jobId`, `attempt`, `idempotencyKey`, `correlationId`, `schemaVersion`, `event`, `durationMs`, `errorCode`

Required metrics:
- Queue depth and queue age p95/p99 by class
- Enqueue-to-start latency and processing latency p50/p95/p99
- Throughput (jobs/sec), retry rate, terminal failure rate
- DLQ size and growth rate
- Redis: memory %, ops/sec, command latency, reconnect count
- DB: idempotency claim latency, lock wait, deadlock count, pool saturation

Monitoring baseline:
- Dashboards per queue class + tenant slice.
- Alerts for SLO breach, saturation signals, retry storm, DLQ surge.

**Acceptance criteria**
- A single job is traceable across API, worker, Redis events, and DB.
- Saturation alerts trigger before customer-visible degradation.

---

## Step 15) SLOs, error budgets, and operational thresholds

Define SLO targets (example):
- High-priority start latency p95 < 30s
- Low-priority start latency p95 < 5m
- Terminal failure rate < 1% per day
- Throughput capacity >= planned peak + 30% headroom
- RTO <= 5m after worker crash

Operational thresholds:
- Queue age threshold for admission control
- Redis memory threshold for enqueue protection
- DB contention threshold for idempotency fallback controls

**Acceptance criteria**
- SLOs map directly to dashboards and pages.
- Error budget policy defines freeze/rollback actions.

---

## Step 16) Failure-mode testing at scale

Required tests:
1. Worker crash during long jobs
2. Redis restart/failover under active load
3. Duplicate delivery with same idempotency key
4. Network partition between worker and Redis
5. Downstream API slowness with burst input
6. DB contention simulation on idempotency index

**Acceptance criteria**
- No duplicate side effects in any scenario.
- Recovery stays within RTO and latency SLO envelopes.
- Test report includes observed bottlenecks and tuned settings.

---

## Step 17) Operational limits and scaling strategy (final)

Define hard limits:
- Max queue depth/age per class
- Max concurrency per queue class
- Max delayed horizon and payload size
- Max retry amplification factor

Scaling strategy (small team):
- Phase 1: vertical scale Redis + DB, horizontal scale workers by queue class.
- Phase 2: split hottest queue classes into dedicated workers.
- Phase 3: shard queues by tenant segment only when sustained saturation persists.

Runbook-driven operations:
- Admission control on overload.
- Controlled concurrency tuning playbook.
- DLQ triage and safe reprocess workflow.
- Capacity review weekly using queue age, Redis, and DB contention metrics.

Horizontal scaling annotations:
- Producer scaling unit: stateless API replica.
- Worker scaling unit: queue-class worker replica and shard-specific worker replica.
- Partition scaling unit: increase shard count only for saturated queues.
- Capacity gates before scaling: Redis memory/latency, DB lock wait, idempotency claim latency.

**Acceptance criteria**
- Load test at target peak + safety margin passes.
- Scaling playbook enables on-call to recover without code changes.

---

## Definition of done checklist

- [ ] Scale risk register completed with owners and mitigations
- [ ] Queue isolation prevents starvation under mixed load
- [ ] Redis durability/memory/reconnect policy validated
- [ ] Concurrency + limiter configuration prevents downstream overload
- [ ] Idempotency table contention controlled at peak load
- [ ] Retry storms are detected and auto-throttled
- [ ] Observability covers Redis and DB saturation signals
- [ ] SLOs and thresholds are alert-backed
- [ ] Failure-mode tests pass at realistic scale
- [ ] Operational limits and scaling runbook approved

---

## Suggested implementation order (strict)

1. Steps 0-5 (assumptions, risks, architecture, isolation, Redis policy)
2. Steps 6-9 (lock/timeout tuning, contracts, producer, worker controls)
3. Steps 10-12 (idempotency contention controls, retry/DLQ, status model)
4. Steps 13-15 (shutdown, observability, SLOs)
5. Steps 16-17 (scale tests, operational limits, scaling execution)

This sequence reduces correctness risk first, then saturation risk, then growth risk.