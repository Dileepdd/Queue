import { getDbPool } from '../infra/db.js';
import type { AnyJobEnvelope, JobName } from '../jobs/types.js';

export interface DeadLetterInput {
  queue: string;
  jobId: string;
  jobName: JobName;
  tenantId: string;
  idempotencyKey: string;
  payload: unknown;
  metadata: AnyJobEnvelope['metadata'];
  schemaVersion: number;
  attemptsMade: number;
  maxAttempts: number;
  reason: string;
  stack?: string;
}

export interface DeadLetterRecord {
  id: number;
  queue: string;
  jobName: JobName;
  payloadJson: unknown;
  metadataJson: AnyJobEnvelope['metadata'];
}

export async function insertDeadLetter(input: DeadLetterInput): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `
      INSERT INTO dead_letter_records (
        queue, job_id, job_name, tenant_id, idempotency_key, payload_json, metadata_json,
        schema_version, attempts_made, max_attempts, reason, stack
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)
    `,
    [
      input.queue,
      input.jobId,
      input.jobName,
      input.tenantId,
      input.idempotencyKey,
      JSON.stringify(input.payload ?? null),
      JSON.stringify(input.metadata),
      input.schemaVersion,
      input.attemptsMade,
      input.maxAttempts,
      input.reason,
      input.stack ?? null,
    ],
  );
}

export async function getDeadLetterById(id: number): Promise<DeadLetterRecord | null> {
  const pool = getDbPool();
  const result = await pool.query(
    `
      SELECT id, queue, job_name, payload_json, metadata_json
      FROM dead_letter_records
      WHERE id = $1
    `,
    [id],
  );

  if (result.rowCount !== 1) {
    return null;
  }

  const row = result.rows[0] as {
    id: number;
    queue: string;
    job_name: JobName;
    payload_json: unknown;
    metadata_json: AnyJobEnvelope['metadata'];
  };

  return {
    id: row.id,
    queue: row.queue,
    jobName: row.job_name,
    payloadJson: row.payload_json,
    metadataJson: row.metadata_json,
  };
}

export async function markDeadLetterReprocessed(id: number): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `
      UPDATE dead_letter_records
      SET reprocessed = TRUE,
          reprocessed_at = NOW()
      WHERE id = $1
    `,
    [id],
  );
}
