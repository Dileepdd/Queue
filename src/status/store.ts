import type { JobMetadata, JobName } from '../jobs/types.js';
import { getDbPool } from '../infra/db.js';

export type JobStatus = 'queued' | 'active' | 'completed' | 'failed' | 'dead-lettered' | 'duplicate';

export interface StatusRecord {
  jobId: string;
  queue: string;
  jobName: JobName;
  status: JobStatus;
  metadata: JobMetadata;
  updatedAt: string;
  errorSummary?: string;
}

export async function upsertJobStatus(record: StatusRecord): Promise<void> {
  const pool = getDbPool();
  const metadataJson = JSON.stringify(record.metadata);

  // Monotonic status precedence to avoid regressing current state on duplicate enqueue events.
  // queued < active < failed < completed < duplicate < dead-lettered
  const incomingRankExpr =
    "CASE EXCLUDED.status WHEN 'queued' THEN 1 WHEN 'active' THEN 2 WHEN 'failed' THEN 3 WHEN 'completed' THEN 4 WHEN 'duplicate' THEN 5 WHEN 'dead-lettered' THEN 6 ELSE 0 END";
  const currentRankExpr =
    "CASE job_status_current.status WHEN 'queued' THEN 1 WHEN 'active' THEN 2 WHEN 'failed' THEN 3 WHEN 'completed' THEN 4 WHEN 'duplicate' THEN 5 WHEN 'dead-lettered' THEN 6 ELSE 0 END";

  await pool.query(
    `
      INSERT INTO job_status_current (queue, job_id, tenant_id, job_name, status, metadata_json, error_summary, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz)
      ON CONFLICT (queue, job_id)
      DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        job_name = EXCLUDED.job_name,
        status = EXCLUDED.status,
        metadata_json = EXCLUDED.metadata_json,
        error_summary = EXCLUDED.error_summary,
        updated_at = EXCLUDED.updated_at
      WHERE ${incomingRankExpr} >= ${currentRankExpr}
    `,
    [
      record.queue,
      record.jobId,
      record.metadata.tenantId,
      record.jobName,
      record.status,
      metadataJson,
      record.errorSummary ?? null,
      record.updatedAt,
    ],
  );

  await pool.query(
    `
      INSERT INTO job_status_events (queue, job_id, tenant_id, job_name, status, metadata_json, error_summary)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `,
    [
      record.queue,
      record.jobId,
      record.metadata.tenantId,
      record.jobName,
      record.status,
      metadataJson,
      record.errorSummary ?? null,
    ],
  );
}
