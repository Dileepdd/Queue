import { Queue } from 'bullmq';
import { appConfig } from '../config/env.js';
import { createRedisConnectionOptions } from '../config/redis.js';
import { logger } from '../shared/logger.js';

export interface WorkerSignalController {
  stop: () => Promise<void>;
}

async function collectQueueSignals(queue: Queue) {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
  const oldestWaiting = await queue.getJobs(['waiting'], 0, 0, true);
  const oldestEnqueuedAt = oldestWaiting[0]?.timestamp;
  const now = Date.now();

  const queueAgeMs = oldestEnqueuedAt ? Math.max(0, now - oldestEnqueuedAt) : 0;

  logger.info(
    {
      queue: queue.name,
      signals: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        prioritized: counts.prioritized ?? 0,
        queueAgeMs,
        inFlight: counts.active ?? 0,
      },
    },
    'worker autoscaling signals',
  );
}

export function startWorkerSignals(queueName: string): WorkerSignalController {
  const queue = new Queue(queueName, {
    connection: createRedisConnectionOptions('scale-signals'),
  });

  const timer = setInterval(() => {
    void collectQueueSignals(queue).catch((error) => {
      logger.warn({ queue: queueName, error }, 'failed to collect worker autoscaling signals');
    });
  }, appConfig.scaleSignalIntervalMs);

  timer.unref();

  void collectQueueSignals(queue).catch((error) => {
    logger.warn({ queue: queueName, error }, 'failed to collect initial worker autoscaling signals');
  });

  return {
    stop: async () => {
      clearInterval(timer);
      await queue.close();
    },
  };
}
