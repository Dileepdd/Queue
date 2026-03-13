# Operations Runbook

## Deploy

1. Apply DB migrations in order: `001_reliability_core.sql`, `002_client_hmac_auth.sql`, `003_bearer_token_hash.sql`.
2. Deploy producer.
3. Deploy workers.
4. Verify health endpoint and worker startup logs.

## Rollback

1. Stop new rollout.
2. Scale down new worker version.
3. Restore previous stable image/tag.
4. Confirm queue drain and status progression.

## DLQ Triage

1. Inspect latest rows in `dead_letter_records`.
2. Group by reason and job name.
3. Fix root cause first.
4. Reprocess specific record via `POST /dead-letter/:id/reprocess`.

## Scaling

Signals to watch:
- Queue depth
- Queue age
- Active jobs
- Redis latency/memory
- Idempotency claim latency

Actions:
1. Increase worker replicas first.
2. Raise per-worker concurrency only if CPU/memory headroom exists.
3. Enable queue partition shard increase for hot queue classes.

## Redis Command Budget

BullMQ workers poll Redis continuously for new jobs, consuming commands even when idle. Each queue uses ~12 commands/second in background polling.

Key variables:

- `WORKER_QUEUES` – comma-separated list of queue names to start workers for. Default (empty) starts all 6 queues. Set to only what you need, e.g. `default-io`.
- `SCALE_SIGNALS_ENABLED` – set `false` to disable autoscaling signal collection (saves ~1.5 cmd/sec per queue).
- `SCALE_SIGNAL_INTERVAL_MS` – interval for signal collection when enabled (default: 300000ms = 5 min).

Command rate reference:

| Config | Rate | Daily |
|---|---|---|
| 6 queues, signals on (30s) | ~70 cmd/s | ~6M |
| 1 queue, signals on (5 min) | ~13 cmd/s | ~1.1M |
| 1 queue, signals off | ~12 cmd/s | ~1M |

For Upstash Free Tier (500K commands/month), always set `WORKER_QUEUES=default-io` and `SCALE_SIGNALS_ENABLED=false`.

## Incident Response

Producer unavailable:
1. Check process and port binding.
2. Verify Redis/Postgres connectivity.
3. Restart producer.

Worker backlog growth:
1. Check worker logs and stalled events.
2. Verify Redis health.
3. Scale worker replicas.

DB contention:
1. Inspect idempotency claim latency warnings.
2. Reduce concurrency temporarily.
3. Investigate long-running DB queries.

## Throughput & Capacity

Single enqueue (`POST /jobs`) is the core operation — the primary API for all integrations.

### Single Enqueue — Core Path

Each `POST /jobs` does exactly **1 Redis call + 1 DB call** (~7ms total):

| Step | Type | Calls |
|---|---|---|
| Zod validation | CPU | 0 I/O |
| Rate limit check | In-memory | 0 I/O |
| Queue depth check | Redis | 0 (cached 2s) |
| `queue.add()` | Redis | 1 |
| Status upsert (CTE) | DB | 1 |

**Single enqueue throughput:**

| DB_POOL_MAX | Max enqueue/sec |
|---|---|
| 5 | ~1,000/sec |
| 15 | ~3,000/sec |
| 20 | ~4,000/sec |

### Worker Processing (per job)

4 DB calls per job: idempotency claim → status active → mark completed → status completed.

| DB_POOL_MAX | Max jobs/sec |
|---|---|
| 5 | ~250/sec |
| 15 | ~750/sec |
| 20 | ~1,000/sec |

### Bulk Enqueue — Batch Import

For batch imports, `POST /jobs/bulk` batches 100 jobs per Redis+DB round-trip (10 calls for 1,000 jobs instead of 2,000).

### Bottleneck Order

1. **DB_POOL_MAX** — primary limiter for all DB-bound operations.
2. **Database connection pool** — Supabase free tier supports ~20-60 concurrent connections.
3. **Redis command budget** — Upstash free tier: 500K commands/month.
4. **Network latency** — ~2-10ms per call to DB/Redis.
5. **Single Node.js process** — CPU-bound at ~10K-15K concurrent async operations.

### Tuning Recommendations

- Set `DB_POOL_MAX=15` or higher if your DB provider supports it.
- Use `POST /jobs/bulk` over individual enqueue for imports (100x fewer DB calls).
- Monitor idempotency claim latency via `DB_IDEMPOTENCY_CLAIM_WARN_MS`.
- For sustained high throughput (>1K jobs/sec), use a paid DB/Redis tier.
