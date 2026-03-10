import { DelayedError, QueueEvents, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { appConfig } from '../config/env.js';
import { createWorkerOptions } from '../config/queue.js';
import { createRedisConnectionOptions } from '../config/redis.js';
import { insertDeadLetter } from '../dead-letter/repository.js';
import {
  claimIdempotency,
  markIdempotencyCompleted,
  markIdempotencyFailed,
} from '../idempotency/repository.js';
import { validateJobEnvelope } from '../jobs/schemas.js';
import { registerWorkerShutdown } from '../shutdown/register-worker-shutdown.js';
import { AppError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { upsertJobStatus } from '../status/index.js';
import type { JobName } from '../jobs/types.js';
import type { JobProcessor, QueueJob, WorkerFactoryOptions, WorkerMode } from './types.js';
import { recordFailureAndCheckStorm } from './retry-safeguard.js';

const SEQUENTIAL_LOCK_TTL_MS = 5 * 60 * 1000;

function resolveConcurrency(mode: WorkerMode, requested?: number): number {
  if (mode === 'sequential') {
    return 1;
  }
  return requested ?? appConfig.queueConcurrency;
}

function resolveTimeoutMs(jobName: JobName, timeoutByJobName?: Partial<Record<JobName, number>>): number {
  return timeoutByJobName?.[jobName] ?? appConfig.jobTimeoutDefaultMs;
}

async function runWithTimeout(job: QueueJob, processor: JobProcessor, timeoutMs: number): Promise<unknown> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutError = new AppError(`Job execution timed out after ${timeoutMs}ms`, {
    code: 'JOB_TIMEOUT',
    statusCode: 500,
    retryable: true,
  });

  try {
    return await Promise.race([
      processor(job),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error === timeoutError) {
      // The processor promise can continue running in the background after Promise.race timeout.
      // Discard retries to reduce duplicate side effects until idempotency flow (Section 5) is active.
      await job.discard();
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function createWorkerRuntime(options: WorkerFactoryOptions): Worker {
  const mode = options.mode ?? 'parallel';
  const concurrency = resolveConcurrency(mode, options.concurrency);

  const workerOptions = createWorkerOptions(concurrency);
  if (options.rateLimiter) {
    workerOptions.limiter = options.rateLimiter;
  }

  const sequentialLockRedis = new Redis(appConfig.redisUrl, {
    username: appConfig.redisUsername,
    password: appConfig.redisPassword,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    connectTimeout: 10000,
    tls: appConfig.redisTls ? {} : undefined,
    connectionName: `${appConfig.serviceName}:worker-sequential-lock`,
  });

  const wrappedProcessor: JobProcessor = async (job, token) => {
    const envelope = validateJobEnvelope(job.data);
    let sequentialLockKey: string | undefined;
    let sequentialLockToken: string | undefined;

    // parallel: current behavior using queue worker concurrency
    // sequential: acquire distributed lock per partition to force one-by-one processing
    if (envelope.executionMode === 'sequential') {
      const partitionKey = envelope.metadata.partitionKey ?? envelope.metadata.tenantId;
      sequentialLockKey = `seq-lock:${options.queueName}:${partitionKey}`;
      sequentialLockToken = randomUUID();

      const lockResult = await sequentialLockRedis.set(
        sequentialLockKey,
        sequentialLockToken,
        'PX',
        SEQUENTIAL_LOCK_TTL_MS,
        'NX',
      );

      if (lockResult !== 'OK') {
        const retryAt = Date.now() + Math.max(250, appConfig.queueBackoffMs);
        await job.moveToDelayed(retryAt, token ?? job.token);
        throw new DelayedError();
      }
    }

    try {
    const claim = await claimIdempotency(envelope.metadata.tenantId, envelope.metadata.idempotencyKey);

    if (claim.state === 'duplicate-completed') {
      await upsertJobStatus({
        jobId: job.id ?? 'unknown',
        queue: options.queueName,
        jobName: envelope.name,
        status: 'duplicate',
        metadata: envelope.metadata,
        updatedAt: new Date().toISOString(),
      });
      return claim.result;
    }

    if (claim.state === 'busy') {
      // Keep the same job pending while the idempotency lock is active, without burning attempts.
      const minRetryAt = Date.now() + appConfig.queueBackoffMs;
      const retryAt = claim.retryAtMs ? Math.max(claim.retryAtMs + 200, minRetryAt) : minRetryAt;
      await job.moveToDelayed(retryAt, token ?? job.token);
      throw new DelayedError();
    }

    await upsertJobStatus({
      jobId: job.id ?? 'unknown',
      queue: options.queueName,
      jobName: envelope.name,
      status: 'active',
      metadata: envelope.metadata,
      updatedAt: new Date().toISOString(),
    });

    const timeoutMs = resolveTimeoutMs(job.name as JobName, options.timeoutByJobName);
    try {
      const result = await runWithTimeout(job, options.processor, timeoutMs);
      await markIdempotencyCompleted(envelope.metadata.tenantId, envelope.metadata.idempotencyKey, result);
      await upsertJobStatus({
        jobId: job.id ?? 'unknown',
        queue: options.queueName,
        jobName: envelope.name,
        status: 'completed',
        metadata: envelope.metadata,
        updatedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      const asError = error instanceof Error ? error : new Error('Unknown worker processing error');
      await markIdempotencyFailed(
        envelope.metadata.tenantId,
        envelope.metadata.idempotencyKey,
        (error as AppError).code ?? 'WORKER_PROCESSING_ERROR',
        asError.message,
      );
      await upsertJobStatus({
        jobId: job.id ?? 'unknown',
        queue: options.queueName,
        jobName: envelope.name,
        status: 'failed',
        metadata: envelope.metadata,
        updatedAt: new Date().toISOString(),
        errorSummary: asError.message,
      });
      throw error;
    }
    } finally {
      if (sequentialLockKey && sequentialLockToken) {
        const current = await sequentialLockRedis.get(sequentialLockKey);
        if (current === sequentialLockToken) {
          await sequentialLockRedis.del(sequentialLockKey);
        }
      }
    }
  };

  const worker = new Worker(options.queueName, wrappedProcessor, workerOptions);
  const queueEvents = new QueueEvents(options.queueName, {
    connection: createRedisConnectionOptions('queue-events'),
  });

  worker.on('active', (job) => {
    logger.info({ queue: options.queueName, mode, concurrency, jobId: job?.id, jobName: job?.name }, 'job started');
  });

  worker.on('completed', (job) => {
    logger.info({ queue: options.queueName, jobId: job?.id, jobName: job?.name }, 'job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ queue: options.queueName, jobId: job?.id, jobName: job?.name, error: error.message }, 'job failed');

    recordFailureAndCheckStorm(options.queueName);

    if (!job) {
      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    const attemptsMade = job.attemptsMade ?? 0;
    if (attemptsMade >= maxAttempts) {
      const payload = job.data && typeof job.data === 'object' ? (job.data as Record<string, unknown>).payload : null;
      const metadata =
        job.data && typeof job.data === 'object' ? (job.data as Record<string, unknown>).metadata : undefined;

      if (metadata && typeof metadata === 'object') {
        const metadataObj = metadata as {
          tenantId?: string;
          idempotencyKey?: string;
          schemaVersion?: number;
        };

        void insertDeadLetter({
          queue: options.queueName,
          jobId: job.id ?? 'unknown',
          jobName: (job.name as JobName) ?? 'webhook.dispatch',
          tenantId: metadataObj.tenantId ?? 'unknown-tenant',
          idempotencyKey: metadataObj.idempotencyKey ?? 'unknown-key',
          payload,
          metadata: metadata as never,
          schemaVersion: metadataObj.schemaVersion ?? 1,
          attemptsMade,
          maxAttempts,
          reason: error.message,
          ...(error.stack ? { stack: error.stack } : {}),
        });

        void upsertJobStatus({
          jobId: job.id ?? 'unknown',
          queue: options.queueName,
          jobName: job.name as JobName,
          status: 'dead-lettered',
          metadata: metadata as never,
          updatedAt: new Date().toISOString(),
          errorSummary: error.message,
        });
      }
    }
  });

  queueEvents.on('stalled', ({ jobId }) => {
    logger.warn({ queue: options.queueName, jobId }, 'job stalled');
  });

  registerWorkerShutdown(worker, queueEvents);

  worker.on('closed', () => {
    void sequentialLockRedis.quit();
  });

  logger.info({ queue: options.queueName, mode, concurrency }, 'worker runtime created');

  return worker;
}
