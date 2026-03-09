import { randomUUID } from 'node:crypto';
import type { JobsOptions } from 'bullmq';
import { appConfig } from '../config/env.js';
import { resolveQueueName, validateJobEnvelope } from '../jobs/index.js';
import type { AnyJobEnvelope, JobName } from '../jobs/index.js';
import { AppError } from '../shared/errors.js';
import { upsertJobStatus } from '../status/index.js';
import { getOrCreateQueue } from './queue-registry.js';
import { assertTenantRateLimit } from './rate-limit.js';

export interface EnqueueInput {
  job: unknown;
  delayMs?: number | undefined;
  shardCount?: number | undefined;
}

export interface EnqueueResult {
  queueName: string;
  jobId: string;
  delayed: boolean;
  delayMs: number;
}

function toBullSafeJobId(input: string): string {
  return input.replace(/:/g, '__');
}

function asObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('Job envelope must be an object', {
      code: 'INVALID_JOB_ENVELOPE',
      statusCode: 400,
    });
  }
  return input as Record<string, unknown>;
}

function buildGeneratedIdempotencyKey(jobObj: Record<string, unknown>): string {
  const name = typeof jobObj.name === 'string' ? jobObj.name : 'unknown-job';
  const metadata = asObject(jobObj.metadata ?? {});
  const tenantId = typeof metadata.tenantId === 'string' ? metadata.tenantId : 'unknown-tenant';
  const partitionKey = typeof metadata.partitionKey === 'string' ? metadata.partitionKey : 'global';
  return `${tenantId}:${name}:${partitionKey}:auto:${randomUUID()}`;
}

function normalizeJobEnvelope(input: unknown): AnyJobEnvelope {
  const jobObj = asObject(input);
  const metadata = asObject(jobObj.metadata ?? {});

  const idempotencyKey =
    typeof metadata.idempotencyKey === 'string' && metadata.idempotencyKey.length >= 8
      ? metadata.idempotencyKey
      : buildGeneratedIdempotencyKey(jobObj);

  const normalized = {
    ...jobObj,
    metadata: {
      ...metadata,
      idempotencyKey,
    },
  };

  return validateJobEnvelope(normalized);
}

function getPayloadSizeBytes(input: unknown): number {
  return Buffer.byteLength(JSON.stringify(input), 'utf8');
}

function ensureWithinLimits(job: AnyJobEnvelope, delayMs: number) {
  if (delayMs > appConfig.queueMaxDelayedHorizonMs) {
    throw new AppError('Delay exceeds configured max horizon', {
      code: 'DELAY_HORIZON_EXCEEDED',
      statusCode: 400,
    });
  }

  const payloadBytes = getPayloadSizeBytes(job.payload);
  if (payloadBytes > appConfig.queueMaxPayloadBytes) {
    throw new AppError('Payload exceeds configured max size', {
      code: 'PAYLOAD_TOO_LARGE',
      statusCode: 413,
    });
  }
}

async function assertQueueCapacity(queueName: string) {
  const queue = getOrCreateQueue(queueName);
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children');
  const depth =
    (counts.waiting ?? 0) +
    (counts.active ?? 0) +
    (counts.delayed ?? 0) +
    (counts.prioritized ?? 0) +
    (counts['waiting-children'] ?? 0);

  if (depth >= appConfig.queueMaxDepth) {
    throw new AppError('Queue is overloaded, retry later', {
      code: 'QUEUE_OVERLOADED',
      statusCode: 503,
      retryable: true,
    });
  }
}

export async function enqueueJob(input: EnqueueInput): Promise<EnqueueResult> {
  const normalizedJob = normalizeJobEnvelope(input.job);
  const delayMs = input.delayMs ?? 0;
  ensureWithinLimits(normalizedJob, delayMs);

  assertTenantRateLimit(normalizedJob.metadata.tenantId);

  const queueRouteInput = {
    priority: normalizedJob.metadata.priority,
    workload: normalizedJob.metadata.workload,
    ...(normalizedJob.metadata.partitionKey !== undefined ? { partitionKey: normalizedJob.metadata.partitionKey } : {}),
    ...(input.shardCount !== undefined ? { shardCount: input.shardCount } : {}),
  };

  const queueName = resolveQueueName(queueRouteInput);

  await assertQueueCapacity(queueName);

  const queue = getOrCreateQueue(queueName);
  const rawJobId = `${normalizedJob.metadata.tenantId}:${normalizedJob.metadata.idempotencyKey}`;
  const jobOptions: JobsOptions = {
    jobId: toBullSafeJobId(rawJobId),
    ...(delayMs > 0 ? { delay: delayMs } : {}),
  };

  const enqueued = await queue.add(normalizedJob.name, normalizedJob, jobOptions);
  const resolvedJobId = enqueued.id ?? jobOptions.jobId ?? 'unknown';

  await upsertJobStatus({
    jobId: resolvedJobId,
    queue: queueName,
    jobName: normalizedJob.name as JobName,
    status: 'queued',
    metadata: normalizedJob.metadata,
    updatedAt: new Date().toISOString(),
  });

  return {
    queueName,
    jobId: resolvedJobId,
    delayed: delayMs > 0,
    delayMs,
  };
}
