import type { Processor } from 'bullmq';
import { createWorkerRuntime } from '../../src/worker/factory.js';
import { logger } from '../../src/shared/logger.js';

const queueName = process.env.VALIDATION_QUEUE_NAME ?? 'default-io';
const processMs = Number(process.env.VALIDATION_PROCESS_MS ?? '45000');

const slowProcessor: Processor = async (job) => {
  logger.info({ queue: job.queueName, jobId: job.id, processMs }, 'validation slow processor started');
  await new Promise((resolve) => setTimeout(resolve, processMs));
  logger.info({ queue: job.queueName, jobId: job.id, processMs }, 'validation slow processor completed');
  return { ok: true, processMs };
};

createWorkerRuntime({
  queueName,
  processor: slowProcessor,
  mode: 'parallel',
});

logger.info({ queueName, processMs }, 'validation crash worker started');
