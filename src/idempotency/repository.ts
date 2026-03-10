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

  const inserted = await pool.query(
    `
      INSERT INTO idempotency_records (tenant_id, idempotency_key, status, locked_until)
      VALUES ($1, $2, 'processing', NOW() + ($3 || ' seconds')::interval)
      ON CONFLICT DO NOTHING
    `,
    [tenantId, idempotencyKey, LOCK_SECONDS],
  );

  if (inserted.rowCount === 1) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= appConfig.dbIdempotencyClaimWarnMs) {
      logger.warn({ tenantId, elapsedMs }, 'idempotency claim latency threshold exceeded');
    }
    return { state: 'claimed' };
  }

  const existing = await pool.query(
    `
      SELECT status, result_json, locked_until
      FROM idempotency_records
      WHERE tenant_id = $1 AND idempotency_key = $2
    `,
    [tenantId, idempotencyKey],
  );

  const row = existing.rows[0] as { status: string; result_json: unknown; locked_until: string | null } | undefined;
  if (!row) {
    return { state: 'busy' };
  }

  if (row.status === 'completed') {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= appConfig.dbIdempotencyClaimWarnMs) {
      logger.warn({ tenantId, elapsedMs }, 'idempotency duplicate lookup latency threshold exceeded');
    }
    return { state: 'duplicate-completed', result: row.result_json };
  }

  const claimedAgain = await pool.query(
    `
      UPDATE idempotency_records
      SET status = 'processing',
          locked_until = NOW() + ($3 || ' seconds')::interval,
          updated_at = NOW()
      WHERE tenant_id = $1
        AND idempotency_key = $2
        AND (
          status = 'failed'
          OR locked_until IS NULL
          OR locked_until <= NOW()
        )
    `,
    [tenantId, idempotencyKey, LOCK_SECONDS],
  );

  if (claimedAgain.rowCount === 1) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= appConfig.dbIdempotencyClaimWarnMs) {
      logger.warn({ tenantId, elapsedMs }, 'idempotency reclaim latency threshold exceeded');
    }
    return { state: 'claimed' };
  }

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= appConfig.dbIdempotencyClaimWarnMs) {
    logger.warn({ tenantId, elapsedMs }, 'idempotency busy-path latency threshold exceeded');
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
