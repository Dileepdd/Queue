-- Idempotency records
CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  result_json JSONB,
  error_code TEXT,
  error_message TEXT,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_tenant_created
  ON idempotency_records (tenant_id, created_at DESC);

-- Current status table
CREATE TABLE IF NOT EXISTS job_status_current (
  queue TEXT NOT NULL,
  job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json JSONB NOT NULL,
  error_summary TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (queue, job_id)
);

CREATE INDEX IF NOT EXISTS idx_job_status_current_tenant_status_updated
  ON job_status_current (tenant_id, status, updated_at DESC);

-- Status event log
CREATE TABLE IF NOT EXISTS job_status_events (
  id BIGSERIAL PRIMARY KEY,
  queue TEXT NOT NULL,
  job_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json JSONB NOT NULL,
  error_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_status_events_job_created
  ON job_status_events (job_id, created_at);

CREATE INDEX IF NOT EXISTS idx_job_status_events_status_created
  ON job_status_events (status, created_at);

-- Dead letter table
CREATE TABLE IF NOT EXISTS dead_letter_records (
  id BIGSERIAL PRIMARY KEY,
  queue TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  metadata_json JSONB NOT NULL,
  schema_version INT NOT NULL,
  attempts_made INT NOT NULL,
  max_attempts INT NOT NULL,
  reason TEXT NOT NULL,
  stack TEXT,
  reprocessed BOOLEAN NOT NULL DEFAULT FALSE,
  reprocessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_created
  ON dead_letter_records (queue, created_at DESC);
