import { JobsOptions, QueueOptions, WorkerOptions } from 'bullmq';
import { appConfig } from './env.js';
import { createRedisConnectionOptions } from './redis.js';

export const defaultJobOptions: JobsOptions = {
  attempts: appConfig.queueAttempts,
  backoff: {
    type: 'exponential',
    delay: appConfig.queueBackoffMs,
  },
  removeOnComplete: {
    age: 24 * 60 * 60,
    count: 10000,
  },
  removeOnFail: {
    age: 7 * 24 * 60 * 60,
    count: 50000,
  },
};

export const baseQueueOptions: QueueOptions = {
  connection: createRedisConnectionOptions('queue'),
  defaultJobOptions,
};

export function createWorkerOptions(concurrency = appConfig.queueConcurrency): WorkerOptions {
  return {
    connection: createRedisConnectionOptions('worker'),
    concurrency,
    lockDuration: appConfig.queueLockDurationMs,
    stalledInterval: appConfig.queueStalledIntervalMs,
    maxStalledCount: appConfig.queueMaxStalledCount,
    limiter: {
      max: appConfig.queueRateLimitMax,
      duration: appConfig.queueRateLimitDurationMs,
    },
  };
}
