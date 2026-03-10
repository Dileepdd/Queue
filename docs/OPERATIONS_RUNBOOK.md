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
