import type { QueueEvents, Worker } from 'bullmq';
import { logger } from '../shared/logger.js';

export function registerWorkerShutdown(worker: Worker, queueEvents: QueueEvents) {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info({ signal }, 'worker shutdown started');

    try {
      await worker.pause(true);
      await worker.close();
      await queueEvents.close();
      logger.info({ signal }, 'worker shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ signal, error }, 'worker shutdown failed');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}
