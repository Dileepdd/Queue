# Queue System TODO

Track implementation progress here. Mark items as done as we complete them.

## 0) Pre-build setup
- [x] Finalize SLOs, throughput target, and burst assumptions
- [x] Confirm infra choices (Redis HA, DB tier, deployment platform)
- [x] Define job contracts (`jobName`, payload schema, `schemaVersion`)
- [x] Define idempotency key format and duplicate-handling contract
- [x] Define status state machine and retry/error taxonomy
- [x] Finalize DB schema + indexes for idempotency and status tracking
- [x] Configure observability baseline (logs, metrics, dashboards, alerts)
- [x] Prepare CI/CD, secrets, config validation, and security baseline

## 1) Foundation
- [x] Scaffold TypeScript project structure from roadmap
- [x] Add environment config module with strict validation
- [x] Add shared logger and error utilities
- [x] Add Redis/BullMQ shared configuration module

## 2) Queue model and contracts
- [x] Implement queue isolation model (priority + workload)
- [x] Implement queue partitioning strategy (`queue:shard-N`)
- [x] Implement typed job payload/result contracts
- [x] Add runtime payload validation

## 3) Producer service
- [x] Create Express producer API
- [x] Add enqueue endpoint (immediate + delayed)
- [x] Add queue routing logic
- [x] Add backpressure/admission controls (`429`/`503`, retry-after)

## 4) Worker service
- [x] Implement reusable worker factory (queue, processor, concurrency)
- [x] Add sequential and parallel processing modes
- [x] Add rate limiting and per-job timeout handling
- [x] Add graceful shutdown (`SIGINT`/`SIGTERM`)

## 5) Reliability core
- [x] Implement DB-backed idempotency claim/finalize flow
- [x] Implement status tracking tables and transition updates
- [x] Implement retry policy and retry storm safeguards
- [x] Implement DLQ persistence and reprocess flow

## 6) Scale hardening
- [x] Add worker autoscaling signals (queue age/depth/in-flight)
- [x] Add Redis connection budgeting and pooling policy
- [x] Add DB contention monitoring for idempotency claims
- [x] Add retention/archive jobs for old idempotency/status records

## 7) Validation and rollout
- [ ] Run crash recovery tests
- [ ] Run Redis restart/failover tests
- [x] Run duplicate delivery/idempotency tests
- [ ] Run network partition tests
- [x] Run load test at target peak + safety margin
- [x] Finalize operational runbooks (deploy, rollback, DLQ, scaling)

---

## Notes
- Source roadmap: `ROADMAP.md`
- Pre-build decisions: `PREBUILD_DECISIONS.md`
- Validation guide: `docs/SECTION7_VALIDATION.md`
- Operations runbook: `docs/OPERATIONS_RUNBOOK.md`
- Use this file as the execution checklist and update continuously.
