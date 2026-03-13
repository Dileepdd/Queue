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

  // Single round-trip: upsert current status + append event log in one CTE.
  await pool.query(
    `
      WITH upserted AS (
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
        RETURNING 1
      )
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
      record.updatedAt,
    ],
  );
}

export async function upsertJobStatusBatch(records: StatusRecord[]): Promise<void> {
  if (records.length === 0) return;
  if (records.length === 1) return upsertJobStatus(records[0]!);

  const pool = getDbPool();

  // Build a single multi-row INSERT for both tables in one round-trip.
  const params: unknown[] = [];
  const currentRows: string[] = [];
  const eventRows: string[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const metadataJson = JSON.stringify(r.metadata);
    const base = i * 8;
    params.push(r.queue, r.jobId, r.metadata.tenantId, r.jobName, r.status, metadataJson, r.errorSummary ?? null, r.updatedAt);
    currentRows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}, $${base + 8}::timestamptz)`);
    eventRows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7})`);
  }

  const incomingRankExpr =
    "CASE EXCLUDED.status WHEN 'queued' THEN 1 WHEN 'active' THEN 2 WHEN 'failed' THEN 3 WHEN 'completed' THEN 4 WHEN 'duplicate' THEN 5 WHEN 'dead-lettered' THEN 6 ELSE 0 END";
  const currentRankExpr =
    "CASE job_status_current.status WHEN 'queued' THEN 1 WHEN 'active' THEN 2 WHEN 'failed' THEN 3 WHEN 'completed' THEN 4 WHEN 'duplicate' THEN 5 WHEN 'dead-lettered' THEN 6 ELSE 0 END";

  await pool.query(
    `
      WITH upserted AS (
        INSERT INTO job_status_current (queue, job_id, tenant_id, job_name, status, metadata_json, error_summary, updated_at)
        VALUES ${currentRows.join(', ')}
        ON CONFLICT (queue, job_id)
        DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          job_name = EXCLUDED.job_name,
          status = EXCLUDED.status,
          metadata_json = EXCLUDED.metadata_json,
          error_summary = EXCLUDED.error_summary,
          updated_at = EXCLUDED.updated_at
        WHERE ${incomingRankExpr} >= ${currentRankExpr}
        RETURNING 1
      )
      INSERT INTO job_status_events (queue, job_id, tenant_id, job_name, status, metadata_json, error_summary)
      VALUES ${eventRows.join(', ')}
    `,
    params,
  );
}

export interface JobStatusQuery {
  tenantId: string;
  status?: JobStatus;
  jobName?: JobName;
  updatedBefore?: string;
  limit: number;
}

export interface JobStatusListResult {
  items: StatusRecord[];
  nextCursor?: string;
}

export interface JobStatusEventRecord {
  id: number;
  queue: string;
  jobId: string;
  jobName: JobName;
  status: JobStatus;
  metadata: JobMetadata;
  errorSummary?: string;
  createdAt: string;
}

export interface JobTimelineSummary {
  totalEvents: number;
  totalAttempts: number;
  failedAttempts: number;
  completedAt?: string;
  deadLetteredAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface JobTimelineResult {
  jobId: string;
  summary: JobTimelineSummary;
  events: JobStatusEventRecord[];
}

export async function getJobStatusByJobId(tenantId: string, jobId: string): Promise<StatusRecord | undefined> {
  const result = await getDbPool().query<{
    queue: string;
    job_id: string;
    job_name: JobName;
    status: JobStatus;
    metadata_json: JobMetadata;
    error_summary: string | null;
    updated_at: Date;
  }>(
    `
      SELECT queue, job_id, job_name, status, metadata_json, error_summary, updated_at
      FROM job_status_current
      WHERE tenant_id = $1
        AND job_id = $2
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [tenantId, jobId],
  );

  const row = result.rows[0];
  if (!row) {
    return undefined;
  }

  return {
    queue: row.queue,
    jobId: row.job_id,
    jobName: row.job_name,
    status: row.status,
    metadata: row.metadata_json,
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listJobStatuses(query: JobStatusQuery): Promise<JobStatusListResult> {
  const params: Array<string | number> = [query.tenantId];
  const clauses: string[] = ['tenant_id = $1'];

  if (query.status) {
    params.push(query.status);
    clauses.push(`status = $${params.length}`);
  }

  if (query.jobName) {
    params.push(query.jobName);
    clauses.push(`job_name = $${params.length}`);
  }

  if (query.updatedBefore) {
    params.push(query.updatedBefore);
    clauses.push(`updated_at < $${params.length}::timestamptz`);
  }

  params.push(query.limit);

  const whereSql = clauses.join(' AND ');
  const result = await getDbPool().query<{
    queue: string;
    job_id: string;
    job_name: JobName;
    status: JobStatus;
    metadata_json: JobMetadata;
    error_summary: string | null;
    updated_at: Date;
  }>(
    `
      SELECT queue, job_id, job_name, status, metadata_json, error_summary, updated_at
      FROM job_status_current
      WHERE ${whereSql}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `,
    params,
  );

  const items: StatusRecord[] = result.rows.map((row) => ({
    queue: row.queue,
    jobId: row.job_id,
    jobName: row.job_name,
    status: row.status,
    metadata: row.metadata_json,
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    updatedAt: row.updated_at.toISOString(),
  }));

  const nextCursor = items.length === query.limit ? items[items.length - 1]?.updatedAt : undefined;
  return {
    items,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export async function getJobTimelineByJobId(tenantId: string, jobId: string): Promise<JobTimelineResult | undefined> {
  const result = await getDbPool().query<{
    id: string;
    queue: string;
    job_id: string;
    job_name: JobName;
    status: JobStatus;
    metadata_json: JobMetadata;
    error_summary: string | null;
    created_at: Date;
  }>(
    `
      SELECT id, queue, job_id, job_name, status, metadata_json, error_summary, created_at
      FROM job_status_events
      WHERE tenant_id = $1
        AND job_id = $2
      ORDER BY created_at ASC, id ASC
    `,
    [tenantId, jobId],
  );

  if (result.rows.length === 0) {
    return undefined;
  }

  const events: JobStatusEventRecord[] = result.rows.map((row) => ({
    id: Number(row.id),
    queue: row.queue,
    jobId: row.job_id,
    jobName: row.job_name,
    status: row.status,
    metadata: row.metadata_json,
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
    createdAt: row.created_at.toISOString(),
  }));

  const totalAttempts = events.filter((event) => event.status === 'active').length;
  const failedAttempts = events.filter((event) => event.status === 'failed').length;
  const completedAt = events.find((event) => event.status === 'completed')?.createdAt;
  const deadLetteredAt = events.find((event) => event.status === 'dead-lettered')?.createdAt;
  const firstSeenAt = events[0]?.createdAt;
  const lastSeenAt = events[events.length - 1]?.createdAt;

  return {
    jobId,
    summary: {
      totalEvents: events.length,
      totalAttempts,
      failedAttempts,
      ...(completedAt ? { completedAt } : {}),
      ...(deadLetteredAt ? { deadLetteredAt } : {}),
      ...(firstSeenAt ? { firstSeenAt } : {}),
      ...(lastSeenAt ? { lastSeenAt } : {}),
    },
    events,
  };
}
