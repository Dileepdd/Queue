# Section 7 Validation Guide

Run these in order to complete validation and rollout readiness.

## Prerequisites

- Producer running on `http://localhost:3000`
- Worker running (`npm.cmd run dev:worker`)
- Postgres migrations applied in order:
	- `src/infra/migrations/001_reliability_core.sql`
	- `src/infra/migrations/002_client_hmac_auth.sql`
	- `src/infra/migrations/003_bearer_token_hash.sql`
- `.env` populated and reachable cloud Redis/Postgres
- Validation auth token set for scripts:
	- `VALIDATION_ACCESS_TOKEN=<client secretValue>`
	- Optional: `VALIDATION_BASE_URL=http://localhost:3000`

Quick way to generate a token (admin API):

```powershell
$adminToken = (Select-String -Path .env -Pattern '^ADMIN_API_TOKEN=').Line.Split('=',2)[1]
$created = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/admin/keys' -Headers @{ 'X-Admin-Token' = $adminToken } -ContentType 'application/json' -Body (@{ tenantId='tenant1'; clientName='Validation Runner' } | ConvertTo-Json)
$env:VALIDATION_ACCESS_TOKEN = $created.secretValue
```

## 1) Crash Recovery Test

1. Submit a job with `scripts/validation/send-job.ps1`.
2. While worker is processing, stop worker process (`Ctrl+C`).
3. Restart worker.
4. Verify status in DB moved forward and job completed/retried safely.

Expected:
- Job is recovered/retried.
- No duplicate side effects.

## 2) Redis Restart/Failover Test

1. Keep producer/worker running.
2. Trigger failover/restart from Redis provider console.
3. Submit jobs before and after event.

Expected:
- Temporary disruption.
- Recovery after reconnect.
- Queue resumes processing without manual repair.

## 3) Duplicate Delivery/Idempotency Test

1. Run `scripts/validation/duplicate-test.ps1`.
2. Check worker logs and DB state.

Expected:
- Both requests accepted.
- Side effect executed once.
- `idempotency_records` contains single key with terminal state.

## 4) Network Partition Test

1. Temporarily block outbound network to Redis host (or disconnect network).
2. Submit job during outage.
3. Restore network.

Expected:
- Retryable failures during outage.
- Recovery after network restore.

## 5) Load Test

Run:

```powershell
node scripts/load-test.mjs --requests 500 --concurrency 25
```

Expected:
- Stable acceptance/error profile.
- No sustained queue-age runaway.
- No unexpected DLQ growth for healthy job payloads.

## 6) Verification Queries

Run `scripts/validation/db-check.mjs`.

Expected:
- Latest jobs in `job_status_current` show forward progression.
- `idempotency_records` contains terminal states.
- `dead_letter_records` only includes genuine failures.

## Completion Criteria

Section 7 is complete when:
- All 5 test categories are executed.
- Outputs are recorded.
- Operational runbook is finalized.
