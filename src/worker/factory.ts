import { QueueEvents, Worker } from 'bullmq';
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

  const wrappedProcessor: JobProcessor = async (job) => {
    const envelope = validateJobEnvelope(job.data);
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
      throw new AppError('Idempotency key is currently processing', {
        code: 'IDEMPOTENCY_BUSY',
        statusCode: 409,
        retryable: true,
      });
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
          jobName: (job.name as JobName) ?? 'email.send',
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

  logger.info({ queue: options.queueName, mode, concurrency }, 'worker runtime created');

  return worker;
}
