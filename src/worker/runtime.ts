import type { Processor } from 'bullmq';
import { appConfig } from '../config/env.js';
import { evaluateRedisConnectionBudget, startRetentionJob, startWorkerSignals } from '../scale/index.js';
import { logger } from '../shared/logger.js';
import { createWorkerRuntime } from './factory.js';

const DEFAULT_QUEUE_NAME = 'default-io';

const noopProcessor: Processor = async (job) => {
  logger.info({ queue: job.queueName, jobId: job.id, jobName: job.name }, 'processing job');
  return { ok: true };
};

export async function startWorkerRuntime(queueName = DEFAULT_QUEUE_NAME, processor: Processor = noopProcessor) {
  createWorkerRuntime({
    queueName,
    processor,
    mode: 'parallel',
  });

  evaluateRedisConnectionBudget('worker', 2);

  const signals = startWorkerSignals(queueName);
  const retention = startRetentionJob();

  const stopBackground = async () => {
    await signals.stop();
    retention.stop();
  };

  process.once('SIGINT', () => {
    void stopBackground();
  });

  process.once('SIGTERM', () => {
    void stopBackground();
  });

  logger.info({ queue: queueName, scaleSignalIntervalMs: appConfig.scaleSignalIntervalMs }, 'worker started');
}
