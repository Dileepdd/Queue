import { getDbPool } from '../infra/db.js';
import { appConfig } from '../config/env.js';
import { logger } from '../shared/logger.js';

export type ClaimState =
  | { state: 'claimed' }
  | { state: 'duplicate-completed'; result: unknown }
  | { state: 'busy'; retryAtMs?: number };

const LOCK_SECONDS = 5 * 60;

export async function claimIdempotency(tenantId: string, idempotencyKey: string): Promise<ClaimState> {
  const startedAt = Date.now();
  const pool = getDbPool();

  // Single atomic query: attempt INSERT, or return existing row's state.
  // Avoids the 3-round-trip INSERT → SELECT → UPDATE pattern.
  const result = await pool.query(
    `
      WITH attempt AS (
        INSERT INTO idempotency_records (tenant_id, idempotency_key, status, locked_until)
        VALUES ($1, $2, 'processing', NOW() + ($3 || ' seconds')::interval)
        ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
          SET status = 'processing',
              locked_until = NOW() + ($3 || ' seconds')::interval,
              updated_at = NOW()
          WHERE idempotency_records.status = 'failed'
            OR idempotency_records.locked_until IS NULL
            OR idempotency_records.locked_until <= NOW()
        RETURNING 'claimed' AS claim_state, NULL::jsonb AS result_json, NULL::timestamptz AS locked_until
      )
      SELECT claim_state, result_json, locked_until FROM attempt
      UNION ALL
      SELECT
        CASE WHEN status = 'completed' THEN 'duplicate-completed' ELSE 'busy' END AS claim_state,
        result_json,
        locked_until
      FROM idempotency_records
      WHERE tenant_id = $1 AND idempotency_key = $2
        AND NOT EXISTS (SELECT 1 FROM attempt)
      LIMIT 1
    `,
    [tenantId, idempotencyKey, LOCK_SECONDS],
  );

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= appConfig.dbIdempotencyClaimWarnMs) {
    logger.warn({ tenantId, elapsedMs }, 'idempotency claim latency threshold exceeded');
  }

  const row = result.rows[0] as { claim_state: string; result_json: unknown; locked_until: string | null } | undefined;
  if (!row || row.claim_state === 'claimed') {
    return { state: 'claimed' };
  }

  if (row.claim_state === 'duplicate-completed') {
    return { state: 'duplicate-completed', result: row.result_json };
  }

  const retryAtMs = row.locked_until ? Date.parse(row.locked_until) : undefined;
  const hasRetryAt = retryAtMs !== undefined && Number.isFinite(retryAtMs);
  return {
    state: 'busy',
    ...(hasRetryAt ? { retryAtMs } : {}),
  };
}

export async function markIdempotencyCompleted(tenantId: string, idempotencyKey: string, result: unknown): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `
      UPDATE idempotency_records
      SET status = 'completed',
          result_json = $3::jsonb,
          error_code = NULL,
          error_message = NULL,
          locked_until = NULL,
          updated_at = NOW()
      WHERE tenant_id = $1 AND idempotency_key = $2
    `,
    [tenantId, idempotencyKey, JSON.stringify(result ?? null)],
  );
}

export async function markIdempotencyFailed(
  tenantId: string,
  idempotencyKey: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `
      UPDATE idempotency_records
      SET status = 'failed',
          error_code = $3,
          error_message = $4,
          locked_until = NULL,
          updated_at = NOW()
      WHERE tenant_id = $1 AND idempotency_key = $2
    `,
    [tenantId, idempotencyKey, errorCode, errorMessage],
  );
}
