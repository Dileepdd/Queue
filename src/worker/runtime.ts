import type { Processor } from 'bullmq';
import { appConfig } from '../config/env.js';
import { getBaseQueueName } from '../jobs/queues.js';
import { evaluateRedisConnectionBudget, startRetentionJob, startWorkerSignals } from '../scale/index.js';
import { logger } from '../shared/logger.js';
import { createWorkerRuntime } from './factory.js';

const DEFAULT_QUEUE_NAME = 'default-io';
const DEFAULT_PRIORITIES = ['high', 'default', 'low'] as const;
const DEFAULT_WORKLOADS = ['io-bound', 'cpu-heavy'] as const;

const noopProcessor: Processor = async (job) => {
  logger.warn({ queue: job.queueName, jobId: job.id, jobName: job.name }, 'no processor registered, using noop');
  return { ok: true };
};

export async function startWorkerRuntime(queueName = DEFAULT_QUEUE_NAME, processor: Processor = noopProcessor) {
  await startWorkerRuntimes([queueName], processor);
}

export function getDefaultWorkerQueues(): string[] {
  if (appConfig.workerQueues.length > 0) {
    return appConfig.workerQueues;
  }

  return DEFAULT_PRIORITIES.flatMap((priority) =>
    DEFAULT_WORKLOADS.map((workload) => getBaseQueueName(priority, workload)),
  );
}

export async function startWorkerRuntimes(queueNames: string[], processor: Processor = noopProcessor) {
  const uniqueQueueNames = Array.from(new Set(queueNames));

  for (const queueName of uniqueQueueNames) {
    createWorkerRuntime({
      queueName,
      processor,
      mode: 'parallel',
    });
  }

  evaluateRedisConnectionBudget('worker', uniqueQueueNames.length * 2);

  const signals = appConfig.scaleSignalsEnabled
    ? uniqueQueueNames.map((queueName) => startWorkerSignals(queueName))
    : [];
  const retention = startRetentionJob();

  const stopBackground = async () => {
    await Promise.all(signals.map(async (signal) => signal.stop()));
    retention.stop();
  };

  process.once('SIGINT', () => {
    void stopBackground();
  });

  process.once('SIGTERM', () => {
    void stopBackground();
  });

  logger.info({ queues: uniqueQueueNames, scaleSignalIntervalMs: appConfig.scaleSignalIntervalMs }, 'workers started');
}
