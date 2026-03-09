import { appConfig } from '../config/env.js';
import { getDbPool } from '../infra/db.js';
import { logger } from '../shared/logger.js';

export interface RetentionController {
  stop: () => void;
}

async function runRetentionSweep(): Promise<void> {
  const pool = getDbPool();

  const idem = await pool.query(
    `
      DELETE FROM idempotency_records
      WHERE updated_at < NOW() - ($1 || ' days')::interval
        AND status IN ('completed', 'failed')
    `,
    [appConfig.retentionIdempotencyDays],
  );

  const statusEvents = await pool.query(
    `
      DELETE FROM job_status_events
      WHERE created_at < NOW() - ($1 || ' days')::interval
    `,
    [appConfig.retentionStatusEventDays],
  );

  const deadLetters = await pool.query(
    `
      DELETE FROM dead_letter_records
      WHERE created_at < NOW() - ($1 || ' days')::interval
        AND reprocessed = TRUE
    `,
    [appConfig.retentionDeadLetterDays],
  );

  logger.info(
    {
      retention: {
        idempotencyDeleted: idem.rowCount ?? 0,
        statusEventsDeleted: statusEvents.rowCount ?? 0,
        deadLettersDeleted: deadLetters.rowCount ?? 0,
      },
    },
    'retention sweep complete',
  );
}

export function startRetentionJob(): RetentionController {
  if (!appConfig.retentionEnabled) {
    logger.info('retention job disabled by config');
    return { stop: () => undefined };
  }

  const timer = setInterval(() => {
    void runRetentionSweep().catch((error) => {
      logger.error({ error }, 'retention sweep failed');
    });
  }, appConfig.retentionIntervalMs);

  timer.unref();

  void runRetentionSweep().catch((error) => {
    logger.error({ error }, 'initial retention sweep failed');
  });

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
